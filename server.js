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
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

const scryptAsync = promisify(crypto.scrypt);
const SESSION_COOKIE = "abeshasid";
const SESSION_DAYS = 30;
const SESSION_TTL_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const authAttempts = new Map();

// تنظيف دوري للذاكرة لمنع تسريب الذاكرة من محاولات تسجيل الدخول
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of authAttempts.entries()) {
    if (now > record.resetAt) {
      authAttempts.delete(key);
    }
  }
}, 15 * 60 * 1000);

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

// ======================================================
// ABESHA STORE — التسعير المركزي
// ======================================================

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PRICE_CACHE_VERSION = 5;
const PRICE_CACHE_FILE = path.join(__dirname, "pricing-cache.json");
const STORE_SETTINGS_FILE = path.join(__dirname, "store-settings.json");
const STORE_SETTINGS_VERSION = 1;

let pricedCatalogCache = null;
let pricedCatalogBuiltAt = 0;
let priceRefreshPromise = null;

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
      const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

      const response = await fetch(`${FAZER_API}${normalizedEndpoint}`, {
        ...options,
        method: options.method || "GET",
        headers: fazerHeaders(options.headers || {}),
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

      const error = new Error(data?.message || data?.error || `Fazer API HTTP ${response.status}`);
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
        waitMs = Math.min(15000, baseDelayMs * (2 ** attempt)) + Math.floor(Math.random() * 400);
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
  return fazerFetch(endpoint, { method: "GET", timeoutMs });
}

async function getAllCategories(endpoint) {
  const items = [];
  let cursor = null;

  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams();
    params.set("limit", "50");

    if (cursor) {
      params.set("cursor", cursor);
    }

    const data = await fazerGet(`${endpoint}?${params.toString()}`);
    const pageItems = getArray(data, ["items", "categories", "games"]);

    if (pageItems.length) {
      items.push(...pageItems);
    }

    const nextCursor = data?.meta?.next_cursor || data?.next_cursor || data?.pagination?.next_cursor || null;

    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return items;
}

function getArray(data, keys = ["items", "offers", "cards"]) {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  if (Array.isArray(data?.data?.offers)) return data.data.offers;
  if (Array.isArray(data?.data?.cards)) return data.data.cards;
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

function offerPriceUsd(offer) {
  const candidates = [
    offer?.price_usd, offer?.priceUSD, offer?.usd_price,
    offer?.cost_usd, offer?.costUSD, offer?.price
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function offerLabel(offer) {
  return String(
    offer?.name || offer?.title || offer?.description ||
    offer?.product_name || offer?.productName || offer?.amount ||
    offer?.quantity || offer?.denomination || "عرض"
  ).trim();
}

function offerUniqueId(offer, index) {
  return String(offer?.id || offer?.offer_id || offer?.offerId || offer?.sku || offer?.code || `${index}`);
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

function loadStoreSettings() {
  try {
    if (!fs.existsSync(STORE_SETTINGS_FILE)) {
      const settings = cloneDefaultStoreSettings();
      saveStoreSettings(settings);
      return settings;
    }

    const parsed = JSON.parse(fs.readFileSync(STORE_SETTINGS_FILE, "utf8"));
    const defaults = cloneDefaultStoreSettings();
    const pricing = parsed.pricing && typeof parsed.pricing === "object" ? parsed.pricing : {};

    const tiers = Array.isArray(pricing.tiers) && pricing.tiers.length === 4
      ? pricing.tiers.map((tier) => ({
          maxCost: tier.maxCost == null ? null : Number(tier.maxCost),
          markup: Number(tier.markup)
        })).filter(t => Number.isFinite(t.markup) && t.markup >= 0)
      : defaults.pricing.tiers;

    return {
      ...defaults,
      ...parsed,
      publishedIds: Array.isArray(parsed.publishedIds) ? parsed.publishedIds : [],
      hiddenIds: Array.isArray(parsed.hiddenIds) ? parsed.hiddenIds : [],
      discounts: parsed.discounts && typeof parsed.discounts === "object" ? parsed.discounts : {},
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
  } catch (error) {
    console.warn("[STORE SETTINGS] Could not load settings:", error.message);
    return cloneDefaultStoreSettings();
  }
}

function saveStoreSettings(settings) {
  try {
    fs.writeFileSync(STORE_SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    console.warn("[STORE SETTINGS] Could not save settings:", error.message);
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

  return { type, value, startsAt, endsAt, active, label: String(raw.label || "عرض خاص").trim().slice(0, 100) };
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
    return { price: basePrice, originalPrice: null, discount: null };
  }

  let sale = discount.type === "fixed" ? base - Number(discount.value) : base * (1 - Number(discount.value) / 100);
  sale = roundCommercialPrice(Math.max(100, sale));

  if (!sale || sale >= base) {
    return { price: basePrice, originalPrice: null, discount: null };
  }

  return { price: sale, originalPrice: base, discount };
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
    product.description, product.platform, product.region, product.tags
  ].flat().filter(Boolean).join(" ").toLowerCase();

  if (family === "steam" || type === "steam" || /\bsteam\b/.test(raw)) return "steam";

  const subscriptionSignals = [
    "subscription", "membership", "netflix", "spotify", "game pass",
    "playstation plus", "ps plus", "apple music", "youtube premium",
    "crunchyroll", "discord nitro"
  ];
  if (subscriptionSignals.some(x => raw.includes(x))) return "subscription";

  if (family === "giftcard" || type === "giftcard") return "gift";
  if (family === "topup" || type === "topup") return "mobile";
  if (family === "gamekey" || type === "gamekey") return "game";

  if (/\b(pubg|free fire|roblox|valorant|mobile legends)\b/.test(raw)) return "mobile";
  if (/gift card|giftcard|google play|apple gift|playstation|xbox/.test(raw)) return "gift";
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

  delete result.source_price_usd;
  delete result.cost_sdg;
  delete result.markup_percent;
  delete result.price_usd;
  delete result.offer;

  return result;
}

function getAdminProduct(product) {
  const discount = storeSettings.discounts[String(product.id)] || null;
  return { ...product, published: productVisibility(product), discount };
}

function getPublicProducts(products) {
  return products.filter(productVisibility).filter(product => Number(product.price_sdg) > 0).map(enrichProductForStore);
}

function saveStoreSettingsNow() {
  storeSettings.version = STORE_SETTINGS_VERSION;
  saveStoreSettings(storeSettings);
}

// ======================================================
// Cache الأسعار
// ======================================================

function loadPriceCacheFromDisk() {
  try {
    if (!fs.existsSync(PRICE_CACHE_FILE)) return;
    const raw = fs.readFileSync(PRICE_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (parsed && parsed.version === PRICE_CACHE_VERSION && Array.isArray(parsed.products) && Number.isFinite(parsed.builtAt)) {
      pricedCatalogCache = parsed.products;
      pricedCatalogBuiltAt = parsed.builtAt;
      console.log(`[PRICE CACHE] Loaded ${pricedCatalogCache.length} products from disk`);
    }
  } catch (error) {
    console.warn("[PRICE CACHE] Could not load cache:", error.message);
  }
}

function savePriceCacheToDisk(products) {
  try {
    fs.writeFileSync(PRICE_CACHE_FILE, JSON.stringify({
      version: PRICE_CACHE_VERSION,
      builtAt: Date.now(),
      usdToSdg: getPricingConfig().usdToSdg,
      products
    }, null, 2), "utf8");
  } catch (error) {
    console.warn("[PRICE CACHE] Could not save cache:", error.message);
  }
}

function cacheIsFresh() {
  return Array.isArray(pricedCatalogCache) && pricedCatalogCache.length > 0 && (Date.now() - pricedCatalogBuiltAt < CACHE_TTL_MS);
}

async function mapWithConcurrency(items, worker, concurrency = 2) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { __error: true, error: error.message };
      }
    }
  }

  const count = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: count }, () => runner()));
  return results;
}

