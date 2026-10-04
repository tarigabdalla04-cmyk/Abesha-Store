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
    console.warn("[STORE SETTINGS] Could not save settings to PostgreSQL:", error.message);
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
  }

  const usablePrices = products.filter(
    product =>
      Number.isFinite(Number(product.price_sdg)) &&
      Number(product.price_sdg) > 0
  ).length;

  console.log(
    `[PRICE CACHE] Built ${products.length} catalog entries; ${usablePrices} have prices`
  );

  pricedCatalogCache = products;
  pricedCatalogBuiltAt = Date.now();

  savePriceCacheToDisk(products);
  void savePriceCacheToDatabase(products, pricedCatalogBuiltAt);

  return products;
}

async function getPricedCatalog() {
  if (cacheIsAvailable()) {
    return pricedCatalogCache;
  }

  throw new Error(
    "Pricing catalog is not available locally. Automatic Fazer catalog rebuild is disabled."
  );
}

loadPriceCacheFromDisk();

// ======================================================
// الصحة
// ======================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ABESHA STORE",
    status: "running",
    pricing: {
      usdToSdg: getPricingConfig().usdToSdg,
      cacheAvailable: cacheIsAvailable(),
      cacheFresh: cacheIsFresh(),
      cachedProducts: pricedCatalogCache?.length || 0
    }
  });
});

// ======================================================
// Fazer /me
// ======================================================

