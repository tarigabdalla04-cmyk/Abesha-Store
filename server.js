const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const FAZER_API = "https://api.fzr.cards/api/v2";
const DEFAULT_USD_TO_SDG = 8250;

// ======================================================
// PostgreSQL — العملاء والجلسات والطلبات
// ======================================================

const dbPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

const scryptAsync = promisify(crypto.scrypt);
const SESSION_COOKIE = "abeshasid";
const SESSION_DAYS = 30;
const SESSION_TTL_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const authAttempts = new Map();

function normalizePhone(value) {
  return String(value || "").replace(/[^0-9]/g, "").slice(0, 20);
}

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_DAYS * 86400}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return { hash: Buffer.from(derived).toString("base64"), salt: salt.toString("base64") };
}

async function verifyPassword(password, hash, salt) {
  const derived = await scryptAsync(String(password), Buffer.from(salt, "base64"), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hash, "base64");
  return expected.length === derived.length && crypto.timingSafeEqual(expected, Buffer.from(derived));
}

function authRateLimited(req) {
  const key = `${req.ip || "unknown"}:${normalizePhone(req.body?.phone) || "none"}`;
  const now = Date.now();
  const record = authAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 15 * 60 * 1000;
  }
  record.count += 1;
  authAttempts.set(key, record);
  return record.count > 12;
}