// ======================================================
// بناء الكتالوج المسعّر
// ======================================================

async function getTopupOffers(categoryId) {
  const data = await fazerGet(`/topups/offers?category_id=${encodeURIComponent(categoryId)}`, 30000);
  return getArray(data, ["items", "offers"]);
}

async function getGiftcardOffers(categoryId) {
  const data = await fazerGet(`/giftcards/cards?category_id=${encodeURIComponent(categoryId)}`, 30000);
  return getArray(data, ["items", "cards", "offers"]);
}

async function getGameKeyOffers(gameId) {
  const data = await fazerGet(`/gamekeys/keys?game_id=${encodeURIComponent(gameId)}`, 30000);
  return getArray(data, ["keys", "items", "offers"]);
}

async function buildPricedCatalog() {
  console.log("[PRICE CACHE] Building complete priced catalog...");

  const familyResults = [];
  for (const family of ["topups", "giftcards", "gamekeys"]) {
    try {
      familyResults.push({ status: "fulfilled", value: await getAllCategories(family) });
    } catch (error) {
      familyResults.push({ status: "rejected", reason: error });
      console.warn(`[PRICE] ${family} catalog unavailable: ${error.message}`);
    }
  }

  const topups = familyResults[0].status === "fulfilled" ? familyResults[0].value : [];
  const giftcards = familyResults[1].status === "fulfilled" ? familyResults[1].value : [];
  const gamekeys = familyResults[2].status === "fulfilled" ? familyResults[2].value : [];

  const products = [];

  const topupResults = await mapWithConcurrency(topups, async category => {
    const categoryId = String(category.category_id || category.id || "");
    const categoryName = String(category.name || category.title || categoryId);
    try {
      const offers = await getTopupOffers(categoryId);
      return offers.map((offer, index) => {
        const label = offerLabel(offer);
        const priceUsd = offerPriceUsd(offer);
        const calculatedPrice = calculateSalePrice(priceUsd);
        return {
          id: `${categoryId}__offer__${offerUniqueId(offer, index)}`,
          category_id: categoryId,
          name: label === "عرض" ? categoryName : `${categoryName} — ${label}`,
          base_name: categoryName,
          type: "topup",
          note: category.note || "",
          fields: category.fields || [],
          price_usd: frontendCompatibleUsd(calculatedPrice),
          source_price_usd: priceUsd,
          cost_sdg: priceUsd ? Math.round(priceUsd * getPricingConfig().usdToSdg) : null,
          markup_percent: priceUsd ? getMarkupForCost(priceUsd * getPricingConfig().usdToSdg) * 100 : null,
          price_sdg: calculatedPrice,
          pricing_mode: "automatic",
          offer
        };
      });
    } catch (error) {
      return [{ id: categoryId, category_id: categoryId, name: categoryName, type: "topup", fields: category.fields || [], price_sdg: null, pricing_mode: "unavailable" }];
    }
  }, 2);

  for (const result of topupResults) {
    if (Array.isArray(result)) products.push(...result);
  }

  const giftcardResults = await mapWithConcurrency(giftcards, async category => {
    const categoryId = String(category.category_id || category.id || "");
    const categoryName = String(category.name || category.title || categoryId);
    try {
      const offers = await getGiftcardOffers(categoryId);
      return offers.map((offer, index) => {
        const label = offerLabel(offer);
        const priceUsd = offerPriceUsd(offer);
        const calculatedPrice = calculateSalePrice(priceUsd);
        return {
          id: `${categoryId}__card__${offerUniqueId(offer, index)}`,
          category_id: categoryId,
          name: label === "عرض" ? categoryName : `${categoryName} — ${label}`,
          base_name: categoryName,
          type: "gift_card",
          note: category.note || "",
          fields: category.fields || [],
          price_usd: frontendCompatibleUsd(calculatedPrice),
          source_price_usd: priceUsd,
          cost_sdg: priceUsd ? Math.round(priceUsd * getPricingConfig().usdToSdg) : null,
          markup_percent: priceUsd ? getMarkupForCost(priceUsd * getPricingConfig().usdToSdg) * 100 : null,
          price_sdg: calculatedPrice,
          pricing_mode: "automatic",
          stock: offer?.stock ?? null,
          offer
        };
      });
    } catch (error) {
      return [{ id: categoryId, category_id: categoryId, name: categoryName, type: "gift_card", fields: category.fields || [], price_sdg: null, pricing_mode: "unavailable" }];
    }
  }, 2);

  for (const result of giftcardResults) {
    if (Array.isArray(result)) products.push(...result);
  }

  const gameKeyResults = await mapWithConcurrency(gamekeys, async game => {
    const gameId = String(game.game_id || game.category_id || game.id || "");
    const gameName = String(game.name || game.GameName || gameId);
    try {
      const keys = await getGameKeyOffers(gameId);
      return keys.map((key, index) => {
        const priceUsd = offerPriceUsd(key);
        const calculatedPrice = calculateSalePrice(priceUsd);
        const label = offerLabel(key);
        return {
          id: `${gameId}__key__${offerUniqueId(key, index)}`,
          category_id: gameId,
          name: label === "عرض" ? gameName : `${gameName} — ${label}`,
          base_name: gameName,
          type: "game_key",
          platform: game.platform || "",
          region: game.region || "",
          price_usd: frontendCompatibleUsd(calculatedPrice),
          source_price_usd: priceUsd,
          cost_sdg: priceUsd ? Math.round(priceUsd * getPricingConfig().usdToSdg) : null,
          markup_percent: priceUsd ? getMarkupForCost(priceUsd * getPricingConfig().usdToSdg) * 100 : null,
          price_sdg: calculatedPrice,
          pricing_mode: "automatic",
          stock: key?.stock ?? null,
          offer: key
        };
      });
    } catch (error) {
      return [{ id: gameId, category_id: gameId, name: gameName, type: "game_key", price_sdg: null, pricing_mode: "unavailable" }];
    }
  }, 2);

  for (const result of gameKeyResults) {
    if (Array.isArray(result)) products.push(...result);
  }

  for (const product of products) {
    if (Number(product.price_sdg) > 0) {
      product.store_category = classifyStoreCategory(product);
    }
  }

  pricedCatalogCache = products;
  pricedCatalogBuiltAt = Date.now();
  savePriceCacheToDisk(products);
  return products;
}