app.get("/api/fazer/me", requireAdmin, async (req, res) => {
  try {
    const data = await fazerGet("/me");
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Fazer catalog
// ======================================================

app.get("/api/fazer/catalog", requireAdmin, async (req, res) => {
  try {
    // Fazer v2 has no unified /catalog endpoint. Build this compatibility
    // response from the documented family-specific catalogs instead.
    const results = await Promise.allSettled([
      getAllCategories("topups"),
      getAllCategories("giftcards"),
      getAllCategories("gamekeys")
    ]);

    const topups = results[0].status === "fulfilled" ? results[0].value : [];
    const giftcards = results[1].status === "fulfilled" ? results[1].value : [];
    const gamekeys = results[2].status === "fulfilled" ? results[2].value : [];

    res.json({
      ok: true,
      families: {
        topups: { ok: results[0].status === "fulfilled", items: topups },
        giftcards: { ok: results[1].status === "fulfilled", items: giftcards },
        gamekeys: { ok: results[2].status === "fulfilled", items: gamekeys }
      },
      total: topups.length + giftcards.length + gamekeys.length
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Topups
// ======================================================

app.get("/api/fazer/topups", requireAdmin, async (req, res) => {
  try {
    const items = await getAllCategories("topups");

    res.json({
      ok: true,
      kind: "topup",
      items,
      meta: {
        total: items.length,
        limit: items.length,
        next_cursor: null,
        has_more: false
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/fazer/topups/offers", requireAdmin, async (req, res) => {
  try {
    const categoryId = req.query.category_id;

    if (!categoryId) {
      return res.status(400).json({
        ok: false,
        error: "category_id is required"
      });
    }

    const data = await fazerGet(
      `/topups/offers?category_id=${encodeURIComponent(categoryId)}`
    );

    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Gift Cards
// ======================================================

app.get("/api/fazer/giftcards", requireAdmin, async (req, res) => {
  try {
    const items = await getAllCategories("giftcards");

    res.json({
      ok: true,
      kind: "gift_card",
      items,
      meta: {
        total: items.length,
        limit: items.length,
        next_cursor: null,
        has_more: false
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/fazer/giftcards/cards", requireAdmin, async (req, res) => {
  try {
    const categoryId = req.query.category_id;

    if (!categoryId) {
      return res.status(400).json({
        ok: false,
        error: "category_id is required"
      });
    }

    const data = await fazerGet(
      `/giftcards/cards?category_id=${encodeURIComponent(categoryId)}`
    );

    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// المنتجات — النسخة المسعّرة
// ======================================================

app.get("/api/products", async (req, res) => {
  try {
    const products = await getPricedCatalog();
    const visibleProducts = getPublicProducts(products);

    res.json({
      ok: true,
      total: visibleProducts.length,
      products: visibleProducts,
      pricing: {
        currency: "SDG",
        catalogMode: storeSettings.catalogMode
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ======================================================
// تحديث الأسعار يدويًا عند الحاجة
// ======================================================

app.post("/api/prices/refresh", requireAdmin, async (req, res) => {
  try {
    const products = repriceCachedCatalog();

    res.json({
      ok: true,
      total: products.length,
      refreshedAt: new Date().toISOString(),
      source: "local-cache"
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error.message
    });
  }
});

// ======================================================
// PUBG ID validation
// ======================================================

app.post("/api/fazer/topups/validate-id", requireAdmin, async (req, res) => {
  try {
    const { category_id, fields } = req.body;

    const data = await fazerFetch(
      "/topups/validate-id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          category_id,
          fields
        })
      }
    );

    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Game Keys
// ======================================================

app.get("/api/fazer/gamekeys", requireAdmin, async (req, res) => {
  try {
    const items = await getAllCategories("gamekeys");

    res.json({
      ok: true,
      kind: "game_key",
      items,
      meta: {
        total: items.length,
        limit: items.length,
        next_cursor: null,
        has_more: false
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Steam
// ======================================================

app.get("/api/fazer/steam-topup/rates", requireAdmin, async (req, res) => {
  try {
    const data = await fazerGet("/steam-topup/rates");
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/fazer/steam-gifts/games", requireAdmin, async (req, res) => {
  try {
    const limit = req.query.limit || "100";

    const data = await fazerGet(
      `/steam-gifts/games?limit=${encodeURIComponent(limit)}`
    );

    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// الكتالوج الموحد القديم — محفوظ للتوافق
// ======================================================

app.get("/api/catalog", requireAdmin, async (req, res) => {
  try {
    const familyResults = await Promise.allSettled([
      getAllCategories("topups"),
      getAllCategories("giftcards"),
      getAllCategories("gamekeys")
    ]);

    const topups = familyResults[0].status === "fulfilled"
      ? familyResults[0].value
      : [];
    const giftcards = familyResults[1].status === "fulfilled"
      ? familyResults[1].value
      : [];
    const gamekeys = familyResults[2].status === "fulfilled"
      ? familyResults[2].value
      : [];

    const products = [
      ...topups.map(item => ({
        id: item.category_id,
        name: item.name,
        type: "topup",
        note: item.note || "",
        fields: item.fields || []
      })),

      ...giftcards.map(item => ({
        id: item.category_id,
        name: item.name,
        type: "gift_card",
        note: item.note || "",
        fields: item.fields || []
      })),

      ...gamekeys.map(item => ({
        id: item.game_id || item.category_id,
        name: item.name,
        type: "game_key",
        platform: item.platform || "",
        region: item.region || "",
        region_restriction: item.region_restriction || false
      }))
    ];

    res.json({
      ok: true,
      total: products.length,
      products
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ======================================================
// المنتجات المنشورة
// ======================================================

app.get("/api/catalog/published", (req, res) => {
  try {
    const configPath = path.join(
      __dirname,
      "catalog-config.json"
    );

    const config = JSON.parse(
      fs.readFileSync(configPath, "utf8")
    );

    res.json({
      ok: true,
      total: Array.isArray(config.published)
        ? config.published.length
        : 0,
      published: Array.isArray(config.published)
        ? config.published
        : [],
      pricing: config.pricing || {}
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ======================================================
// الإدارة
// ======================================================

app.get("/api/admin/status", (req, res) => {
  res.json({
    ok: true,
    adminKeyConfigured: Boolean(process.env.ADMIN_KEY)
  });
});

function requireAdmin(req, res, next) {
  const adminKey = req.headers["x-admin-key"];

  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({
      ok: false,
      error: "ADMIN_KEY is not configured"
    });
  }

  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  next();
}

app.get("/api/admin/catalog/summary", requireAdmin, async (req, res) => {
  try {
    const data = await getPricedCatalog();
    const summary = { all: data.length, priced: 0, mobile: 0, game: 0, gift: 0, subscription: 0, steam: 0, unknown: 0 };
    for (const product of data) {
      if (Number(product.price_sdg) > 0) summary.priced += 1;
      const category = product.store_category || classifyStoreCategory(product);
      if (Object.prototype.hasOwnProperty.call(summary, category)) summary[category] += 1;
      else summary.unknown += 1;
    }
    res.json({ ok: true, summary });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/catalog", requireAdmin, async (req, res) => {
  try {
    const data = await getPricedCatalog();

    res.json({
      ok: true,
      total: data.length,
      products: data.map(getAdminProduct),
      settings: storeSettings,
      pricing: {
        usdToSdg: getPricingConfig().usdToSdg,
        tiers: getPricingConfig().tiers
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json({
    ok: true,
    settings: storeSettings,
    pricing: {
      usdToSdg: getPricingConfig().usdToSdg,
      tiers: getPricingConfig().tiers
    }
  });
});

app.post("/api/admin/pricing", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const usdToSdg = Number(body.usdToSdg);
    if (!Number.isFinite(usdToSdg) || usdToSdg <= 0) {
      return res.status(400).json({ ok: false, error: "usdToSdg must be a positive number" });
    }

    const rawTiers = Array.isArray(body.tiers) ? body.tiers : getPricingConfig().tiers;
    if (rawTiers.length !== 4) {
      return res.status(400).json({ ok: false, error: "Exactly 4 pricing tiers are required" });
    }

    const tiers = rawTiers.map((tier, index) => ({
      maxCost: index === 3 ? null : Number(tier.maxCost),
      markup: Number(tier.markup)
    }));

    if (tiers.some((tier, index) =>
      !Number.isFinite(tier.markup) || tier.markup < 0 ||
      (index < 3 && (!Number.isFinite(tier.maxCost) || tier.maxCost <= 0))
    )) {
      return res.status(400).json({ ok: false, error: "Invalid pricing tiers" });
    }

    storeSettings.pricing = {
      usdToSdg,
      tiers,
      rounding: {
        ...getPricingConfig().rounding,
        ...(body.rounding || {})
      }
    };

    void saveStoreSettingsNow();

    // Recalculate existing cached products locally.
    // Never rebuild the catalog from Fazer as a side effect of a pricing change.
    const products = repriceCachedCatalog();

    res.json({
      ok: true,
      pricing: getPricingConfig(),
      repricedProducts: products.length,
      source: "local-cache",
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/catalog/mode", requireAdmin, (req, res) => {
  const mode = String(req.body?.mode || "").trim();

  if (!["all", "curated"].includes(mode)) {
    return res.status(400).json({
      ok: false,
      error: "mode must be all or curated"
    });
  }

  storeSettings.catalogMode = mode;
  void saveStoreSettingsNow();

  res.json({
    ok: true,
    catalogMode: storeSettings.catalogMode
  });
});

app.post("/api/admin/catalog/publish", requireAdmin, (req, res) => {
  const productId = String(req.body?.productId || "").trim();

  if (!productId) {
    return res.status(400).json({
      ok: false,
      error: "productId is required"
    });
  }

  storeSettings.hiddenIds = storeSettings.hiddenIds.filter(id => id !== productId);

  if (!storeSettings.publishedIds.includes(productId)) {
    storeSettings.publishedIds.push(productId);
  }

  void saveStoreSettingsNow();

  res.json({
    ok: true,
    productId,
    published: true
  });
});

app.post("/api/admin/catalog/unpublish", requireAdmin, (req, res) => {
  const productId = String(req.body?.productId || "").trim();

  if (!productId) {
    return res.status(400).json({
      ok: false,
      error: "productId is required"
    });
  }

  storeSettings.publishedIds = storeSettings.publishedIds.filter(id => id !== productId);
  storeSettings.hiddenIds = Array.from(
    new Set([...storeSettings.hiddenIds, productId])
  );

  void saveStoreSettingsNow();

  res.json({
    ok: true,
    productId,
    published: false
  });
});

app.post("/api/admin/catalog/discount", requireAdmin, (req, res) => {
  const productId = String(req.body?.productId || "").trim();
  const discount = normalizeDiscount(req.body?.discount);

  if (!productId) {
    return res.status(400).json({
      ok: false,
      error: "productId is required"
    });
  }

  if (!discount) {
    return res.status(400).json({
      ok: false,
      error: "Invalid discount"
    });
  }

  storeSettings.discounts[productId] = discount;
  void saveStoreSettingsNow();

  res.json({
    ok: true,
    productId,
    discount
  });
});

app.delete("/api/admin/catalog/discount/:productId", requireAdmin, (req, res) => {
  const productId = String(req.params.productId || "").trim();

  delete storeSettings.discounts[productId];
  void saveStoreSettingsNow();

  res.json({
    ok: true,
    productId,
    discount: null
  });
});

// ======================================================
// لوحة الإدارة — لا تحتاج ملف HTML منفصل
// ======================================================

app.get("/admin", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ABESHA STORE — الإدارة</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#071426;color:#eef5ff}
header{padding:18px 16px;background:#0b1f3a;border-bottom:1px solid #1d416e;position:sticky;top:0;z-index:5}
h1{margin:0 0 6px;font-size:22px}.muted{color:#9fb3cc;font-size:13px}
.wrap{max-width:1200px;margin:auto;padding:16px}
.panel{background:#0b1f3a;border:1px solid #1d416e;border-radius:14px;padding:14px;margin-bottom:14px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
input,select,button{font:inherit;border-radius:9px;border:1px solid #31577f;padding:10px}
input,select{background:#071426;color:#fff;min-width:180px}button{background:#123866;color:#fff;cursor:pointer}
button.primary{background:#1769aa}button.danger{background:#7d2633}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:#071426;border-radius:10px;padding:12px}.num{font-size:22px;font-weight:bold;margin-top:5px}
#products{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:#0b1f3a;border:1px solid #1d416e;border-radius:12px;padding:13px}
.card h3{font-size:15px;margin:0 0 8px;line-height:1.4}.price{font-size:19px;font-weight:bold}
.badge{display:inline-block;padding:4px 7px;border-radius:7px;background:#123866;color:#cfe6ff;font-size:11px;margin:2px}
.actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
.small{font-size:12px;color:#a9bdd3}.discount{color:#ffd36b}
.hidden{display:none}
</style>
</head>
<body>
<header>
  <div class="wrap" style="padding:0">
    <h1>ABESHA STORE — لوحة الإدارة</h1>
    <div class="muted">إدارة المنتجات، النشر، الأسعار والعروض</div>
  </div>
</header>
<main class="wrap">
  <section class="panel">
    <div class="row">
      <input id="key" type="password" placeholder="ADMIN_KEY">
      <button class="primary" onclick="loadAll()">دخول وتحميل الكتالوج</button>
      <select id="mode" onchange="changeMode()">
        <option value="all">عرض كل المنتجات الحالية</option>
        <option value="curated">عرض المنتجات التي أختارها فقط</option>
      </select>
    </div>
    <div id="msg" class="muted" style="margin-top:9px"></div>
  </section>

  <section class="panel">
    <div class="stats">
      <div class="stat">إجمالي الكتالوج<div class="num" id="total">—</div></div>
      <div class="stat">المنشور<div class="num" id="published">—</div></div>
      <div class="stat">المخفي<div class="num" id="hidden">—</div></div>
      <div class="stat">عروض نشطة<div class="num" id="discounts">—</div></div>
    </div>
  </section>

  <section class="panel">
    <div class="row">
      <input id="search" placeholder="ابحث باسم المنتج..." oninput="render()">
      <select id="type" onchange="render()">
        <option value="">كل الأقسام</option>
        <option value="topup">Topups</option>
        <option value="gift_card">Gift Cards</option>
        <option value="game_key">Game Keys</option>
        <option value="steam">Steam</option>
        <option value="subscription">Subscriptions</option>
      </select>
      <select id="publishedFilter" onchange="render()">
        <option value="">الكل</option>
        <option value="published">منشور</option>
        <option value="hidden">مخفي</option>
      </select>
    </div>
  </section>

  <section id="products"></section>
</main>

<script>
let catalog = [];
let settings = null;

function headers() {
  return {
    "Content-Type": "application/json",
    "x-admin-key": document.getElementById("key").value.trim()
  };
}

function msg(text, error = false) {
  const el = document.getElementById("msg");
  el.textContent = text || "";
  el.style.color = error ? "#ff9d9d" : "";
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers(),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function loadAll() {
  try {
    msg("جاري تحميل الكتالوج...");
    const data = await api("/api/admin/catalog");
    catalog = Array.isArray(data.products) ? data.products : [];
    settings = data.settings || {};
    document.getElementById("mode").value = settings.catalogMode || "all";
    updateStats();
    render();
    msg("تم تحميل الكتالوج بنجاح");
  } catch (error) {
    msg(error.message, true);
  }
}

function updateStats() {
  const published = catalog.filter(x => x.published).length;
  const hidden = catalog.filter(x => !x.published).length;
  const discounts = catalog.filter(x => x.discount && x.discount.active !== false).length;

  document.getElementById("total").textContent = catalog.length;
  document.getElementById("published").textContent = published;
  document.getElementById("hidden").textContent = hidden;
  document.getElementById("discounts").textContent = discounts;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") + " SDG" : "—";
}

function render() {
  const root = document.getElementById("products");
  const q = document.getElementById("search").value.trim().toLowerCase();
  const type = document.getElementById("type").value;
  const publishedFilter = document.getElementById("publishedFilter").value;

  const filtered = catalog.filter(product => {
    if (q && !String(product.name || "").toLowerCase().includes(q)) return false;
    if (type && product.type !== type && product.store_category !== type) return false;
    if (publishedFilter === "published" && !product.published) return false;
    if (publishedFilter === "hidden" && product.published) return false;
    return true;
  });

  root.innerHTML = filtered.map(product => {
    const discount = product.discount;
    const hasDiscount = discount && discount.active !== false;

    return `
      <article class="card">
        <h3>${esc(product.name)}</h3>
        <div>
          <span class="badge">${esc(product.type || "")}</span>
          <span class="badge">${esc(product.store_category || "")}</span>
          ${product.published
            ? '<span class="badge">منشور</span>'
            : '<span class="badge">مخفي</span>'}
        </div>

        <div style="margin-top:10px">
          <div class="price">${money(product.price_sdg)}</div>
          ${
            hasDiscount
              ? `<div class="small discount">عرض: ${esc(discount.label || "عرض خاص")}</div>`
              : ""
          }
        </div>

        <div class="small" style="margin-top:7px">
          ID: ${esc(product.id)}
        </div>

        <div class="actions">
          ${
            product.published
              ? `<button class="danger" onclick="unpublish('${encodeURIComponent(product.id)}')">إخفاء</button>`
              : `<button class="primary" onclick="publish('${encodeURIComponent(product.id)}')">نشر</button>`
          }
          <button onclick="setDiscount('${encodeURIComponent(product.id)}')">خصم</button>
          ${
            hasDiscount
              ? `<button onclick="removeDiscount('${encodeURIComponent(product.id)}')">إلغاء الخصم</button>`
              : ""
          }
        </div>
      </article>
    `;
  }).join("");

  if (!filtered.length) {
    root.innerHTML = '<section class="panel"><div class="muted">لا توجد نتائج</div></section>';
  }
}

async function publish(id) {
  try {
    await api("/api/admin/catalog/publish", {
      method: "POST",
      body: JSON.stringify({ productId: decodeURIComponent(id) })
    });
    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}

async function unpublish(id) {
  try {
    await api("/api/admin/catalog/unpublish", {
      method: "POST",
      body: JSON.stringify({ productId: decodeURIComponent(id) })
    });
    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}

async function setDiscount(id) {
  const productId = decodeURIComponent(id);
  const type = prompt("نوع الخصم: percent أو fixed", "percent");
  if (!type) return;

  const value = prompt(
    type === "fixed"
      ? "قيمة الخصم بالجنيه السوداني"
      : "نسبة الخصم",
    "5"
  );

  if (!value) return;

  const label = prompt("اسم العرض", "عرض خاص") || "عرض خاص";

  try {
    await api("/api/admin/catalog/discount", {
      method: "POST",
      body: JSON.stringify({
        productId,
        discount: {
          type,
          value: Number(value),
          label,
          active: true
        }
      })
    });

    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}

async function removeDiscount(id) {
  try {
    await api(
      "/api/admin/catalog/discount/" + encodeURIComponent(decodeURIComponent(id)),
      { method: "DELETE" }
    );
    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}

async function changeMode() {
  const mode = document.getElementById("mode").value;

  try {
    await api("/api/admin/catalog/mode", {
      method: "POST",
      body: JSON.stringify({ mode })
    });
    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}
</script>
</body>
</html>`);
});

// ======================================================
// Customer Authentication
// ======================================================

app.get("/api/auth/me", async (req, res) => {
  try {
    const customer = await getCurrentCustomer(req);
    if (!customer) {
      return res.json({
        ok: true,
        authenticated: false,
        customer: null
      });
    }

    res.json({
      ok: true,
      authenticated: true,
      customer
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: "Authentication service unavailable"
    });
  }
});

app.post("/api/auth/register", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    if (authRateLimited(req)) {
      return res.status(429).json({
        ok: false,
        error: "Too many attempts. Please try again later."
      });
    }

    const name = cleanName(req.body?.name);
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");

    if (name.length < 2) {
      return res.status(400).json({
        ok: false,
        error: "Please enter a valid name"
      });
    }

    if (phone.length < 8) {
      return res.status(400).json({
        ok: false,
        error: "Please enter a valid phone number"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Password must be at least 6 characters"
      });
    }

    const existing = await dbPool.query(
      "SELECT id FROM customers WHERE phone = $1 LIMIT 1",
      [phone]
    );

    if (existing.rows[0]) {
      return res.status(409).json({
        ok: false,
        error: "This phone number is already registered"
      });
    }

    const passwordData = await hashPassword(password);

    const result = await dbPool.query(`
      INSERT INTO customers (
        name,
        phone,
        password_hash,
        password_salt
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, phone
    `, [
      name,
      phone,
      passwordData.hash,
      passwordData.salt
    ]);

    const customer = result.rows[0];

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashSessionToken(token);

    await dbPool.query(`
      INSERT INTO sessions (
        customer_id,
        token_hash,
        expires_at
      )
      VALUES ($1, $2, NOW() + INTERVAL '30 days')
    `, [customer.id, tokenHash]);

    setSessionCookie(res, token);

    res.status(201).json({
      ok: true,
      authenticated: true,
      customer
    });
  } catch (error) {
    console.error("[AUTH] Registration failed:", error.message);
    res.status(500).json({
      ok: false,
      error: "Could not create account"
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    if (authRateLimited(req)) {
      return res.status(429).json({
        ok: false,
        error: "Too many attempts. Please try again later."
      });
    }

    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");

    if (phone.length < 8 || !password) {
      return res.status(400).json({
        ok: false,
        error: "Phone and password are required"
      });
    }

    const result = await dbPool.query(`
      SELECT id, name, phone, password_hash, password_salt
      FROM customers
      WHERE phone = $1
      LIMIT 1
    `, [phone]);

    const customer = result.rows[0];

    if (!customer) {
      return res.status(401).json({
        ok: false,
        error: "Invalid phone or password"
      });
    }

    const valid = await verifyPassword(
      password,
      customer.password_hash,
      customer.password_salt
    );

    if (!valid) {
      return res.status(401).json({
        ok: false,
        error: "Invalid phone or password"
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashSessionToken(token);

    await dbPool.query(`
      INSERT INTO sessions (
        customer_id,
        token_hash,
        expires_at
      )
      VALUES ($1, $2, NOW() + INTERVAL '30 days')
    `, [customer.id, tokenHash]);

    setSessionCookie(res, token);

    res.json({
      ok: true,
      authenticated: true,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone
      }
    });
  } catch (error) {
    console.error("[AUTH] Login failed:", error.message);
    res.status(500).json({
      ok: false,
      error: "Could not login"
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];

    if (dbPool && token) {
      await dbPool.query(
        "DELETE FROM sessions WHERE token_hash = $1",
        [hashSessionToken(token)]
      );
    }

    clearSessionCookie(res);

    res.json({
      ok: true,
      authenticated: false
    });
  } catch (error) {
    clearSessionCookie(res);
    res.json({
      ok: true,
      authenticated: false
    });
  }
});

// ======================================================
// Customer Orders
// ======================================================

function makeOrderNumber() {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);

  const random = crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();

  return `ABS-${stamp}-${random}`;
}

function normalizeOrderItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map(item => {
      const quantity = Math.max(
        1,
        Math.min(100, Number.parseInt(item?.quantity, 10) || 1)
      );

      return {
        productId: String(item?.productId || item?.id || "").slice(0, 200),
        productName: String(item?.productName || item?.name || "").trim().slice(0, 500),
        quantity,
        fields: item?.fields && typeof item.fields === "object"
          ? item.fields
          : {}
      };
    })
    .filter(item => item.productId && item.productName);
}

async function buildOrderFromCatalog(customer, rawItems, paymentMethod) {
  const products = await getPricedCatalog();
  const productMap = new Map(
    products
      .filter(productVisibility)
      .filter(product => Number(product.price_sdg) > 0)
      .map(product => [String(product.id), product])
  );

  const items = normalizeOrderItems(rawItems);

  if (!items.length) {
    const error = new Error("Order must contain at least one product");
    error.status = 400;
    throw error;
  }

  const normalized = [];

  for (const item of items) {
    const product = productMap.get(item.productId);

    if (!product) {
      const error = new Error(`Product unavailable: ${item.productId}`);
      error.status = 400;
      throw error;
    }

    const enriched = enrichProductForStore(product);
    const unitPrice = Number(enriched.price_sdg);

    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      const error = new Error(`Product has no valid price: ${item.productName}`);
      error.status = 400;
      throw error;
    }

    normalized.push({
      productId: String(product.id),
      productName: String(enriched.name || item.productName),
      quantity: item.quantity,
      unitPrice,
      fields: item.fields || {}
    });
  }

  const total = normalized.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0
  );

  return {
    paymentMethod: String(paymentMethod || "bankak").trim().toLowerCase(),
    items: normalized,
    total
  };
}

app.post("/api/orders", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;

  const client = await dbPool.connect();

  try {
    const { paymentMethod, items } = await buildOrderFromCatalog(
      req.customer,
      req.body?.items,
      req.body?.paymentMethod
    );

    const allowedPayments = ["bankak", "mycashi"];

    if (!allowedPayments.includes(paymentMethod)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payment method"
      });
    }

    const orderNumber = makeOrderNumber();

    await client.query("BEGIN");

    const orderResult = await client.query(`
      INSERT INTO orders (
        order_number,
        customer_id,
        customer_name,
        customer_phone,
        status,
        payment_method,
        payment_status,
        total_sdg
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'PENDING_PAYMENT',
        $5,
        'PENDING',
        $6
      )
      RETURNING id, order_number, status, payment_method, payment_status, total_sdg, created_at
    `, [
      orderNumber,
      req.customer.id,
      req.customer.name,
      req.customer.phone,
      paymentMethod,
      total
    ]);

    const order = orderResult.rows[0];

    for (const item of items) {
      await client.query(`
        INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          quantity,
          unit_price_sdg,
          fields_json
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `, [
        order.id,
        item.productId,
        item.productName,
        item.quantity,
        item.unitPrice,
        JSON.stringify(item.fields || {})
      ]);
    }

    await client.query("COMMIT");

    res.status(201).json({
      ok: true,
      order: {
        ...order,
        total_sdg: Number(order.total_sdg),
        items
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[ORDERS] Create order failed:", error.message);
    res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Could not create order"
    });
  } finally {
    client.release();
  }
});

app.get("/api/customer/orders", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await dbPool.query(`
      SELECT
        o.id,
        o.order_number,
        o.status,
        o.payment_method,
        o.payment_status,
        o.total_sdg,
        o.created_at,
        o.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'productId', oi.product_id,
              'productName', oi.product_name,
              'quantity', oi.quantity,
              'unitPrice', oi.unit_price_sdg,
              'fields', oi.fields_json
            )
            ORDER BY oi.id
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.customer_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 100
    `, [req.customer.id]);

    res.json({
      ok: true,
      orders: result.rows.map(order => ({
        ...order,
        total_sdg: Number(order.total_sdg),
        items: Array.isArray(order.items) ? order.items.map(item => ({
          ...item,
          unitPrice: Number(item.unitPrice)
        })) : []
      }))
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not load orders"
    });
  }
});

app.get("/api/orders/:orderNumber", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const orderResult = await dbPool.query(`
      SELECT
        id,
        order_number,
        status,
        payment_method,
        payment_status,
        payment_reference,
        total_sdg,
        created_at,
        updated_at
      FROM orders
      WHERE order_number = $1
        AND customer_id = $2
      LIMIT 1
    `, [
      String(req.params.orderNumber),
      req.customer.id
    ]);

    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    const itemsResult = await dbPool.query(`
      SELECT
        product_id,
        product_name,
        quantity,
        unit_price_sdg,
        fields_json
      FROM order_items
      WHERE order_id = $1
      ORDER BY id
    `, [order.id]);

    res.json({
      ok: true,
      order: {
        ...order,
        total_sdg: Number(order.total_sdg),
        items: itemsResult.rows.map(item => ({
          productId: item.product_id,
          productName: item.product_name,
          quantity: item.quantity,
          unitPrice: Number(item.unit_price_sdg),
          fields: item.fields_json || {}
        }))
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not load order"
    });
  }
});

app.post("/api/customer/reorder", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const orderNumber = String(req.body?.orderNumber || "").trim();

    if (!orderNumber) {
      return res.status(400).json({
        ok: false,
        error: "orderNumber is required"
      });
    }

    const result = await dbPool.query(`
      SELECT
        oi.product_id,
        oi.product_name,
        oi.quantity,
        oi.fields_json
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_number = $1
        AND o.customer_id = $2
      ORDER BY oi.id
    `, [orderNumber, req.customer.id]);

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    const products = await getPricedCatalog();
    const productMap = new Map(
      products
        .filter(productVisibility)
        .filter(product => Number(product.price_sdg) > 0)
        .map(product => [String(product.id), product])
    );

    const items = [];

    for (const row of result.rows) {
      const product = productMap.get(String(row.product_id));
      if (!product) continue;

      items.push({
        productId: String(product.id),
        productName: String(product.name || row.product_name),
        quantity: Math.max(1, Number(row.quantity) || 1),
        fields: row.fields_json || {}
      });
    }

    res.json({
      ok: true,
      items
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not prepare reorder"
    });
  }
});

// ======================================================
// Admin Orders
// ======================================================

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const status = String(req.query.status || "").trim();

    const params = [];
    let where = "";

    if (status) {
      params.push(status);
      where = `WHERE o.status = $${params.length}`;
    }

    const result = await dbPool.query(`
      SELECT
        o.id,
        o.order_number,
        o.customer_name,
        o.customer_phone,
        o.status,
        o.payment_method,
        o.payment_status,
        o.payment_reference,
        o.total_sdg,
        o.created_at,
        o.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'productId', oi.product_id,
              'productName', oi.product_name,
              'quantity', oi.quantity,
              'unitPrice', oi.unit_price_sdg,
              'fields', oi.fields_json
            )
            ORDER BY oi.id
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${where}
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 500
    `, params);

    res.json({
      ok: true,
      orders: result.rows.map(order => ({
        ...order,
        total_sdg: Number(order.total_sdg),
        items: Array.isArray(order.items) ? order.items.map(item => ({
          ...item,
          unitPrice: Number(item.unitPrice)
        })) : []
      }))
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not load admin orders"
    });
  }
});

app.post("/api/admin/orders/:orderNumber/confirm-payment", requireAdmin, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const orderNumber = String(req.params.orderNumber || "").trim();
    const paymentReference = String(
      req.body?.paymentReference ||
      req.body?.reference ||
      ""
    ).trim().slice(0, 120);

    if (!orderNumber) {
      return res.status(400).json({
        ok: false,
        error: "orderNumber is required"
      });
    }

    const result = await dbPool.query(`
      UPDATE orders
      SET
        status = 'PAID',
        payment_status = 'CONFIRMED',
        payment_reference = $1,
        updated_at = NOW()
      WHERE order_number = $2
      RETURNING
        id,
        order_number,
        customer_id,
        customer_name,
        customer_phone,
        status,
        payment_method,
        payment_status,
        payment_reference,
        total_sdg,
        created_at,
        updated_at
    `, [paymentReference || null, orderNumber]);

    const order = result.rows[0];

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    res.json({
      ok: true,
      order: {
        ...order,
        total_sdg: Number(order.total_sdg)
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not confirm payment"
    });
  }
});

// ======================================================
// Root
// ======================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ======================================================
// بدء التشغيل
// ======================================================

async function startServer() {
  try {
    await initDatabase();

    // Database is the primary persistent source when available.
    // Disk files remain as a fallback for local/development deployments.
    await loadStoreSettingsFromDatabase();

    const loadedFromDb = await loadPriceCacheFromDatabase();

    if (!loadedFromDb) {
      loadPriceCacheFromDisk();
    }

    if (!cacheIsAvailable()) {
      console.log("[PRICE CACHE] No local/database catalog cache found.");
      console.log("[PRICE CACHE] Building catalog from Fazer once at startup...");

      try {
        await buildPricedCatalog();
      } catch (error) {
        console.error("[PRICE CACHE] Initial catalog build failed:", error.message);
      }
    } else {
      console.log(
        `[PRICE CACHE] Using cached catalog with ${pricedCatalogCache.length} products`
      );
    }

    app.listen(PORT, () => {
      console.log(`ABESHA STORE running on port ${PORT}`);
      console.log(`Pricing USD/SDG: ${getPricingConfig().usdToSdg}`);
      console.log(`Catalog cache: ${pricedCatalogCache?.length || 0} products`);
      console.log(`Database: ${dbPool ? "enabled" : "disabled"}`);
    });
  } catch (error) {
    console.error("[STARTUP] Fatal error:", error);
    process.exit(1);
  }
}

startServer();
  }

  const usablePrices = products.filter(
    product =>
      Number.isFinite(Number(product.price_sdg)) &&
      Number(product.price_sdg) > 0
  ).length;

  console.log(
    `[PRICE CACHE] Built ${products.length} catalog entries; ${usablePrices} have prices`
  );

  pricedCatalogCache = products;
  pricedCatalogBuiltAt = Date.now();

  savePriceCacheToDisk(products);
  void savePriceCacheToDatabase(products, pricedCatalogBuiltAt);

  return products;
}

async function getPricedCatalog() {
  if (cacheIsAvailable()) {
    return pricedCatalogCache;
  }

  throw new Error(
    "Pricing catalog is not available locally. Automatic Fazer catalog rebuild is disabled."
  );
}

loadPriceCacheFromDisk();

// ======================================================
// الصحة
// ======================================================

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ABESHA STORE",
    status: "running",
    pricing: {
      usdToSdg: getPricingConfig().usdToSdg,
      cacheAvailable: cacheIsAvailable(),
      cacheFresh: cacheIsFresh(),
      cachedProducts: pricedCatalogCache?.length || 0
    }
  });
});

// ======================================================
// Fazer /me
// ======================================================

app.get("/api/fazer/me", requireAdmin, async (req, res) => {
  try {
    const data = await fazerGet("/me");
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Fazer catalog
// ======================================================

app.get("/api/fazer/catalog", requireAdmin, async (req, res) => {
  try {
    // Fazer v2 has no unified /catalog endpoint. Build this compatibility
    // response from the documented family-specific catalogs instead.
    const results = await Promise.allSettled([
      getAllCategories("topups"),
      getAllCategories("giftcards"),
      getAllCategories("gamekeys")
    ]);

    const topups = results[0].status === "fulfilled" ? results[0].value : [];
    const giftcards = results[1].status === "fulfilled" ? results[1].value : [];
    const gamekeys = results[2].status === "fulfilled" ? results[2].value : [];

    res.json({
      ok: true,
      families: {
        topups: { ok: results[0].status === "fulfilled", items: topups },
        giftcards: { ok: results[1].status === "fulfilled", items: giftcards },
        gamekeys: { ok: results[2].status === "fulfilled", items: gamekeys }
      },
      total: topups.length + giftcards.length + gamekeys.length
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Topups
// ======================================================

app.get("/api/fazer/topups", requireAdmin, async (req, res) => {
  try {
    const items = await getAllCategories("topups");

    res.json({
      ok: true,
      kind: "topup",
      items,
      meta: {
        total: items.length,
        limit: items.length,
        next_cursor: null,
        has_more: false
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/fazer/topups/offers", requireAdmin, async (req, res) => {
  try {
    const categoryId = req.query.category_id;

    if (!categoryId) {
      return res.status(400).json({
        ok: false,
        error: "category_id is required"
      });
    }

    const data = await fazerGet(
      `/topups/offers?category_id=${encodeURIComponent(categoryId)}`
    );

    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Gift Cards
// ======================================================

app.get("/api/fazer/giftcards", requireAdmin, async (req, res) => {
  try {
    const items = await getAllCategories("giftcards");

    res.json({
      ok: true,
      kind: "gift_card",
      items,
      meta: {
        total: items.length,
        limit: items.length,
        next_cursor: null,
        has_more: false
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/fazer/giftcards/cards", requireAdmin, async (req, res) => {
  try {
    const categoryId = req.query.category_id;

    if (!categoryId) {
      return res.status(400).json({
        ok: false,
        error: "category_id is required"
      });
    }

    const data = await fazerGet(
      `/giftcards/cards?category_id=${encodeURIComponent(categoryId)}`
    );

    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// المنتجات — النسخة المسعّرة
// ======================================================

app.get("/api/products", async (req, res) => {
  try {
    const products = await getPricedCatalog();
    const visibleProducts = getPublicProducts(products);

    res.json({
      ok: true,
      total: visibleProducts.length,
      products: visibleProducts,
      pricing: {
        currency: "SDG",
        catalogMode: storeSettings.catalogMode
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ======================================================
// تحديث الأسعار يدويًا عند الحاجة
// ======================================================

app.post("/api/prices/refresh", requireAdmin, async (req, res) => {
  try {
    const products = repriceCachedCatalog();

    res.json({
      ok: true,
      total: products.length,
      refreshedAt: new Date().toISOString(),
      source: "local-cache"
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error.message
    });
  }
});

// ======================================================
// PUBG ID validation
// ======================================================

app.post("/api/fazer/topups/validate-id", requireAdmin, async (req, res) => {
  try {
    const { category_id, fields } = req.body;

    const data = await fazerFetch(
      "/topups/validate-id",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          category_id,
          fields
        })
      }
    );

    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Game Keys
// ======================================================

app.get("/api/fazer/gamekeys", requireAdmin, async (req, res) => {
  try {
    const items = await getAllCategories("gamekeys");

    res.json({
      ok: true,
      kind: "game_key",
      items,
      meta: {
        total: items.length,
        limit: items.length,
        next_cursor: null,
        has_more: false
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// Steam
// ======================================================

app.get("/api/fazer/steam-topup/rates", requireAdmin, async (req, res) => {
  try {
    const data = await fazerGet("/steam-topup/rates");
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

app.get("/api/fazer/steam-gifts/games", requireAdmin, async (req, res) => {
  try {
    const limit = req.query.limit || "100";

    const data = await fazerGet(
      `/steam-gifts/games?limit=${encodeURIComponent(limit)}`
    );

    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      error: error.message,
      details: error.data || null
    });
  }
});

// ======================================================
// الكتالوج الموحد القديم — محفوظ للتوافق
// ======================================================

app.get("/api/catalog", requireAdmin, async (req, res) => {
  try {
    const familyResults = await Promise.allSettled([
      getAllCategories("topups"),
      getAllCategories("giftcards"),
      getAllCategories("gamekeys")
    ]);

    const topups = familyResults[0].status === "fulfilled"
      ? familyResults[0].value
      : [];
    const giftcards = familyResults[1].status === "fulfilled"
      ? familyResults[1].value
      : [];
    const gamekeys = familyResults[2].status === "fulfilled"
      ? familyResults[2].value
      : [];

    const products = [
      ...topups.map(item => ({
        id: item.category_id,
        name: item.name,
        type: "topup",
        note: item.note || "",
        fields: item.fields || []
      })),

      ...giftcards.map(item => ({
        id: item.category_id,
        name: item.name,
        type: "gift_card",
        note: item.note || "",
        fields: item.fields || []
      })),

      ...gamekeys.map(item => ({
        id: item.game_id || item.category_id,
        name: item.name,
        type: "game_key",
        platform: item.platform || "",
        region: item.region || "",
        region_restriction: item.region_restriction || false
      }))
    ];

    res.json({
      ok: true,
      total: products.length,
      products
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ======================================================
// المنتجات المنشورة
// ======================================================

app.get("/api/catalog/published", (req, res) => {
  try {
    const configPath = path.join(
      __dirname,
      "catalog-config.json"
    );

    const config = JSON.parse(
      fs.readFileSync(configPath, "utf8")
    );

    res.json({
      ok: true,
      total: Array.isArray(config.published)
        ? config.published.length
        : 0,
      published: Array.isArray(config.published)
        ? config.published
        : [],
      pricing: config.pricing || {}
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ======================================================
// الإدارة
// ======================================================

app.get("/api/admin/status", (req, res) => {
  res.json({
    ok: true,
    adminKeyConfigured: Boolean(process.env.ADMIN_KEY)
  });
});

function requireAdmin(req, res, next) {
  const adminKey = req.headers["x-admin-key"];

  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({
      ok: false,
      error: "ADMIN_KEY is not configured"
    });
  }

  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  next();
}

app.get("/api/admin/catalog/summary", requireAdmin, async (req, res) => {
  try {
    const data = await getPricedCatalog();
    const summary = { all: data.length, priced: 0, mobile: 0, game: 0, gift: 0, subscription: 0, steam: 0, unknown: 0 };
    for (const product of data) {
      if (Number(product.price_sdg) > 0) summary.priced += 1;
      const category = product.store_category || classifyStoreCategory(product);
      if (Object.prototype.hasOwnProperty.call(summary, category)) summary[category] += 1;
      else summary.unknown += 1;
    }
    res.json({ ok: true, summary });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/admin/catalog", requireAdmin, async (req, res) => {
  try {
    const data = await getPricedCatalog();

    res.json({
      ok: true,
      total: data.length,
      products: data.map(getAdminProduct),
      settings: storeSettings,
      pricing: {
        usdToSdg: getPricingConfig().usdToSdg,
        tiers: getPricingConfig().tiers
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.json({
    ok: true,
    settings: storeSettings,
    pricing: {
      usdToSdg: getPricingConfig().usdToSdg,
      tiers: getPricingConfig().tiers
    }
  });
});

app.post("/api/admin/pricing", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const usdToSdg = Number(body.usdToSdg);
    if (!Number.isFinite(usdToSdg) || usdToSdg <= 0) {
      return res.status(400).json({ ok: false, error: "usdToSdg must be a positive number" });
    }

    const rawTiers = Array.isArray(body.tiers) ? body.tiers : getPricingConfig().tiers;
    if (rawTiers.length !== 4) {
      return res.status(400).json({ ok: false, error: "Exactly 4 pricing tiers are required" });
    }

    const tiers = rawTiers.map((tier, index) => ({
      maxCost: index === 3 ? null : Number(tier.maxCost),
      markup: Number(tier.markup)
    }));

    if (tiers.some((tier, index) =>
      !Number.isFinite(tier.markup) || tier.markup < 0 ||
      (index < 3 && (!Number.isFinite(tier.maxCost) || tier.maxCost <= 0))
    )) {
      return res.status(400).json({ ok: false, error: "Invalid pricing tiers" });
    }

    storeSettings.pricing = {
      usdToSdg,
      tiers,
      rounding: {
        ...getPricingConfig().rounding,
        ...(body.rounding || {})
      }
    };

    void saveStoreSettingsNow();

    // Recalculate existing cached products locally.
    // Never rebuild the catalog from Fazer as a side effect of a pricing change.
    const products = repriceCachedCatalog();

    res.json({
      ok: true,
      pricing: getPricingConfig(),
      repricedProducts: products.length,
      source: "local-cache",
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/admin/catalog/mode", requireAdmin, (req, res) => {
  const mode = String(req.body?.mode || "").trim();

  if (!["all", "curated"].includes(mode)) {
    return res.status(400).json({
      ok: false,
      error: "mode must be all or curated"
    });
  }

  storeSettings.catalogMode = mode;
  void saveStoreSettingsNow();

  res.json({
    ok: true,
    catalogMode: storeSettings.catalogMode
  });
});

app.post("/api/admin/catalog/publish", requireAdmin, (req, res) => {
  const productId = String(req.body?.productId || "").trim();

  if (!productId) {
    return res.status(400).json({
      ok: false,
      error: "productId is required"
    });
  }

  storeSettings.hiddenIds = storeSettings.hiddenIds.filter(id => id !== productId);

  if (!storeSettings.publishedIds.includes(productId)) {
    storeSettings.publishedIds.push(productId);
  }

  void saveStoreSettingsNow();

  res.json({
    ok: true,
    productId,
    published: true
  });
  }

  storeSettings.hiddenIds = storeSettings.hiddenIds.filter(id => id !== productId);

  if (!storeSettings.publishedIds.includes(productId)) {
    storeSettings.publishedIds.push(productId);
  }

  void saveStoreSettingsNow();

  res.json({
    ok: true,
    productId,
    published: true
  });
});

app.post("/api/admin/catalog/unpublish", requireAdmin, (req, res) => {
  const productId = String(req.body?.productId || "").trim();

  if (!productId) {
    return res.status(400).json({
      ok: false,
      error: "productId is required"
    });
  }

  storeSettings.publishedIds = storeSettings.publishedIds.filter(id => id !== productId);
  storeSettings.hiddenIds = Array.from(
    new Set([...storeSettings.hiddenIds, productId])
  );

  void saveStoreSettingsNow();

  res.json({
    ok: true,
    productId,
    published: false
  });
});

app.post("/api/admin/catalog/discount", requireAdmin, (req, res) => {
  const productId = String(req.body?.productId || "").trim();
  const discount = normalizeDiscount(req.body?.discount);

  if (!productId) {
    return res.status(400).json({
      ok: false,
      error: "productId is required"
    });
  }

  if (!discount) {
    return res.status(400).json({
      ok: false,
      error: "Invalid discount"
    });
  }

  storeSettings.discounts[productId] = discount;
  void saveStoreSettingsNow();

  res.json({
    ok: true,
    productId,
    discount
  });
});

app.delete("/api/admin/catalog/discount/:productId", requireAdmin, (req, res) => {
  const productId = String(req.params.productId || "").trim();

  delete storeSettings.discounts[productId];
  void saveStoreSettingsNow();

  res.json({
    ok: true,
    productId,
    discount: null
  });
});

// ======================================================
// لوحة الإدارة — لا تحتاج ملف HTML منفصل
// ======================================================

app.get("/admin", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ABESHA STORE — الإدارة</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#071426;color:#eef5ff}
header{padding:18px 16px;background:#0b1f3a;border-bottom:1px solid #1d416e;position:sticky;top:0;z-index:5}
h1{margin:0 0 6px;font-size:22px}.muted{color:#9fb3cc;font-size:13px}
.wrap{max-width:1200px;margin:auto;padding:16px}
.panel{background:#0b1f3a;border:1px solid #1d416e;border-radius:14px;padding:14px;margin-bottom:14px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
input,select,button{font:inherit;border-radius:9px;border:1px solid #31577f;padding:10px}
input,select{background:#071426;color:#fff;min-width:180px}button{background:#123866;color:#fff;cursor:pointer}
button.primary{background:#1769aa}button.danger{background:#7d2633}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:#071426;border-radius:10px;padding:12px}.num{font-size:22px;font-weight:bold;margin-top:5px}
#products{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:#0b1f3a;border:1px solid #1d416e;border-radius:12px;padding:13px}
.card h3{font-size:15px;margin:0 0 8px;line-height:1.4}.price{font-size:19px;font-weight:bold}
.badge{display:inline-block;padding:4px 7px;border-radius:7px;background:#123866;color:#cfe6ff;font-size:11px;margin:2px}
.actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
.small{font-size:12px;color:#a9bdd3}.discount{color:#ffd36b}
.hidden{display:none}
</style>
</head>
<body>
<header>
  <div class="wrap" style="padding:0">
    <h1>ABESHA STORE — لوحة الإدارة</h1>
    <div class="muted">إدارة المنتجات، النشر، الأسعار والعروض</div>
  </div>
</header>
<main class="wrap">
  <section class="panel">
    <div class="row">
      <input id="key" type="password" placeholder="ADMIN_KEY">
      <button class="primary" onclick="loadAll()">دخول وتحميل الكتالوج</button>
      <select id="mode" onchange="changeMode()">
        <option value="all">عرض كل المنتجات الحالية</option>
        <option value="curated">عرض المنتجات التي أختارها فقط</option>
      </select>
    </div>
    <div id="msg" class="muted" style="margin-top:9px"></div>
  </section>

  <section class="panel">
    <div class="stats">
      <div class="stat">إجمالي الكتالوج<div class="num" id="total">—</div></div>
      <div class="stat">المنشور<div class="num" id="published">—</div></div>
      <div class="stat">المخفي<div class="num" id="hidden">—</div></div>
      <div class="stat">عروض نشطة<div class="num" id="discounts">—</div></div>
    </div>
  </section>

  <section class="panel">
    <div class="row">
      <input id="search" placeholder="ابحث باسم المنتج..." oninput="render()">
      <select id="type" onchange="render()">
        <option value="">كل الأقسام</option>
        <option value="topup">Topups</option>
        <option value="gift_card">Gift Cards</option>
        <option value="game_key">Game Keys</option>
        <option value="steam">Steam</option>
        <option value="subscription">Subscriptions</option>
      </select>
      <select id="publishedFilter" onchange="render()">
        <option value="">الكل</option>
        <option value="published">منشور</option>
        <option value="hidden">مخفي</option>
      </select>
    </div>
  </section>

  <section id="products"></section>
</main>

<script>
let catalog = [];
let settings = null;

function headers() {
  return {
    "Content-Type": "application/json",
    "x-admin-key": document.getElementById("key").value.trim()
  };
}

function msg(text, error = false) {
  const el = document.getElementById("msg");
  el.textContent = text || "";
  el.style.color = error ? "#ff9d9d" : "";
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers(),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function loadAll() {
  try {
    msg("جاري تحميل الكتالوج...");
    const data = await api("/api/admin/catalog");
    catalog = Array.isArray(data.products) ? data.products : [];
    settings = data.settings || {};
    document.getElementById("mode").value = settings.catalogMode || "all";
    updateStats();
    render();
    msg("تم تحميل الكتالوج بنجاح");
  } catch (error) {
    msg(error.message, true);
  }
}

function updateStats() {
  const published = catalog.filter(x => x.published).length;
  const hidden = catalog.filter(x => !x.published).length;
  const discounts = catalog.filter(x => x.discount && x.discount.active !== false).length;

  document.getElementById("total").textContent = catalog.length;
  document.getElementById("published").textContent = published;
  document.getElementById("hidden").textContent = hidden;
  document.getElementById("discounts").textContent = discounts;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") + " SDG" : "—";
}

function render() {
  const root = document.getElementById("products");
  const q = document.getElementById("search").value.trim().toLowerCase();
  const type = document.getElementById("type").value;
  const publishedFilter = document.getElementById("publishedFilter").value;

  const filtered = catalog.filter(product => {
    if (q && !String(product.name || "").toLowerCase().includes(q)) return false;
    if (type && product.type !== type && product.store_category !== type) return false;
    if (publishedFilter === "published" && !product.published) return false;
    if (publishedFilter === "hidden" && product.published) return false;
    return true;
  });

  root.innerHTML = filtered.map(product => {
    const discount = product.discount;
    const hasDiscount = discount && discount.active !== false;

    return `
      <article class="card">
        <h3>${esc(product.name)}</h3>
        <div>
          <span class="badge">${esc(product.type || "")}</span>
          <span class="badge">${esc(product.store_category || "")}</span>
          ${
            product.published
              ? '<span class="badge">منشور</span>'
              : '<span class="badge">مخفي</span>'
          }
        </div>

        <div style="margin-top:10px">
          <div class="price">${money(product.price_sdg)}</div>
          ${
            hasDiscount
              ? `<div class="small discount">عرض: ${esc(discount.label || "عرض خاص")}</div>`
              : ""
          }
        </div>

        <div class="small" style="margin-top:7px">
          ID: ${esc(product.id)}
        </div>

        <div class="actions">
          ${
            product.published
              ? `<button class="danger" onclick="unpublish('${encodeURIComponent(product.id)}')">إخفاء</button>`
              : `<button class="primary" onclick="publish('${encodeURIComponent(product.id)}')">نشر</button>`
          }
          <button onclick="setDiscount('${encodeURIComponent(product.id)}')">خصم</button>
          ${
            hasDiscount
              ? `<button onclick="removeDiscount('${encodeURIComponent(product.id)}')">إلغاء الخصم</button>`
              : ""
          }
        </div>
      </article>
    `;
  }).join("");

  if (!filtered.length) {
    root.innerHTML = '<section class="panel"><div class="muted">لا توجد نتائج</div></section>';
  }
}

async function publish(id) {
  try {
    await api("/api/admin/catalog/publish", {
      method: "POST",
      body: JSON.stringify({ productId: decodeURIComponent(id) })
    });
    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}

async function unpublish(id) {
  try {
    await api("/api/admin/catalog/unpublish", {
      method: "POST",
      body: JSON.stringify({ productId: decodeURIComponent(id) })
    });
    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}

async function setDiscount(id) {
  const productId = decodeURIComponent(id);
  const type = prompt("نوع الخصم: percent أو fixed", "percent");
  if (!type) return;

  const value = prompt(
    type === "fixed"
      ? "قيمة الخصم بالجنيه السوداني"
      : "نسبة الخصم",
    "5"
  );

  if (!value) return;

  const label = prompt("اسم العرض", "عرض خاص") || "عرض خاص";

  try {
    await api("/api/admin/catalog/discount", {
      method: "POST",
      body: JSON.stringify({
        productId,
        discount: {
          type,
          value: Number(value),
          label,
          active: true
        }
      })
    });

    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}

async function removeDiscount(id) {
  try {
    await api(
      "/api/admin/catalog/discount/" + encodeURIComponent(decodeURIComponent(id)),
      { method: "DELETE" }
    );
    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}

async function changeMode() {
  const mode = document.getElementById("mode").value;

  try {
    await api("/api/admin/catalog/mode", {
      method: "POST",
      body: JSON.stringify({ mode })
    });
    await loadAll();
  } catch (error) {
    msg(error.message, true);
  }
}
</script>
</body>
</html>`);
});

// ======================================================
// Customer Authentication
// ======================================================

app.get("/api/auth/me", async (req, res) => {
  try {
    const customer = await getCurrentCustomer(req);
    if (!customer) {
      return res.json({
        ok: true,
        authenticated: false,
        customer: null
      });
    }

    res.json({
      ok: true,
      authenticated: true,
      customer
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: "Authentication service unavailable"
    });
  }
});

app.post("/api/auth/register", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    if (authRateLimited(req)) {
      return res.status(429).json({
        ok: false,
        error: "Too many attempts. Please try again later."
      });
    }

    const name = cleanName(req.body?.name);
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");

    if (name.length < 2) {
      return res.status(400).json({
        ok: false,
        error: "Please enter a valid name"
      });
    }

    if (phone.length < 8) {
      return res.status(400).json({
        ok: false,
        error: "Please enter a valid phone number"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Password must be at least 6 characters"
      });
    }

    const existing = await dbPool.query(
      "SELECT id FROM customers WHERE phone = $1 LIMIT 1",
      [phone]
    );

    if (existing.rows[0]) {
      return res.status(409).json({
        ok: false,
        error: "This phone number is already registered"
      });
    }

    const passwordData = await hashPassword(password);

    const result = await dbPool.query(`
      INSERT INTO customers (
        name,
        phone,
        password_hash,
        password_salt
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, phone
    `, [
      name,
      phone,
      passwordData.hash,
      passwordData.salt
    ]);

    const customer = result.rows[0];

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashSessionToken(token);

    await dbPool.query(`
      INSERT INTO sessions (
        customer_id,
        token_hash,
        expires_at
      )
      VALUES ($1, $2, NOW() + INTERVAL '30 days')
    `, [customer.id, tokenHash]);

    setSessionCookie(res, token);

    res.status(201).json({
      ok: true,
      authenticated: true,
      customer
    });
  } catch (error) {
    console.error("[AUTH] Registration failed:", error.message);
    res.status(500).json({
      ok: false,
      error: "Could not create account"
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    if (authRateLimited(req)) {
      return res.status(429).json({
        ok: false,
        error: "Too many attempts. Please try again later."
      });
    }

    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");

    if (phone.length < 8 || !password) {
      return res.status(400).json({
        ok: false,
        error: "Phone and password are required"
      });
    }

    const result = await dbPool.query(`
      SELECT id, name, phone, password_hash, password_salt
      FROM customers
      WHERE phone = $1
      LIMIT 1
    `, [phone]);

    const customer = result.rows[0];

    if (!customer) {
      return res.status(401).json({
        ok: false,
        error: "Invalid phone or password"
      });
    }

    const valid = await verifyPassword(
      password,
      customer.password_hash,
      customer.password_salt
    );

    if (!valid) {
      return res.status(401).json({
        ok: false,
        error: "Invalid phone or password"
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashSessionToken(token);

    await dbPool.query(`
      INSERT INTO sessions (
        customer_id,
        token_hash,
        expires_at
      )
      VALUES ($1, $2, NOW() + INTERVAL '30 days')
    `, [customer.id, tokenHash]);

    setSessionCookie(res, token);

    res.json({
      ok: true,
      authenticated: true,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone
      }
    });
  } catch (error) {
    console.error("[AUTH] Login failed:", error.message);
    res.status(500).json({
      ok: false,
      error: "Could not login"
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];

    if (dbPool && token) {
      await dbPool.query(
        "DELETE FROM sessions WHERE token_hash = $1",
        [hashSessionToken(token)]
      );
    }

    clearSessionCookie(res);

    res.json({
      ok: true,
      authenticated: false
    });
  } catch (error) {
    clearSessionCookie(res);
    res.json({
      ok: true,
      authenticated: false
    });
  }
});

// ======================================================
// Customer Orders
// ======================================================

function makeOrderNumber() {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);

  const random = crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();

  return `ABS-${stamp}-${random}`;
}

function normalizeOrderItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map(item => {
      const quantity = Math.max(
        1,
        Math.min(100, Number.parseInt(item?.quantity, 10) || 1)
      );

      return {
        productId: String(item?.productId || item?.id || "").slice(0, 200),
        productName: String(item?.productName || item?.name || "").trim().slice(0, 500),
        quantity,
        fields: item?.fields && typeof item.fields === "object"
          ? item.fields
          : {}
      };
    })
    .filter(item => item.productId && item.productName);
}

async function buildOrderFromCatalog(customer, rawItems, paymentMethod) {
  const products = await getPricedCatalog();
  const productMap = new Map(
    products
      .filter(productVisibility)
      .filter(product => Number(product.price_sdg) > 0)
      .map(product => [String(product.id), product])
  );

  const items = normalizeOrderItems(rawItems);

  if (!items.length) {
    const error = new Error("Order must contain at least one product");
    error.status = 400;
    throw error;
  }

  const normalized = [];

  for (const item of items) {
    const product = productMap.get(item.productId);

    if (!product) {
      const error = new Error(`Product unavailable: ${item.productId}`);
      error.status = 400;
      throw error;
    }

    const enriched = enrichProductForStore(product);
    const unitPrice = Number(enriched.price_sdg);

    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      const error = new Error(`Product has no valid price: ${item.productName}`);
      error.status = 400;
      throw error;
    }

    normalized.push({
      productId: String(product.id),
      productName: String(enriched.name || item.productName),
      quantity: item.quantity,
      unitPrice,
      fields: item.fields || {}
    });
  }

  const total = normalized.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0
  );

  return {
    paymentMethod: String(paymentMethod || "bankak").trim().toLowerCase(),
    items: normalized,
    total
  };
}

app.post("/api/orders", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;

  const client = await dbPool.connect();

  try {
    const { paymentMethod, items } = await buildOrderFromCatalog(
      req.customer,
      req.body?.items,
      req.body?.paymentMethod
    );

    const allowedPayments = ["bankak", "mycashi"];

    if (!allowedPayments.includes(paymentMethod)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid payment method"
      });
    }

    const orderNumber = makeOrderNumber();

    await client.query("BEGIN");

    const orderResult = await client.query(`
      INSERT INTO orders (
        order_number,
        customer_id,
        customer_name,
        customer_phone,
        status,
        payment_method,
        payment_status,
        total_sdg
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'PENDING_PAYMENT',
        $5,
        'PENDING',
        $6
      )
      RETURNING id, order_number, status, payment_method, payment_status, total_sdg, created_at
    `, [
      orderNumber,
      req.customer.id,
      req.customer.name,
      req.customer.phone,
      paymentMethod,
      total
    ]);

    const order = orderResult.rows[0];

    for (const item of items) {
      await client.query(`
        INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          quantity,
          unit_price_sdg,
          fields_json
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `, [
        order.id,
        item.productId,
        item.productName,
        item.quantity,
        item.unitPrice,
        JSON.stringify(item.fields || {})
      ]);
    }

    await client.query("COMMIT");

    res.status(201).json({
      ok: true,
      order: {
        ...order,
        total_sdg: Number(order.total_sdg),
        items
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[ORDERS] Create order failed:", error.message);
    res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Could not create order"
    });
  } finally {
    client.release();
  }
});

app.get("/api/customer/orders", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const result = await dbPool.query(`
      SELECT
        o.id,
        o.order_number,
        o.status,
        o.payment_method,
        o.payment_status,
        o.total_sdg,
        o.created_at,
        o.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'productId', oi.product_id,
              'productName', oi.product_name,
              'quantity', oi.quantity,
              'unitPrice', oi.unit_price_sdg,
              'fields', oi.fields_json
            )
            ORDER BY oi.id
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.customer_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 100
    `, [req.customer.id]);

    res.json({
      ok: true,
      orders: result.rows.map(order => ({
        ...order,
        total_sdg: Number(order.total_sdg),
        items: Array.isArray(order.items) ? order.items.map(item => ({
          ...item,
          unitPrice: Number(item.unitPrice)
        })) : []
      }))
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not load orders"
    });
  }
});

app.get("/api/orders/:orderNumber", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const orderResult = await dbPool.query(`
      SELECT
        id,
        order_number,
        status,
        payment_method,
        payment_status,
        payment_reference,
        total_sdg,
        created_at,
        updated_at
      FROM orders
      WHERE order_number = $1
        AND customer_id = $2
      LIMIT 1
    `, [
      String(req.params.orderNumber),
      req.customer.id
    ]);

    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    const itemsResult = await dbPool.query(`
      SELECT
        product_id,
        product_name,
        quantity,
        unit_price_sdg,
        fields_json
      FROM order_items
      WHERE order_id = $1
      ORDER BY id
    `, [order.id]);

    res.json({
      ok: true,
      order: {
        ...order,
        total_sdg: Number(order.total_sdg),
        items: itemsResult.rows.map(item => ({
          productId: item.product_id,
          productName: item.product_name,
          quantity: item.quantity,
          unitPrice: Number(item.unit_price_sdg),
          fields: item.fields_json || {}
        }))
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not load order"
    });
  }
});

app.post("/api/customer/reorder", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const orderNumber = String(req.body?.orderNumber || "").trim();

    if (!orderNumber) {
      return res.status(400).json({
        ok: false,
        error: "orderNumber is required"
      });
    }

    const result = await dbPool.query(`
      SELECT
        oi.product_id,
        oi.product_name,
        oi.quantity,
        oi.fields_json
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.order_number = $1
        AND o.customer_id = $2
      ORDER BY oi.id
    `, [orderNumber, req.customer.id]);

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    const products = await getPricedCatalog();
    const productMap = new Map(
      products
        .filter(productVisibility)
        .filter(product => Number(product.price_sdg) > 0)
        .map(product => [String(product.id), product])
    );

    const items = [];

    for (const row of result.rows) {
      const product = productMap.get(String(row.product_id));
      if (!product) continue;

      items.push({
        productId: String(product.id),
        productName: String(product.name || row.product_name),
        quantity: Math.max(1, Number(row.quantity) || 1),
        fields: row.fields_json || {}
      });
    }

    res.json({
      ok: true,
      items
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not prepare reorder"
    });
  }
});

// ======================================================
// Admin Orders
// ======================================================

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const status = String(req.query.status || "").trim();

    const params = [];
    let where = "";

    if (status) {
      params.push(status);
      where = `WHERE o.status = $${params.length}`;
    }

    const result = await dbPool.query(`
      SELECT
        o.id,
        o.order_number,
        o.customer_name,
        o.customer_phone,
        o.status,
        o.payment_method,
        o.payment_status,
        o.payment_reference,
        o.total_sdg,
        o.created_at,
        o.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'productId', oi.product_id,
              'productName', oi.product_name,
              'quantity', oi.quantity,
              'unitPrice', oi.unit_price_sdg,
              'fields', oi.fields_json
            )
            ORDER BY oi.id
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'::json
        ) AS items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${where}
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 500
    `, params);

    res.json({
      ok: true,
      orders: result.rows.map(order => ({
        ...order,
        total_sdg: Number(order.total_sdg),
        items: Array.isArray(order.items) ? order.items.map(item => ({
          ...item,
          unitPrice: Number(item.unitPrice)
        })) : []
      }))
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not load admin orders"
    });
  }
});

app.post("/api/admin/orders/:orderNumber/confirm-payment", requireAdmin, async (req, res) => {
  if (!requireDatabase(res)) return;

  try {
    const orderNumber = String(req.params.orderNumber || "").trim();
    const paymentReference = String(
      req.body?.paymentReference ||
      req.body?.reference ||
      ""
    ).trim().slice(0, 120);

    if (!orderNumber) {
      return res.status(400).json({
        ok: false,
        error: "orderNumber is required"
      });
    }

    const result = await dbPool.query(`
      UPDATE orders
      SET
        status = 'PAID',
        payment_status = 'CONFIRMED',
        payment_reference = $1,
        updated_at = NOW()
      WHERE order_number = $2
      RETURNING
        id,
        order_number,
        customer_id,
        customer_name,
        customer_phone,
        status,
        payment_method,
        payment_status,
        payment_reference,
        total_sdg,
        created_at,
        updated_at
    `, [paymentReference || null, orderNumber]);

    const order = result.rows[0];

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    res.json({
      ok: true,
      order: {
        ...order,
        total_sdg: Number(order.total_sdg)
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Could not confirm payment"
    });
  }
});

// ======================================================
// Root
// ======================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ======================================================
// بدء التشغيل
// ======================================================

async function startServer() {
  try {
    await initDatabase();

    // Database is the primary persistent source when available.
    // Disk files remain as a fallback for local/development deployments.
    await loadStoreSettingsFromDatabase();

    const loadedFromDb = await loadPriceCacheFromDatabase();

    if (!loadedFromDb) {
      loadPriceCacheFromDisk();
    }

    if (!cacheIsAvailable()) {
      console.log("[PRICE CACHE] No local/database catalog cache found.");
      console.log("[PRICE CACHE] Building catalog from Fazer once at startup...");

      try {
        await buildPricedCatalog();
      } catch (error) {
        console.error("[PRICE CACHE] Initial catalog build failed:", error.message);
      }
    } else {
      console.log(
        `[PRICE CACHE] Using cached catalog with ${pricedCatalogCache.length} products`
      );
    }

    app.listen(PORT, () => {
      console.log(`ABESHA STORE running on port ${PORT}`);
      console.log(`Pricing USD/SDG: ${getPricingConfig().usdToSdg}`);
      console.log(`Catalog cache: ${pricedCatalogCache?.length || 0} products`);
      console.log(`Database: ${dbPool ? "enabled" : "disabled"}`);
    });
  } catch (error) {
    console.error("[STARTUP] Fatal error:", error);
    process.exit(1);
  }
}

startServer();