async function initDatabase() {
  if (!dbPool) {
    console.warn("[DB] DATABASE_URL is not configured; customer auth/orders are unavailable.");
    return false;
  }

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      phone VARCHAR(20) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS sessions_customer_idx ON sessions(customer_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_number VARCHAR(32) NOT NULL UNIQUE,
      customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      customer_name VARCHAR(80) NOT NULL,
      customer_phone VARCHAR(20) NOT NULL,
      status VARCHAR(32) NOT NULL,
      payment_method VARCHAR(32) NOT NULL,
      payment_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      payment_reference VARCHAR(120),
      total_sdg NUMERIC(14,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id VARCHAR(200) NOT NULL,
      product_name VARCHAR(500) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price_sdg NUMERIC(14,2) NOT NULL,
      fields_json JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
    CREATE TABLE IF NOT EXISTS catalog_cache (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      version INTEGER NOT NULL,
      built_at BIGINT NOT NULL,
      usd_to_sdg NUMERIC(14,4) NOT NULL,
      products_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS store_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      version INTEGER NOT NULL,
      settings_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbPool.query("DELETE FROM sessions WHERE expires_at < NOW()");
  console.log("[DB] PostgreSQL ready");
  return true;
}

async function getCurrentCustomer(req) {
  if (!dbPool) return null;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const result = await dbPool.query(`
    SELECT c.id, c.name, c.phone
    FROM sessions s
    JOIN customers c ON c.id = s.customer_id
    WHERE s.token_hash = $1 AND s.expires_at > NOW()
    LIMIT 1
  `, [tokenHash]);
  return result.rows[0] || null;
}

async function requireCustomer(req, res, next) {
  try {
    const customer = await getCurrentCustomer(req);
    if (!customer) {
      clearSessionCookie(res);
      return res.status(401).json({ ok: false, error: "Authentication required" });
    }
    req.customer = customer;
    next();
  } catch (error) {
    console.error("[AUTH] Session check failed:", error.message);
    res.status(503).json({ ok: false, error: "Authentication service unavailable" });
  }
}

function requireDatabase(res) {
  if (!dbPool) {
    res.status(503).json({ ok: false, error: "Database is not configured" });
    return false;
  }
  return true;
}

async function loadPriceCacheFromDatabase() {
  if (!dbPool) return false;

  try {
    const result = await dbPool.query(`
      SELECT version, built_at, products_json
      FROM catalog_cache
      WHERE id = 1
      LIMIT 1
    `);

    const row = result.rows[0];
    if (!row || Number(row.version) !== PRICE_CACHE_VERSION) return false;

    const products = row.products_json;
    const builtAt = Number(row.built_at);

    if (!Array.isArray(products) || !products.length || !Number.isFinite(builtAt)) {
      return false;
    }

    pricedCatalogCache = products;
    pricedCatalogBuiltAt = builtAt;
    console.log(`[PRICE CACHE] Loaded ${products.length} products from PostgreSQL`);
    return true;
  } catch (error) {
    console.warn("[PRICE CACHE] Could not load catalog from PostgreSQL:", error.message);
    return false;
  }
}

async function savePriceCacheToDatabase(products, builtAt = Date.now()) {
  if (!dbPool || !Array.isArray(products) || !products.length) return false;

  try {
    await dbPool.query(`
      INSERT INTO catalog_cache (id, version, built_at, usd_to_sdg, products_json, updated_at)
      VALUES (1, $1, $2, $3, $4::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        version = EXCLUDED.version,
        built_at = EXCLUDED.built_at,
        usd_to_sdg = EXCLUDED.usd_to_sdg,
        products_json = EXCLUDED.products_json,
        updated_at = NOW()
    `, [PRICE_CACHE_VERSION, builtAt, getPricingConfig().usdToSdg, JSON.stringify(products)]);
    return true;
  } catch (error) {
    console.warn("[PRICE CACHE] Could not save catalog to PostgreSQL:", error.message);
    return false;
  }
}


async function loadStoreSettingsFromDatabase() {
  if (!dbPool) return false;

  try {
    const result = await dbPool.query(`
      SELECT version, settings_json
      FROM store_settings
      WHERE id = 1
      LIMIT 1
    `);

    const row = result.rows[0];
    if (!row || Number(row.version) !== STORE_SETTINGS_VERSION) return false;

    const parsed = row.settings_json;
    if (!parsed || typeof parsed !== "object") return false;

    storeSettings = normalizeStoreSettings(parsed);
    console.log("[STORE SETTINGS] Loaded settings from PostgreSQL");
    return true;
  } catch (error) {
    console.warn("[STORE SETTINGS] Could not load settings from PostgreSQL:", error.message);
    return false;
  }
}

async function saveStoreSettingsToDatabase(settings) {
  if (!dbPool || !settings || typeof settings !== "object") return false;

  try {
    await dbPool.query(`
      INSERT INTO store_settings (id, version, settings_json, updated_at)
      VALUES (1, $1, $2::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET
        version = EXCLUDED.version,
        settings_json = EXCLUDED.settings_json,
        updated_at = NOW()
    `, [STORE_SETTINGS_VERSION, JSON.stringify(settings)]);
    return true;
  } catch (error) {
    console.warn("[STORE SETTINGS] Could not save settings from PostgreSQL:", error.message);
    return false;
  }
}
// ======================================================
// ABESHA STORE — التسعير المركزي
// ======================================================

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PRICE_CACHE_VERSION = 5;
const PRICE_CACHE_FILE = path.join(__dirname, "pricing-cache.json");
const STORE_SETTINGS_FILE = path.join(__dirname, "store-settings.json");
const ORDERS_FILE = path.join(__dirname, "orders.json");
const STORE_SETTINGS_VERSION = 1;


let pricedCatalogCache = null;
let pricedCatalogBuiltAt = 0;

// ======================================================
// إعدادات Express
// ======================================================

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======================================================
// أدوات Fazer
// ======================================================

function requireFazerKey() {
  if (!process.env.FAZER_API_KEY) {
    const error = new Error("FAZER_API_KEY is not configured");
    error.status = 500;
    throw error;
  }
}

function fazerHeaders(extra = {}) {
  return {
    "X-API-Key": process.env.FAZER_API_KEY,
    "Accept": "application/json",
    ...extra
  };
}

async function fazerFetch(endpoint, options = {}) {
  requireFazerKey();

  const maxRetries = Number.isFinite(Number(options.maxRetries))
    ? Math.max(0, Number(options.maxRetries))
    : 3;
  const baseDelayMs = Number.isFinite(Number(options.baseDelayMs))
    ? Math.max(250, Number(options.baseDelayMs))
    : 1200;
  const timeoutMs = options.timeoutMs || 30000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${FAZER_API}${endpoint}`, {
        ...options,
        method: options.method || "GET",
        headers: {
          ...fazerHeaders(options.headers || {})
        },
        signal: controller.signal
      });

      const text = await response.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      if (response.ok) return data;

      const error = new Error(
        data?.message || data?.error || `Fazer API HTTP ${response.status}`
      );
      error.status = response.status;
      error.data = data;
      error.retryAfter = response.headers.get("retry-after");

      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      if (!retryable || attempt >= maxRetries) throw error;

      let waitMs = 0;
      const retryAfter = Number(error.retryAfter);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        waitMs = retryAfter * 1000;
      } else {
        waitMs = Math.min(15000, baseDelayMs * (2 ** attempt));
        waitMs += Math.floor(Math.random() * 400);
      }

      console.warn(`[FAZER] HTTP ${response.status}; retry ${attempt + 1}/${maxRetries} in ${waitMs}ms: ${endpoint}`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    } catch (error) {
      const retryable = error?.name === "AbortError" || [429, 500, 502, 503, 504].includes(error?.status);
      if (!retryable || attempt >= maxRetries) throw error;

      const waitMs = Math.min(15000, baseDelayMs * (2 ** attempt)) + Math.floor(Math.random() * 400);
      console.warn(`[FAZER] ${error.name === "AbortError" ? "timeout" : `HTTP ${error.status}`}; retry ${attempt + 1}/${maxRetries} in ${waitMs}ms: ${endpoint}`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Fazer request failed after retries");
}
async function fazerGet(endpoint, timeoutMs = 30000) {
  return fazerFetch(endpoint, {
    method: "GET",
    timeoutMs
  });
}

async function getAllCategories(endpoint) {
  const items = [];
  let cursor = null;

  // Fazer v2 uses cursor pagination for the family catalogs.
  // Do not send a legacy `limit` parameter to these family endpoints.
  for (let page = 0; page < 100; page++) {
    const query = cursor
      ? `?cursor=${encodeURIComponent(cursor)}`
      : "";

    const data = await fazerGet(`${endpoint}${query}`);
    const pageItems = getArray(data, ["items", "categories", "games"]);

    if (pageItems.length) {
      items.push(...pageItems);
    }

    const nextCursor =
      data?.meta?.next_cursor ||
      data?.next_cursor ||
      data?.pagination?.next_cursor ||
      null;

    if (!nextCursor) {
      break;
    }

    cursor = nextCursor;
  }

  return items;
}

function getArray(data, keys = ["items", "offers", "cards"]) {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.data?.items)) {
    return data.data.items;
  }

  if (Array.isArray(data?.data?.offers)) {
    return data.data.offers;
  }

  if (Array.isArray(data?.data?.cards)) {
    return data.data.cards;
  }

  return [];
}

// ======================================================
// التسعير
// ======================================================

function getPricingConfig() {
  const pricing = storeSettings?.pricing || DEFAULT_STORE_SETTINGS.pricing;
  return {
    usdToSdg: Number(pricing.usdToSdg) > 0 ? Number(pricing.usdToSdg) : DEFAULT_USD_TO_SDG,
    tiers: Array.isArray(pricing.tiers) && pricing.tiers.length === 4
      ? pricing.tiers
      : DEFAULT_STORE_SETTINGS.pricing.tiers,
    rounding: { ...DEFAULT_STORE_SETTINGS.pricing.rounding, ...(pricing.rounding || {}) }
  };
}

function getMarkupForCost(costSdg) {
  const pricing = getPricingConfig();
  const tier = pricing.tiers.find(item => {
    const max = item.maxCost == null ? Infinity : Number(item.maxCost);
    return costSdg <= max;
  });
  return tier ? Number(tier.markup) : 0.10;
}

function roundCommercialPrice(value) {
  if (!Number.isFinite(value) || value <= 0) return null;

  const r = getPricingConfig().rounding;
  let step;
  if (value < 10000) step = Number(r.under10000) || 100;
  else if (value < 100000) step = Number(r.from10000To100000) || 500;
  else if (value < 500000) step = Number(r.from100000To500000) || 1000;
  else step = Number(r.from500000) || 5000;

  return Math.ceil(value / step) * step;
}

function calculateSalePrice(priceUsd) {
  const usd = Number(priceUsd);
  if (!Number.isFinite(usd) || usd <= 0) return null;

  const pricing = getPricingConfig();
  const costSdg = usd * pricing.usdToSdg;
  const markup = getMarkupForCost(costSdg);
  return roundCommercialPrice(costSdg * (1 + markup));
}

function frontendCompatibleUsd(saleSdg) {
  const sale = Number(saleSdg);
  if (!Number.isFinite(sale) || sale <= 0) return null;
  const pricing = getPricingConfig();
  return sale / (pricing.usdToSdg * 1.10);
}

function quantityFromText(text) {
  const match = String(text || "").match(
    /\b(8100|6000|3850|3000|1800|1500|1300|1100|660|650|600|325|300|270|205|170|100|65|60|50|40|20)\b/i
  );

  return match ? Number(match[1]) : null;
}


function offerPriceUsd(offer) {
  const candidates = [
    offer?.price_usd,
    offer?.priceUSD,
    offer?.usd_price,
    offer?.cost_usd,
    offer?.costUSD,
    offer?.price
  ];

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }

  return null;
}

function offerLabel(offer) {
  return String(
    offer?.name ||
    offer?.title ||
    offer?.description ||
    offer?.product_name ||
    offer?.productName ||
    offer?.amount ||
    offer?.quantity ||
    offer?.denomination ||
    "عرض"
  ).trim();
}

function offerUniqueId(offer, index) {
  return String(
    offer?.id ||
    offer?.offer_id ||
    offer?.offerId ||
    offer?.sku ||
    offer?.code ||
    `${index}`
  );
}


// ======================================================
// إعدادات المتجر — النشر والعروض
// ======================================================

const DEFAULT_STORE_SETTINGS = {
  version: STORE_SETTINGS_VERSION,
  catalogMode: "all",
  publishedIds: [],
  hiddenIds: [],
  discounts: {},
  pricing: {
    usdToSdg: DEFAULT_USD_TO_SDG,
    tiers: [
      { maxCost: 20000, markup: 0.07 },
      { maxCost: 100000, markup: 0.08 },
      { maxCost: 300000, markup: 0.09 },
      { maxCost: null, markup: 0.10 }
    ],
    rounding: {
      under10000: 100,
      from10000To100000: 500,
      from100000To500000: 1000,
      from500000: 5000
    }
  }
};

function cloneDefaultStoreSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_STORE_SETTINGS));
}

function normalizeStoreSettings(parsed) {
  const defaults = cloneDefaultStoreSettings();
  const pricing = parsed && parsed.pricing && typeof parsed.pricing === "object"
    ? parsed.pricing
    : {};

  const tiers = Array.isArray(pricing.tiers) && pricing.tiers.length === 4
    ? pricing.tiers.map((tier, index) => ({
        maxCost: tier.maxCost == null ? null : Number(tier.maxCost),
        markup: Number(tier.markup)
      })).filter(t => Number.isFinite(t.markup) && t.markup >= 0)
    : defaults.pricing.tiers;
  hiddenIds: [],
  discounts: {},
  pricing: {
    usdToSdg: DEFAULT_USD_TO_SDG,
    tiers: [
      { maxCost: 20000, markup: 0.07 },
      { maxCost: 100000, markup: 0.08 },
      { maxCost: 300000, markup: 0.09 },
      { maxCost: null, markup: 0.10 }
    ],
    rounding: {
      under10000: 100,
      from10000To100000: 500,
      from100000To500000: 1000,
      from500000: 5000
    }
  }
};

function cloneDefaultStoreSettings() {
  return JSON.parse(JSON.stringify(DEFAULT_STORE_SETTINGS));
}

function normalizeStoreSettings(parsed) {
  const defaults = cloneDefaultStoreSettings();
  const pricing = parsed && parsed.pricing && typeof parsed.pricing === "object"
    ? parsed.pricing
    : {};

  const tiers = Array.isArray(pricing.tiers) && pricing.tiers.length === 4
    ? pricing.tiers.map((tier, index) => ({
        maxCost: tier.maxCost == null ? null : Number(tier.maxCost),
        markup: Number(tier.markup)
      })).filter(t => Number.isFinite(t.markup) && t.markup >= 0)
    : defaults.pricing.tiers;

  return {
    ...defaults,
    ...(parsed && typeof parsed === "object" ? parsed : {}),
    publishedIds: Array.isArray(parsed?.publishedIds) ? parsed.publishedIds : [],
    hiddenIds: Array.isArray(parsed?.hiddenIds) ? parsed.hiddenIds : [],
    discounts: parsed?.discounts && typeof parsed.discounts === "object"
      ? parsed.discounts
      : {},
    pricing: {
      ...defaults.pricing,
      ...pricing,
      usdToSdg: Number.isFinite(Number(pricing.usdToSdg)) && Number(pricing.usdToSdg) > 0
        ? Number(pricing.usdToSdg)
        : defaults.pricing.usdToSdg,
      tiers: tiers.length === 4 ? tiers : defaults.pricing.tiers,
      rounding: { ...defaults.pricing.rounding, ...(pricing.rounding || {}) }
    }
  };
}

function saveStoreSettings(settings) {
  try {
    fs.writeFileSync(
      STORE_SETTINGS_FILE,
      JSON.stringify(normalizeStoreSettings(settings), null, 2),
      "utf8"
    );
  } catch (error) {
    console.warn("[STORE SETTINGS] Could not save settings:", error.message);
  }
}

function loadStoreSettings() {
  try {
    if (!fs.existsSync(STORE_SETTINGS_FILE)) {
      const settings = cloneDefaultStoreSettings();
      saveStoreSettings(settings);
      return settings;
    }

    const parsed = JSON.parse(fs.readFileSync(STORE_SETTINGS_FILE, "utf8"));
    return normalizeStoreSettings(parsed);
  } catch (error) {
    console.warn("[STORE SETTINGS] Could not load settings:", error.message);
    return cloneDefaultStoreSettings();
  }
}

let storeSettings = loadStoreSettings();

function normalizeDiscount(raw) {
  if (!raw || typeof raw !== "object") return null;

  const type = raw.type === "fixed" ? "fixed" : "percent";
  const value = Number(raw.value);
  const startsAt = raw.startsAt ? new Date(raw.startsAt).toISOString() : null;
  const endsAt = raw.endsAt ? new Date(raw.endsAt).toISOString() : null;
  const active = raw.active !== false;

  if (!Number.isFinite(value) || value <= 0) return null;
  if (type === "percent" && value >= 100) return null;
  if (type === "fixed" && value >= 100000000) return null;

  return {
    type,
    value,
    startsAt,
    endsAt,
    active,
    label: String(raw.label || "عرض خاص").trim().slice(0, 100)
  };
}

function isDiscountActive(discount) {
  if (!discount || discount.active === false) return false;

  const now = Date.now();

  if (discount.startsAt) {
    const start = Date.parse(discount.startsAt);
    if (Number.isFinite(start) && now < start) return false;
  }

  if (discount.endsAt) {
    const end = Date.parse(discount.endsAt);
    if (Number.isFinite(end) && now > end) return false;
  }

  return true;
}

function applyDiscount(basePrice, discount) {
  const base = Number(basePrice);
  if (!Number.isFinite(base) || base <= 0 || !isDiscountActive(discount)) {
    return {
      price: basePrice,
      originalPrice: null,
      discount: null
    };
  }

  let sale = base;

  if (discount.type === "fixed") {
    sale = base - Number(discount.value);
  } else {
    sale = base * (1 - Number(discount.value) / 100);
  }

  sale = roundCommercialPrice(Math.max(100, sale));

  if (!sale || sale >= base) {
    return {
      price: basePrice,
      originalPrice: null,
      discount: null
    };
  }

  return {
    price: sale,
    originalPrice: base,
    discount
  };
}

function productVisibility(product) {
  const id = String(product.id || "");

  if (storeSettings.hiddenIds.includes(id)) return false;

  if (storeSettings.catalogMode === "curated") {
    return storeSettings.publishedIds.includes(id);
  }

  return true;
}

function classifyStoreCategory(product) {
  const family = String(product.family || product.product_family || product.productFamily || "").toLowerCase().replace(/[\s_-]+/g, "");
  const type = String(product.type || "").toLowerCase().replace(/[\s_-]+/g, "");
  const raw = [
    product.category, product.subcategory, product.brand, product.name,
    product.title, product.base_name, product.product_name, product.productName,
    product.description, product.platform, product.region, product.tags,
    product.offer?.category, product.offer?.subcategory, product.offer?.brand,
    product.offer?.name, product.offer?.title, product.offer?.description,
    product.offer?.platform, product.offer?.tags
  ].flat().filter(Boolean).join(" ").toLowerCase();

  if (family === "steam" || type === "steam" || /\bsteam\b/.test(raw)) return "steam";

  const subscriptionSignals = [
    "subscription", "membership", "netflix", "spotify", "game pass",
    "xbox game pass", "playstation plus", "ps plus", "apple music",
    "youtube premium", "prime video", "disney+", "disney plus",
    "crunchyroll", "discord nitro", "nitro", "subscription card"
  ];
  if (subscriptionSignals.some(x => raw.includes(x))) return "subscription";

  if (family === "giftcard" || family === "gift_card" || family === "gift-card" || type === "giftcard" || type === "gift_card") return "gift";
  if (family === "topup" || type === "topup") return "mobile";
  if (family === "gamekey" || type === "gamekey") return "game";

  if (/\b(pubg|free fire|roblox|valorant|mobile legends|call of duty mobile)\b/.test(raw)) return "mobile";
  if (/gift card|giftcard|google play|apple gift|playstation|xbox|nintendo/.test(raw)) return "gift";
  return "game";
}

function enrichProductForStore(product) {
  const basePrice = Number(product.price_sdg);
  const discount = storeSettings.discounts[String(product.id)];
  const pricing = applyDiscount(basePrice, discount);

  const result = {
    ...product,
    price_sdg: pricing.price,
    store_category: product.store_category || classifyStoreCategory(product),
    original_price_sdg: pricing.originalPrice,
    discount: pricing.discount
  };

  // Supplier cost and raw supplier offer details are internal.
  delete result.source_price_usd;
  delete result.cost_sdg;
  delete result.markup_percent;
  delete result.price_usd;
  delete result.offer;

  return result;
}

function getAdminProduct(product) {
  const discount = storeSettings.discounts[String(product.id)] || null;

  return {
    ...product,
    published: productVisibility(product),
    discount
  };
}

function getPublicProducts(products) {
  return products
    .filter(productVisibility)
    .filter(product => Number(product.price_sdg) > 0)
    .map(enrichProductForStore);
}

async function saveStoreSettingsNow() {
  storeSettings.version = STORE_SETTINGS_VERSION;
  saveStoreSettings(storeSettings);
  await saveStoreSettingsToDatabase(storeSettings);
}

// ======================================================
// Cache الأسعار
// ======================================================

function loadPriceCacheFromDisk() {
  try {
    if (!fs.existsSync(PRICE_CACHE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(PRICE_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (
      parsed &&
      parsed.version === PRICE_CACHE_VERSION &&
      Array.isArray(parsed.products) &&
      Number.isFinite(parsed.builtAt)
    ) {
      pricedCatalogCache = parsed.products;
      pricedCatalogBuiltAt = parsed.builtAt;
      console.log(
        `[PRICE CACHE] Loaded ${pricedCatalogCache.length} products from disk`
      );
    }
  } catch (error) {
    console.warn(
      "[PRICE CACHE] Could not load cache:",
      error.message
    );
  }
}

function savePriceCacheToDisk(products) {
  try {
    fs.writeFileSync(
      PRICE_CACHE_FILE,
      JSON.stringify(
        {
          version: PRICE_CACHE_VERSION,
          builtAt: Date.now(),
          usdToSdg: getPricingConfig().usdToSdg,
          products
        },
        null,
        2
      ),
      "utf8"
    );
    document.getElementById("mode").value=settings.catalogMode||"all";
    updateStats();render();msg("تم تحميل الكتالوج.");
  }catch(e){msg(e.message)}
}
function updateStats(){
  document.getElementById("total").textContent=data.length;
  document.getElementById("published").textContent=data.filter(p=>p.published).length;
  document.getElementById("hidden").textContent=data.filter(p=>!p.published).length;
  document.getElementById("discounts").textContent=data.filter(p=>p.discount && p.discount.active!==false).length;
}
function render(){
  const q=document.getElementById("search").value.trim().toLowerCase();
  const type=document.getElementById("type").value;
  const list=data.filter(p=>(!q||String(p.name||"").toLowerCase().includes(q))&&(!type||p.type===type));
  const box=document.getElementById("products");
  box.innerHTML=list.slice(0,500).map(p=>{
    const d=p.discount;
    const price=Number(p.price_sdg||0);
    const state=p.published?"منشور":"مخفي";
    return '<article class="card">'+
      '<h3>'+esc(p.name)+'</h3>'+
      '<div class="small">'+esc(p.type)+' · '+esc(p.id)+'</div>'+
      '<div class="price">'+price.toLocaleString("en-US")+' SDG</div>'+
      (d?'<div class="discount">عرض: '+esc(d.label)+' — '+(d.type==="percent"?d.value+"%":d.value.toLocaleString("en-US")+" SDG")+'</div>':'')+
      '<div><span class="badge">'+state+'</span>'+((p.stock!==undefined&&p.stock!==null)?'<span class="badge">Stock: '+esc(p.stock)+'</span>':'')+'</div>'+
      '<div class="actions">'+
      '<button class="primary" onclick="togglePublish('+JSON.stringify(p.id)+','+(!p.published)+')">'+(p.published?"إخفاء":"نشر")+'</button>'+
      '<button onclick="setDiscount('+JSON.stringify(p.id)+')">عرض/خصم</button>'+
      (d?'<button class="danger" onclick="removeDiscount('+JSON.stringify(p.id)+')">إزالة العرض</button>':'')+
      '</div></article>'
  }).join("");
}
async function togglePublish(id,publish){
  try{
    await api(publish?"/api/admin/catalog/publish":"/api/admin/catalog/unpublish",{
      method:"POST",body:JSON.stringify({productId:id})
    });
    const p=data.find(x=>x.id===id);if(p)p.published=publish;
    updateStats();render();msg(publish?"تم نشر المنتج.":"تم إخفاء المنتج.");
  }catch(e){msg(e.message)}
}
async function setDiscount(id){
  const type=prompt("نوع الخصم: percent للنسبة أو fixed لمبلغ SDG","percent");
  if(type===null)return;
  if(!["percent","fixed"].includes(type.trim())){msg("نوع الخصم غير صحيح.");return}
  const value=prompt(type==="percent"?"نسبة الخصم":"قيمة الخصم بالجنيه السوداني","10");
  if(value===null)return;
  const n=Number(value);
  if(!Number.isFinite(n)||n<=0){msg("قيمة الخصم غير صحيحة.");return}
  const label=prompt("اسم العرض","عرض خاص");
  if(label===null)return;
  try{
    const j=await api("/api/admin/catalog/discount",{method:"POST",body:JSON.stringify({
      productId:id,discount:{type,value:n,label,active:true}
    })});
    const p=data.find(x=>x.id===id);if(p)p.discount=j.discount;
    updateStats();render();msg("تم حفظ العرض.");
  }catch(e){msg(e.message)}
}
async function removeDiscount(id){
  try{
    await api("/api/admin/catalog/discount/"+encodeURIComponent(id),{method:"DELETE"});
    const p=data.find(x=>x.id===id);if(p)p.discount=null;
    updateStats();render();msg("تمت إزالة العرض.");
  }catch(e){msg(e.message)}
}
async function changeMode(){
  if(!key){msg("أدخل ADMIN_KEY أولاً.");return}
  try{
    const mode=document.getElementById("mode").value;
    await api("/api/admin/catalog/mode",{method:"POST",body:JSON.stringify({mode})});
    settings.catalogMode=mode;
    msg(mode==="all"?"تم تفعيل عرض كل المنتجات.":"تم تفعيل الوضع الانتقائي.");
    updateStats();render();
  }catch(e){msg(e.message)}
}
</script>
</body>
</html>`);
});

// ======================================================
// الطلبات — تخزين محلي + PostgreSQL إن وُجد
// ======================================================

function generateOrderId() {
  return `AB-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function normalizeOrderStatus(status) {
  const allowed = [
    "pending",
    "paid",
    "processing",
    "completed",
    "cancelled",
    "failed"
  ];

  return allowed.includes(status) ? status : "pending";
}

function sanitizeOrderItem(item) {
  return {
    productId: String(item?.productId || item?.id || "").trim(),
    name: String(item?.name || "").trim().slice(0, 300),
    type: String(item?.type || "").trim().slice(0, 50),
    quantity: Math.max(1, Number(item?.quantity) || 1),
    priceSdg: Number(item?.priceSdg ?? item?.price_sdg) || 0,
    fields: item?.fields && typeof item.fields === "object"
      ? item.fields
      : {}
  };
}

function sanitizeOrderPayload(body) {
  const items = Array.isArray(body?.items)
    ? body.items.map(sanitizeOrderItem).filter(item => item.productId && item.name)
    : [];

  const customer = body?.customer && typeof body.customer === "object"
    ? {
        name: String(body.customer.name || "").trim().slice(0, 100),
        phone: String(body.customer.phone || "").trim().slice(0, 50),
        email: String(body.customer.email || "").trim().slice(0, 160)
      }
    : {
        name: "",
        phone: "",
        email: ""
      };

  const payment = body?.payment && typeof body.payment === "object"
    ? {
        method: String(body.payment.method || "").trim().slice(0, 50),
        reference: String(body.payment.reference || "").trim().slice(0, 120)
      }
    : {
        method: "",
        reference: ""
      };

  const totalSdg = items.reduce(
    (sum, item) => sum + item.priceSdg * item.quantity,
    0
  );

  return {
    id: generateOrderId(),
    createdAt: new Date().toISOString(),
    status: "pending",
    customer,
    payment,
    items,
    totalSdg
  };
}

function loadOrdersFromDisk() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];

    const parsed = JSON.parse(
      fs.readFileSync(ORDERS_FILE, "utf8")
    );

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("[ORDERS] Could not load orders:", error.message);
    return [];
  }
}

function saveOrdersToDisk(orders) {
  try {
    fs.writeFileSync(
      ORDERS_FILE,
      JSON.stringify(orders, null, 2),
      "utf8"
    );
  } catch (error) {
    console.warn("[ORDERS] Could not save orders:", error.message);
  }
}

let orders = loadOrdersFromDisk();

function addOrderLocal(order) {
  orders.unshift(order);

  if (orders.length > 5000) {
    orders = orders.slice(0, 5000);
  }

  saveOrdersToDisk(orders);
}

function updateOrderLocal(orderId, patch) {
  const index = orders.findIndex(order => order.id === orderId);

  if (index === -1) return null;

  orders[index] = {
    ...orders[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };

  saveOrdersToDisk(orders);

  return orders[index];
}

async function saveOrderToDatabase(order) {
  if (!pool) return;

  try {
    await pool.query(
      `
      INSERT INTO orders (
        id,
        status,
        customer_name,
        customer_phone,
        customer_email,
        payment_method,
        payment_reference,
        total_sdg,
        items,
        created_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb,
        $10
      )
      ON CONFLICT (id) DO NOTHING
      `,
      [
        order.id,
        order.status,
        order.customer.name,
        order.customer.phone,
        order.customer.email,
        order.payment.method,
        order.payment.reference,
        order.totalSdg,
        JSON.stringify(order.items),
        order.createdAt
      ]
    );
  } catch (error) {
    console.warn("[ORDERS] Could not save order to database:", error.message);
  }
}

async function updateOrderInDatabase(orderId, patch) {
  if (!pool) return;

  try {
    await pool.query(
      `
      UPDATE orders
      SET
        status = COALESCE($2, status),
        payment_reference = COALESCE($3, payment_reference),
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        orderId,
        patch.status || null,
        patch.paymentReference || null
      ]
    );
  } catch (error) {
    console.warn("[ORDERS] Could not update order in database:", error.message);
  }
}