async function getPricedCatalog() {
  if (cacheIsFresh()) return pricedCatalogCache;
  if (priceRefreshPromise) return priceRefreshPromise;

  priceRefreshPromise = buildPricedCatalog()
    .catch(error => {
      console.error("[PRICE CACHE] Build failed:", error.message);
      if (Array.isArray(pricedCatalogCache) && pricedCatalogCache.length) return pricedCatalogCache;
      throw error;
    })
    .finally(() => { priceRefreshPromise = null; });

  return priceRefreshPromise;
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
      cacheFresh: cacheIsFresh(),
      cachedProducts: pricedCatalogCache?.length || 0
    }
  });
});

// ======================================================
// Fazer API Calls & Public Routes
// ======================================================

app.get("/api/fazer/me", async (req, res) => {
  try {
    const data = await fazerGet("/me");
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: "تعذر الاتصال بالمزود." });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const products = await getPricedCatalog();
    const visibleProducts = getPublicProducts(products);
    res.json({ ok: true, total: visibleProducts.length, products: visibleProducts, pricing: { currency: "SDG", catalogMode: storeSettings.catalogMode } });
  } catch (error) {
    console.error("[GET PRODUCTS ERROR]", error);
    res.status(500).json({ ok: false, error: "تعذر تحميل الكتالوج." });
  }
});

app.post("/api/fazer/topups/validate-id", async (req, res) => {
  try {
    const { category_id, fields } = req.body;
    const data = await fazerFetch("/topups/validate-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category_id, fields })
    });
    res.json(data);
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

// ======================================================
// الإدارة Auth Middleware & Routes
// ======================================================

function requireAdmin(req, res, next) {
  const adminKey = req.headers["x-admin-key"];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

app.get("/api/admin/catalog", requireAdmin, async (req, res) => {
  try {
    const data = await getPricedCatalog();
    res.json({
      ok: true,
      total: data.length,
      products: data.map(getAdminProduct),
      settings: storeSettings,
      pricing: getPricingConfig()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "تعذر تحميل لوحة الكتالوج." });
  }
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

    storeSettings.pricing = {
      usdToSdg,
      tiers,
      rounding: { ...getPricingConfig().rounding, ...(body.rounding || {}) }
    };

    saveStoreSettingsNow();
    pricedCatalogCache = null;
    pricedCatalogBuiltAt = 0;
    savePriceCacheToDisk([]);

    const products = await getPricedCatalog();
    res.json({ ok: true, pricing: getPricingConfig(), repricedProducts: products.length, updatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: "تعذر تحديث الأسعار." });
  }
});

// ======================================================
// حسابات العملاء والطلبات — PostgreSQL (محسّنة بدون N+1 Query)
// ======================================================

app.get("/api/auth/me", async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const customer = await getCurrentCustomer(req);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, authenticated: Boolean(customer), customer: customer || null });
  } catch (error) {
    res.status(503).json({ ok: false, error: "Authentication service unavailable" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    if (authRateLimited(req)) return res.status(429).json({ ok: false, error: "محاولات كثيرة. حاول لاحقًا." });

    const name = cleanName(req.body?.name);
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (name.length < 2) return res.status(400).json({ ok: false, error: "الاسم غير صحيح." });
    if (phone.length < 8) return res.status(400).json({ ok: false, error: "رقم واتساب غير صحيح." });
    if (password.length < 8) return res.status(400).json({ ok: false, error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل." });
    if (password !== confirmPassword) return res.status(400).json({ ok: false, error: "تأكيد كلمة المرور غير مطابق." });

    const credentials = await hashPassword(password);
    const created = await dbPool.query(`
      INSERT INTO customers (name, phone, password_hash, password_salt)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, phone
    `, [name, phone, credentials.hash, credentials.salt]);

    const customer = created.rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    await dbPool.query(`
      INSERT INTO sessions (customer_id, token_hash, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '30 days')
    `, [customer.id, hashSessionToken(token)]);

    setSessionCookie(res, token);
    res.status(201).json({ ok: true, customer });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ ok: false, error: "رقم واتساب مسجل بالفعل." });
    console.error("[AUTH REGISTER]", error);
    res.status(500).json({ ok: false, error: "تعذر إنشاء الحساب." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    if (authRateLimited(req)) return res.status(429).json({ ok: false, error: "محاولات كثيرة. حاول لاحقًا." });

    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");
    if (phone.length < 8 || !password) return res.status(401).json({ ok: false, error: "بيانات الدخول غير صحيحة." });

    const result = await dbPool.query(`SELECT id, name, phone, password_hash, password_salt FROM customers WHERE phone = $1 LIMIT 1`, [phone]);
    const row = result.rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash, row.password_salt))) {
      return res.status(401).json({ ok: false, error: "بيانات الدخول غير صحيحة." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    await dbPool.query(`
      INSERT INTO sessions (customer_id, token_hash, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '30 days')
    `, [row.id, hashSessionToken(token)]);

    setSessionCookie(res, token);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, customer: { id: row.id, name: row.name, phone: row.phone } });
  } catch (error) {
    console.error("[AUTH LOGIN]", error);
    res.status(500).json({ ok: false, error: "تعذر تسجيل الدخول." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    if (dbPool) {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (token) await dbPool.query("DELETE FROM sessions WHERE token_hash = $1", [hashSessionToken(token)]);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
  }
});

function cleanOrderFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const out = {};
  for (const [key, value] of Object.entries(fields).slice(0, 12)) {
    out[String(key).slice(0, 60)] = String(value ?? "").slice(0, 300);
  }
  return out;
}

function generateOrderNumber() {
  return `AB-${Date.now().toString(36).toUpperCase().slice(-6)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// إنشاء طلب جديد
app.post("/api/orders", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;
  const client = await dbPool.connect();
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const paymentMethod = String(req.body?.paymentMethod || "").trim();
    const paymentReference = String(req.body?.paymentReference || "").trim().slice(0, 120);

    if (!items.length || items.length > 50) return res.status(400).json({ ok: false, error: "السلة غير صالحة." });
    if (!["Bankak", "MyCashi"].includes(paymentMethod)) return res.status(400).json({ ok: false, error: "طريقة الدفع غير صالحة." });

    const catalog = await getPricedCatalog();
    const byId = new Map(catalog.map(product => [String(product.id), product]));
    const verifiedItems = [];
    let total = 0;

    for (const item of items) {
      const productId = String(item?.productId || "").trim();
      const product = byId.get(productId);
      const quantity = Math.max(1, Math.min(99, Math.floor(Number(item?.quantity || 1))));
      if (!product || !productVisibility(product) || !Number(product.price_sdg)) {
        return res.status(400).json({ ok: false, error: "أحد المنتجات لم يعد متاحًا." });
      }
      const publicProduct = enrichProductForStore(product);
      const unitPrice = Number(publicProduct.price_sdg);
      total += unitPrice * quantity;
      verifiedItems.push({
        productId: String(publicProduct.id),
        name: String(publicProduct.name || "منتج رقمي").slice(0, 500),
        quantity,
        price: unitPrice,
        fields: cleanOrderFields(item?.fields)
      });
    }

    await client.query("BEGIN");
    const orderNumber = generateOrderNumber();
    const orderResult = await client.query(`
      INSERT INTO orders (
        order_number, customer_id, customer_name, customer_phone,
        status, payment_method, payment_status, payment_reference, total_sdg
      ) VALUES ($1, $2, $3, $4, 'PAYMENT_PENDING', $5, 'PENDING', $6, $7)
      RETURNING id, order_number, status, payment_method, total_sdg, created_at
    `, [orderNumber, req.customer.id, req.customer.name, req.customer.phone, paymentMethod, paymentReference || null, total]);

    for (const item of verifiedItems) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price_sdg, fields_json)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `, [orderResult.rows[0].id, item.productId, item.name, item.quantity, item.price, JSON.stringify(item.fields)]);
    }
    await client.query("COMMIT");

    const order = orderResult.rows[0];
    res.status(201).json({
      ok: true,
      order: {
        orderNumber: order.order_number,
        status: order.status,
        total: Number(order.total_sdg),
        paymentMethod: order.payment_method,
        createdAt: order.created_at
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[ORDER CREATED ERROR]", error);
    res.status(500).json({ ok: false, error: "تعذر إنشاء الطلب." });
  } finally {
    client.release();
  }
});

// جلب طلبات العميل المباشرة بدون N+1 Query
app.get("/api/customer/orders", requireCustomer, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const result = await dbPool.query(`
      SELECT 
        o.id, o.order_number, o.status, o.payment_method, o.payment_status, 
        o.payment_reference, o.total_sdg, o.created_at, o.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'productId', oi.product_id,
              'name', oi.product_name,
              'quantity', oi.quantity,
              'price', oi.unit_price_sdg,
              'fields', oi.fields_json
            )
          ) FILTER (WHERE oi.id IS NOT NULL), '[]'
        ) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.customer_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 100
    `, [req.customer.id]);

    const orders = result.rows.map(row => ({
      orderNumber: row.order_number,
      total: Number(row.total_sdg),
      status: row.status,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      paymentReference: row.payment_reference,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: row.items
    }));

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, total: orders.length, orders });
  } catch (error) {
    console.error("[GET CUSTOMER ORDERS ERROR]", error);
    res.status(500).json({ ok: false, error: "تعذر تحميل الطلبات." });
  }
});