app.post("/api/orders", async (req, res) => {
  try {
    const order = sanitizeOrderPayload(req.body);

    if (!order.items.length) {
      return res.status(400).json({
        ok: false,
        error: "At least one product is required"
      });
    }

    if (order.totalSdg <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Order total must be greater than zero"
      });
    }

    addOrderLocal(order);
    await saveOrderToDatabase(order);

    res.status(201).json({
      ok: true,
      order
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/orders/:id", (req, res) => {
  const order = orders.find(
    item => item.id === String(req.params.id)
  );

  if (!order) {
    return res.status(404).json({
      ok: false,
      error: "Order not found"
    });
  }

  res.json({
    ok: true,
    order
  });
});

        createdAt: row.created_at,
        updatedAt: row.updated_at,
        items: await getCustomerOrderItems(row.id)
      });
    }
    res.json({ ok: true, total: orders.length, orders });
  } catch (error) {
    res.status(500).json({ ok: false, error: "تعذر تحميل الطلبات." });
  }
});

app.post("/api/admin/orders/:orderNumber/status", requireAdmin, async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || "").trim();
    const status = String(req.body?.status || "").trim().toUpperCase();

    const allowed = [
      "PAYMENT_PENDING",
      "PAID",
      "PROCESSING",
      "COMPLETED",
      "CANCELLED",
      "FAILED"
    ];

    if (!allowed.includes(status)) {
      return res.status(400).json({
        ok: false,
        error: "حالة الطلب غير صالحة."
      });
    }

    const result = await dbPool.query(`
      UPDATE orders
      SET status = $2,
          payment_status = CASE
            WHEN $2 = 'PAID' THEN 'PAID'
            WHEN $2 = 'PAYMENT_PENDING' THEN 'PENDING'
            WHEN $2 IN ('CANCELLED', 'FAILED') THEN 'FAILED'
            ELSE payment_status
          END,
          updated_at = NOW()
      WHERE order_number = $1
      RETURNING id, order_number, status, payment_method, payment_status, payment_reference, total_sdg, created_at, updated_at
    `, [orderNumber, status]);

    if (!result.rowCount) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    const order = result.rows[0];

    res.json({
      ok: true,
      order: {
        orderNumber: order.order_number,
        status: order.status,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        paymentReference: order.payment_reference,
        total: Number(order.total_sdg),
        createdAt: order.created_at,
        updatedAt: order.updated_at
      }
    });
  } catch (error) {
    console.error("[ADMIN ORDER STATUS]", error);
    res.status(500).json({
      ok: false,
      error: "تعذر تحديث حالة الطلب."
    });
  }
});

// ======================================================
// بدء الخادم
// ======================================================

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(`ABESHA STORE running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`Pricing USD/SDG: ${getPricingConfig().usdToSdg}`);
      console.log(`Price cache available: ${cacheIsAvailable()}`);
      console.log(`Database configured: ${Boolean(process.env.DATABASE_URL)}`);
    });
  } catch (error) {
    console.error("[SERVER START ERROR]", error);
    process.exit(1);
  }
}

startServer();