// جلب طلبات الإدارة برعلة واحدة للجداول Optimized Single Query
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const result = await dbPool.query(`
      SELECT 
        o.id, o.order_number, o.customer_id, o.customer_name, o.customer_phone, 
        o.status, o.payment_method, o.payment_status, o.payment_reference, 
        o.total_sdg, o.created_at, o.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'productId', oi.product_id,
              'name', oi.product_name,
              'quantity', oi.quantity,
              'price', oi.unit_price_sdg,
              'fields', oi.fields_json
            )
          ) FILTER (WHERE oi.id IS NOT NULL), '[]'
        ) as items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 1000
    `);

    const orders = result.rows.map(row => ({
      orderNumber: row.order_number,
      customer: { id: row.customer_id, name: row.customer_name, phone: row.customer_phone },
      status: row.status,
      payment: { method: row.payment_method, status: row.payment_status, transactionId: row.payment_reference },
      total: Number(row.total_sdg),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: row.items
    }));

    res.json({ ok: true, total: orders.length, orders });
  } catch (error) {
    console.error("[GET ADMIN ORDERS ERROR]", error);
    res.status(500).json({ ok: false, error: "تعذر تحميل الطلبات." });
  }
});

app.post("/api/admin/orders/:orderNumber/confirm-payment", requireAdmin, async (req, res) => {
  try {
    const transactionId = String(req.body?.transactionId || "").trim().slice(0, 120);
    if (!transactionId) return res.status(400).json({ ok: false, error: "transactionId is required" });
    const result = await dbPool.query(`
      UPDATE orders
      SET payment_reference = $1, payment_status = 'CONFIRMED', status = 'PAYMENT_CONFIRMED', updated_at = NOW()
      WHERE order_number = $2 AND status = 'PAYMENT_PENDING'
      RETURNING order_number, status, total_sdg, payment_method, payment_reference, created_at, updated_at
    `, [transactionId, String(req.params.orderNumber || "")]);

    if (!result.rowCount) return res.status(404).json({ ok: false, error: "Order not found or cannot be confirmed" });
    const row = result.rows[0];
    res.json({ ok: true, order: { orderNumber: row.order_number, status: row.status, total: Number(row.total_sdg), paymentMethod: row.payment_method, paymentStatus: "CONFIRMED", paymentReference: row.payment_reference, createdAt: row.created_at, updatedAt: row.updated_at } });
  } catch (error) {
    res.status(500).json({ ok: false, error: "تعذر تأكيد الدفع." });
  }
});

// ======================================================
// الصفحة الرئيسية وتشغيل السيرفر
// ======================================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

(async () => {
  try {
    await initDatabase();
  } catch (error) {
    console.error("[DB] Initialization failed:", error.message);
  }

  app.listen(PORT, () => {
    console.log(`ABESHA STORE running on port ${PORT}`);
    console.log(`Pricing USD → SDG: ${getPricingConfig().usdToSdg}`);
  });
})();
