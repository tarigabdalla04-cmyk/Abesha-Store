const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 8080;

const FAZER_API = "https://api.fzr.cards/api/v2";
const DEFAULT_USD_TO_SDG = 8900;

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
const authAttempts = new Map();

function safeDiagnostic(value) {
  let message = String(value || "Unknown error");
  for (const name of ["FAZER_API_KEY", "FAZER_API", "FAZER-API", "DATABASE_URL", "ADMIN_KEY"]) {
    const secret = process.env[name];
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message.slice(0, 500);
}

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
      customer_note TEXT NOT NULL DEFAULT '',
      payment_confirmed_at TIMESTAMPTZ,
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
      fields_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      fulfillment_status VARCHAR(32) NOT NULL DEFAULT 'PENDING_PAYMENT',
      fazer_order_id VARCHAR(120),
      fazer_status VARCHAR(64),
      idempotency_key VARCHAR(255),
      execution_attempts INTEGER NOT NULL DEFAULT 0,
      last_execution_error TEXT,
      fulfillment_started_at TIMESTAMPTZ,
      fulfillment_last_attempt_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_note TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fulfillment_status VARCHAR(32) NOT NULL DEFAULT 'PENDING_PAYMENT';
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fazer_order_id VARCHAR(120);
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fazer_status VARCHAR(64);
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS execution_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS last_execution_error TEXT;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fulfillment_started_at TIMESTAMPTZ;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fulfillment_last_attempt_at TIMESTAMPTZ;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS store_settings (
      setting_key VARCHAR(80) PRIMARY KEY,
      setting_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbPool.query(
    "INSERT INTO store_settings (setting_key, setting_value) VALUES ('store', $1::jsonb) ON CONFLICT (setting_key) DO NOTHING",
    [JSON.stringify(storeSettings)]
  );
  // Move known initial/legacy rates to the owner's current starting rate once.
  // Any other value was explicitly configured in the admin panel and is preserved.
  await dbPool.query(`UPDATE store_settings SET setting_value = jsonb_set(setting_value, '{pricing,usdToSdg}', '8900'::jsonb), updated_at = NOW()
    WHERE setting_key = 'store' AND setting_value #>> '{pricing,usdToSdg}' IN ('8250', '8300')`);
  const settingResult = await dbPool.query("SELECT setting_value FROM store_settings WHERE setting_key = 'store'");
  if (settingResult.rows[0]?.setting_value) storeSettings = settingResult.rows[0].setting_value;
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
    console.error("[AUTH] Session check failed:", safeDiagnostic(error.message));
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
// ABESHA STORE — التسعير والإعدادات
// ======================================================

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const STORE_SETTINGS_FILE = path.join(__dirname, "store-settings.json");
const STORE_SETTINGS_VERSION = 1;

let pricedCatalogCache = null;
let pricedCatalogBuiltAt = 0;
let priceRefreshPromise = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function getFazerApiKey() {
  return process.env.FAZER_API_KEY || process.env.FAZER_API || process.env["FAZER-API"];
}

function requireFazerKey() {
  if (!getFazerApiKey()) {
    const error = new Error("Fazer API key is not configured");
    error.status = 500;
    throw error;
  }
}

function fazerHeaders(extra = {}) {
  return {
    "X-API-Key": getFazerApiKey(),
    "Accept": "application/json",
    ...extra
  };
}

async function fazerFetch(endpoint, options = {}) {
  requireFazerKey();
  const method = String(options.method || "GET").toUpperCase();
  const safeToRetry = method === "GET" || Boolean(options.idempotencyKey);
  const requestedRetries = Number.isFinite(Number(options.maxRetries)) ? Math.max(0, Number(options.maxRetries)) : 3;
  const maxRetries = safeToRetry ? requestedRetries : 0;
  const baseDelayMs = Number.isFinite(Number(options.baseDelayMs)) ? Math.max(250, Number(options.baseDelayMs)) : 1200;
  const timeoutMs = options.timeoutMs || 30000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
      const response = await fetch(`${FAZER_API}${normalizedEndpoint}`, {
        ...options,
        method,
        headers: fazerHeaders({ ...(options.headers || {}), ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}) }),
        signal: controller.signal
      });

      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

      if (response.ok && data?.ok !== false) return data;

      const error = new Error(data?.message || data?.error || `Fazer API HTTP ${response.status}`);
      error.status = response.status || 502;
      
      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      if (!retryable || attempt >= maxRetries) throw error;

      const waitMs = Math.min(15000, baseDelayMs * (2 ** attempt)) + Math.floor(Math.random() * 400);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    } catch (error) {
      const retryable = error?.name === "AbortError" || [429, 500, 502, 503, 504].includes(error?.status);
      if (!retryable || attempt >= maxRetries) throw error;
      const waitMs = Math.min(15000, baseDelayMs * (2 ** attempt)) + Math.floor(Math.random() * 400);
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
    if (cursor) params.set("cursor", cursor);

    const data = await fazerGet(`${endpoint}?${params.toString()}`);
    const pageItems = getArray(data, ["items", "categories", "games"]);
    if (pageItems.length) items.push(...pageItems);

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
  return [];
}

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
    rounding: { under10000: 100, from10000To100000: 500, from100000To500000: 1000, from500000: 5000 }
  }
};

function loadStoreSettings() {
  try {
    if (!fs.existsSync(STORE_SETTINGS_FILE)) return DEFAULT_STORE_SETTINGS;
    return JSON.parse(fs.readFileSync(STORE_SETTINGS_FILE, "utf8"));
  } catch (error) {
    return DEFAULT_STORE_SETTINGS;
  }
}

let storeSettings = loadStoreSettings();

async function saveStoreSettings(settings) {
  if (!dbPool) throw new Error("Database is not configured");
  const next = { ...DEFAULT_STORE_SETTINGS, ...storeSettings, ...settings };
  await dbPool.query(
    "INSERT INTO store_settings (setting_key, setting_value, updated_at) VALUES ('store', $1::jsonb, NOW()) ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()",
    [JSON.stringify(next)]
  );
  storeSettings = next;
  return storeSettings;
}

function getPricingConfig() {
  const pricing = storeSettings?.pricing || DEFAULT_STORE_SETTINGS.pricing;
  return {
    usdToSdg: Number(pricing.usdToSdg) > 0 ? Number(pricing.usdToSdg) : DEFAULT_USD_TO_SDG,
    tiers: Array.isArray(pricing.tiers) && pricing.tiers.length === 4 ? pricing.tiers : DEFAULT_STORE_SETTINGS.pricing.tiers,
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

function offerPriceUsd(offer) {
  const candidates = [offer?.price_usd, offer?.priceUSD, offer?.usd_price, offer?.cost_usd, offer?.costUSD, offer?.price];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function offerLabel(offer) {
  return String(offer?.name || offer?.title || offer?.description || offer?.product_name || offer?.amount || "عرض").trim();
}

function productVisibility(product) {
  const id = String(product.id || "");
  if (storeSettings.hiddenIds?.includes(id)) return false;
  if (storeSettings.catalogMode === "curated") return storeSettings.publishedIds?.includes(id);
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildPricedCatalog() {
  console.log("[PRICE CACHE] Building complete catalog...");
  const products = [];
  const safeCatalogRead = async (loader) => {
    try { await loader(); } catch (error) { console.error("[CATALOG] Provider catalog section unavailable:", safeDiagnostic(error.message)); }
  };
  await safeCatalogRead(async () => {
    const categories = await getAllCategories("topups");
    for (const category of categories) {
      const categoryId = String(category.category_id || category.id || "");
      if (!categoryId) continue;
      try {
        const response = await fazerGet(`/topups/offers?category_id=${encodeURIComponent(categoryId)}`);
        const offers = getArray(response, ["offers", "items"]);
        for (const offer of offers) {
          const offerId = String(offer.offer_id || offer.id || "");
          if (!offerId) continue;
          const priceUsd = offerPriceUsd(offer);
          products.push({ id: `topup__${categoryId}__${offerId}`, category_id: categoryId,
            offer_id: offerId, name: `${category.name || category.title || categoryId} — ${offerLabel(offer)}`,
            type: "topup", price_sdg: calculateSalePrice(priceUsd), fields: response.fields || category.fields || [] });
        }
      } catch (error) { console.error("[CATALOG] Top-up category unavailable:", safeDiagnostic(error.message)); }
      await sleep(100);
    }
  });
  await safeCatalogRead(async () => {
    const categories = await getAllCategories("giftcards");
    for (const category of categories) {
      const categoryId = String(category.category_id || category.id || "");
      if (!categoryId) continue;
      try {
        const response = await fazerGet(`/giftcards/cards?category_id=${encodeURIComponent(categoryId)}`);
        for (const card of getArray(response, ["offers", "cards", "items"])) {
          const cardId = String(card.card_id || card.id || "");
          if (!cardId) continue;
          products.push({ id: `giftcard__${categoryId}__${cardId}`, category_id: categoryId, card_id: cardId,
            name: `${category.name || response.name || categoryId} — ${offerLabel(card)}`, type: "giftcard",
            price_sdg: calculateSalePrice(offerPriceUsd(card)), fields: [],
            max_quantity: Number(card.max_order_quantity) || 100,
            stock: card.stock == null ? null : Number(card.stock) });
        }
      } catch (error) { console.error("[CATALOG] Gift card category unavailable:", safeDiagnostic(error.message)); }
      await sleep(100);
    }
  });
  await safeCatalogRead(async () => {
    const categories = await getAllCategories("gamekeys");
    for (const category of categories) {
      const gameId = String(category.game_id || "");
      if (!gameId) continue;
      try {
        const response = await fazerGet(`/gamekeys/keys?game_id=${encodeURIComponent(gameId)}`);
        for (const key of getArray(response, ["keys", "items"])) {
          const keyId = String(key.key_id || key.id || "");
          if (!keyId) continue;
          products.push({ id: `gamekey__${gameId}__${keyId}`, game_id: gameId, key_id: keyId,
            name: `${category.name || response.GameName || gameId} — ${offerLabel(key)}`, type: "gamekey",
            price_sdg: calculateSalePrice(offerPriceUsd(key)), fields: [],
            max_quantity: Number(key.max_order_quantity) || 100,
            stock: key.stock == null ? null : Number(key.stock) });
        }
      } catch (error) { console.error("[CATALOG] Game key category unavailable:", safeDiagnostic(error.message)); }
      await sleep(100);
    }
  });

  pricedCatalogCache = products;
  pricedCatalogBuiltAt = Date.now();
  return products;
}

async function getPricedCatalog() {
  if (pricedCatalogCache && (Date.now() - pricedCatalogBuiltAt < CACHE_TTL_MS)) {
    return pricedCatalogCache;
  }
  if (priceRefreshPromise) return priceRefreshPromise;
  priceRefreshPromise = buildPricedCatalog().finally(() => { priceRefreshPromise = null; });
  return priceRefreshPromise;
}

// ======================================================
// مسارات لوحة الإدارة (ADMIN ROUTES) - حل مشكلة JSON
// ======================================================

function verifyAdminKey(key) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || !key) return false;
  const expected = Buffer.from(String(adminKey));
  const supplied = Buffer.from(String(key));
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ ok: false, error: "Admin access is not configured." });
  if (!verifyAdminKey(req.headers["x-admin-key"])) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

app.post("/api/admin/login", (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ ok: false, error: "Admin access is not configured." });
  if (authRateLimited(req)) return res.status(429).json({ ok: false, error: "Too many attempts. Try again later." });
  res.setHeader("Content-Type", "application/json");
  const { adminKey, key, password } = req.body || {};
  const inputKey = adminKey || key || password;

  if (verifyAdminKey(inputKey)) {
    return res.json({ ok: true, message: "تم تسجيل الدخول بنجاح" });
  }

  return res.status(401).json({ ok: false, error: "مفتاح الإدارة غير صحيح." });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.json({ ok: true, settings: storeSettings });
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const rate = Number(req.body?.settings?.pricing?.usdToSdg);
  if (!Number.isFinite(rate) || rate < 1 || rate > 1000000) {
    return res.status(400).json({ ok: false, error: "Exchange rate must be between 1 and 1,000,000 SDG per USD." });
  }
  try {
    const pricing = { ...getPricingConfig(), usdToSdg: rate };
    const settings = await saveStoreSettings({ pricing });
    pricedCatalogCache = null;
    return res.json({ ok: true, settings });
  } catch (error) {
    console.error("[SETTINGS] Database save failed:", safeDiagnostic(error.message));
    return res.status(503).json({ ok: false, error: "Could not save settings." });
  }
});

// ======================================================
// المسارات العامة (PUBLIC API & ROUTES)
// ======================================================

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/api/products", async (req, res) => {
  try {
    requireFazerKey();
    const products = await getPricedCatalog();
    const visible = products.filter(productVisibility).filter(p => Number(p.price_sdg) > 0);
    res.json({ ok: true, total: visible.length, products: visible });
  } catch (error) {
    res.status(error.status || 503).json({ ok: false, error: "تعذر تحميل المنتجات حاليًا." });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const customer = await getCurrentCustomer(req);
    res.json({ ok: true, authenticated: Boolean(customer), customer });
  } catch (error) {
    res.status(503).json({ ok: false, error: "الخدمة غير متوفرة." });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    if (authRateLimited(req)) return res.status(429).json({ ok: false, error: "محاولات كثيرة، حاول لاحقاً." });

    const name = cleanName(req.body?.name);
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");

    if (name.length < 2 || phone.length < 8 || password.length < 8) {
      return res.status(400).json({ ok: false, error: "البيانات المدخلة غير صحيحة." });
    }

    const credentials = await hashPassword(password);
    const created = await dbPool.query(`
      INSERT INTO customers (name, phone, password_hash, password_salt)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, phone
    `, [name, phone, credentials.hash, credentials.salt]);

    const token = crypto.randomBytes(32).toString("hex");
    await dbPool.query(`
      INSERT INTO sessions (customer_id, token_hash, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '30 days')
    `, [created.rows[0].id, hashSessionToken(token)]);

    setSessionCookie(res, token);
    res.status(201).json({ ok: true, customer: created.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ ok: false, error: "رقم الهاتف مسجل بالفعل." });
    res.status(500).json({ ok: false, error: "تعذر إنشاء الحساب." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    if (authRateLimited(req)) return res.status(429).json({ ok: false, error: "محاولات كثيرة، حاول لاحقاً." });

    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || "");

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
    res.json({ ok: true, customer: { id: row.id, name: row.name, phone: row.phone } });
  } catch (error) {
    res.status(500).json({ ok: false, error: "تعذر تسجيل الدخول." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (dbPool && token) await dbPool.query("DELETE FROM sessions WHERE token_hash = $1", [hashSessionToken(token)]);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    console.error("[AUTH] Logout failed:", safeDiagnostic(error.message));
    clearSessionCookie(res);
    res.status(503).json({ ok: false, error: "Could not revoke session." });
  }
});

app.get("/api/customer/orders", requireCustomer, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const result = await dbPool.query(`
      SELECT 
        o.id, o.order_number, o.status, o.payment_method, o.payment_status, 
        o.payment_reference, o.total_sdg, o.created_at,
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

    res.json({ ok: true, orders: result.rows.map(row => ({
      orderNumber: row.order_number, status: row.status, paymentStatus: row.payment_status,
      paymentMethod: row.payment_method, paymentReference: row.payment_reference,
      total: Number(row.total_sdg), totalSdg: Number(row.total_sdg), createdAt: row.created_at, items: row.items
    })) });
  } catch (error) {
    res.status(500).json({ ok: false, error: "تعذر استرجاع الطلبات." });
  }
});

function normalizeOrderFields(product, value) {
  const submitted = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const definitions = Array.isArray(product.fields) ? product.fields : [];
  const allowed = new Set(definitions.map(field => String(field.key || "")).filter(Boolean));
  if (Object.keys(submitted).some(key => !allowed.has(key))) throw new Error("Order contains unsupported product fields.");
  const fields = {};
  for (const definition of definitions) {
    const key = String(definition.key || "");
    const fieldValue = String(submitted[key] ?? "").trim();
    if (!key || !fieldValue || fieldValue.length > 250) throw new Error(`Please provide ${definition.label || key}.`);
    fields[key] = fieldValue;
  }
  return fields;
}

function frontendOrder(row, items = []) {
  return {
    id: row.id, orderNumber: row.order_number, status: row.status,
    paymentStatus: row.payment_status, paymentMethod: row.payment_method,
    paymentReference: row.payment_reference, total: Number(row.total_sdg),
    totalSdg: Number(row.total_sdg), createdAt: row.created_at, items
  };
}

app.post("/api/orders", requireCustomer, async (req, res) => {
  if (!requireDatabase(res)) return;
  const { items, paymentMethod, paymentReference, note } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 30) {
    return res.status(400).json({ ok: false, error: "The order must contain between 1 and 30 products." });
  }
  if (!["Bankak", "MyCashi"].includes(paymentMethod)) {
    return res.status(400).json({ ok: false, error: "Choose Bankak or MyCashi." });
  }
  const reference = String(paymentReference || "").trim();
  if (!reference || reference.length > 120) return res.status(400).json({ ok: false, error: "Enter the payment reference." });

  try {
    const catalog = await getPricedCatalog();
    const prepared = items.map(input => {
      const product = catalog.find(item => item.id === String(input?.productId || "") && productVisibility(item));
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Order item is invalid.");
      if (!product || !(Number(product.price_sdg) > 0)) throw new Error("A selected product is unavailable. Refresh the catalog and try again.");
      const quantity = Number(input.quantity || 1);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > Math.min(100, Number(product.max_quantity) || 100)) {
        throw new Error("Product quantity is invalid.");
      }
      if (product.type === "topup" && quantity !== 1) throw new Error("Top-up quantity must be one per order item.");
      if (product.stock != null && (!Number.isFinite(product.stock) || quantity > product.stock)) throw new Error("Requested quantity exceeds available stock.");
      const fields = normalizeOrderFields(product, input.fields);
      const provider = product.type === "topup"
        ? { type: "topup", category_id: product.category_id, offer_id: product.offer_id }
        : product.type === "giftcard"
          ? { type: "giftcard", category_id: product.category_id, card_id: product.card_id }
          : product.type === "gamekey"
            ? { type: "gamekey", game_id: product.game_id, key_id: product.key_id }
            : null;
      if (!provider || Object.values(provider).some(v => !v)) throw new Error("This product cannot currently be fulfilled.");
      return { product, quantity, fields, provider, unitPrice: Number(product.price_sdg) };
    });

    const total = prepared.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    if (!Number.isFinite(total) || total <= 0) throw new Error("Order total is invalid.");
    const client = await dbPool.connect();
    let order;
    try {
      await client.query("BEGIN");
      const orderNumber = `ABS-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const created = await client.query(`
        INSERT INTO orders (order_number, customer_id, customer_name, customer_phone, status,
          payment_method, payment_status, payment_reference, customer_note, total_sdg)
        VALUES ($1,$2,$3,$4,'PAYMENT_PENDING',$5,'PENDING',$6,$7,$8)
        RETURNING id, order_number, status, payment_status, payment_method, payment_reference, total_sdg, created_at
      `, [orderNumber, req.customer.id, req.customer.name, req.customer.phone, paymentMethod,
        reference, String(note || "").slice(0, 1000), total]);
      order = created.rows[0];
      for (const item of prepared) {
        await client.query(`INSERT INTO order_items
          (order_id, product_id, product_name, quantity, unit_price_sdg, fields_json, fulfillment_status)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,'PENDING_PAYMENT')`, [order.id, item.product.id,
          item.product.name, item.quantity, item.unitPrice,
          JSON.stringify({ buyer: item.fields, provider: item.provider })]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    return res.status(201).json({ ok: true, order: frontendOrder(order) });
  } catch (error) {
    if (error.message && /unavailable|quantity|fields|provide|fulfilled|invalid|exceeds/.test(error.message)) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    console.error("[ORDER] Creation failed:", safeDiagnostic(error.message));
    return res.status(503).json({ ok: false, error: "Could not create the order." });
  }
});

async function updateOrderFulfillmentStatus(orderId) {
  const result = await dbPool.query(`SELECT fulfillment_status FROM order_items WHERE order_id = $1`, [orderId]);
  const states = result.rows.map(row => row.fulfillment_status);
  const status = states.length && states.every(value => value === "FULFILLED") ? "FULFILLED"
    : states.includes("FAILED") ? "FAILED" : "PROCESSING";
  await dbPool.query("UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1", [orderId, status]);
  return status;
}

async function executeFulfillmentItem(itemId, retry = false) {
  const key = crypto.randomUUID();
  const eligible = retry ? ["FAILED"] : ["PAYMENT_CONFIRMED"];
  const claimed = await dbPool.query(`UPDATE order_items SET
      fulfillment_status = $4, idempotency_key = COALESCE(idempotency_key, $2),
      execution_attempts = execution_attempts + 1, last_execution_error = NULL,
      fulfillment_started_at = COALESCE(fulfillment_started_at, NOW()), fulfillment_last_attempt_at = NOW()
    WHERE id = $1 AND (fulfillment_status = ANY($3::varchar[]) OR
      ($5::boolean AND fulfillment_status IN ('SUBMITTING','RETRYING') AND fulfillment_last_attempt_at < NOW() - INTERVAL '2 minutes'))
    RETURNING id, order_id, fields_json, quantity, fulfillment_started_at, idempotency_key`,
    [itemId, key, eligible, retry ? "RETRYING" : "SUBMITTING", retry]);
  if (!claimed.rows.length) return null;
  const item = claimed.rows[0];
  const stored = item.fields_json || {};
  const provider = stored.provider || {};
  const buyer = stored.buyer || {};
  let endpoint;
  let body;
  if (provider.type === "topup") {
    endpoint = "/topups/order";
    body = { category_id: provider.category_id, offer_id: provider.offer_id, fields: buyer };
  } else if (provider.type === "giftcard") {
    endpoint = "/giftcards/order";
    body = { category_id: provider.category_id, card_id: provider.card_id, quantity: item.quantity };
  } else if (provider.type === "gamekey") {
    endpoint = "/gamekeys/order";
    body = { game_id: provider.game_id, key_id: provider.key_id, quantity: item.quantity };
  } else {
    await dbPool.query("UPDATE order_items SET fulfillment_status='FAILED', last_execution_error='Unsupported stored Fazer product type' WHERE id=$1", [itemId]);
    await updateOrderFulfillmentStatus(item.order_id);
    return null;
  }
  try {
    const result = await fazerFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), idempotencyKey: item.idempotency_key, maxRetries: 2 });
    const remoteOrder = result?.order || {};
    const fazerStatus = String(remoteOrder.status || "processing").toLowerCase();
    const state = ["completed", "fulfilled"].includes(fazerStatus) ? "FULFILLED"
      : fazerStatus === "failed" ? "FAILED" : "PROCESSING";
    await dbPool.query(`UPDATE order_items SET fulfillment_status=$2, fazer_order_id=$3, fazer_status=$4,
      executed_at=CASE WHEN $2='FULFILLED' THEN NOW() ELSE executed_at END,
      last_execution_error=CASE WHEN $2='FAILED' THEN COALESCE($5,'Fazer marked the order failed') ELSE NULL END WHERE id=$1`,
    [itemId, state, remoteOrder.id || null, fazerStatus, remoteOrder.error || null]);
  } catch (error) {
    const safeError = safeDiagnostic(error.message || "Fazer request failed");
    await dbPool.query("UPDATE order_items SET fulfillment_status='FAILED', last_execution_error=$2 WHERE id=$1", [itemId, safeError]);
    console.error("[FAZER] Fulfillment failed for item", itemId, ":", safeError);
  }
  await updateOrderFulfillmentStatus(item.order_id);
  return true;
}

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const result = await dbPool.query(`SELECT o.id, o.order_number, o.status, o.payment_method, o.payment_status,
      o.payment_reference, o.customer_name, o.customer_phone, o.total_sdg, o.created_at,
      COALESCE(json_agg(json_build_object('id',i.id,'productName',i.product_name,'quantity',i.quantity,
        'fulfillmentStatus',i.fulfillment_status,'fazerOrderId',i.fazer_order_id,'fazerStatus',i.fazer_status,
        'lastExecutionError',i.last_execution_error)) FILTER (WHERE i.id IS NOT NULL),'[]') AS items
      FROM orders o LEFT JOIN order_items i ON i.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`);
    res.json({ ok: true, orders: result.rows.map(row => ({ id: row.id, orderNumber: row.order_number,
      status: row.status, paymentStatus: row.payment_status, paymentMethod: row.payment_method,
      paymentReference: row.payment_reference, customerName: row.customer_name, customerPhone: row.customer_phone,
      total: Number(row.total_sdg), createdAt: row.created_at, items: row.items })) });
  } catch (error) {
    console.error("[ADMIN] Order list failed:", safeDiagnostic(error.message));
    res.status(503).json({ ok: false, error: "Could not load orders." });
  }
});

app.post("/api/admin/orders/:orderId/confirm-payment", requireAdmin, async (req, res) => {
  if (!requireDatabase(res)) return;
  const client = await dbPool.connect();
  let order;
  let itemIds = [];
  try {
    await client.query("BEGIN");
    const selected = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [req.params.orderId]);
    order = selected.rows[0];
    if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, error: "Order not found." }); }
    if (order.payment_status === "CONFIRMED") {
      await client.query("COMMIT");
      return res.json({ ok: true, order: frontendOrder(order), alreadyConfirmed: true });
    }
    if (order.payment_status !== "PENDING" || order.status !== "PAYMENT_PENDING") {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "Order is not awaiting payment confirmation." });
    }
    if (String(req.body?.paymentReference || "").trim() !== String(order.payment_reference || "")) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "Payment reference does not match the submitted order." });
    }
    const updated = await client.query(`UPDATE orders SET payment_status='CONFIRMED', status='FULFILLMENT_PENDING',
      payment_confirmed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [order.id]);
    order = updated.rows[0];
    const items = await client.query("UPDATE order_items SET fulfillment_status='PAYMENT_CONFIRMED' WHERE order_id=$1 AND fulfillment_status='PENDING_PAYMENT' RETURNING id", [order.id]);
    itemIds = items.rows.map(row => row.id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("[ADMIN] Payment confirmation failed:", safeDiagnostic(error.message));
    return res.status(503).json({ ok: false, error: "Could not confirm payment." });
  } finally { client.release(); }
  (async () => {
    for (const itemId of itemIds) await executeFulfillmentItem(itemId);
  })().catch(error => console.error("[FAZER] Order fulfillment queue failed:", safeDiagnostic(error.message)));
  return res.json({ ok: true, order: frontendOrder(order) });
});

app.post("/api/admin/order-items/:itemId/retry", requireAdmin, async (req, res) => {
  if (!requireDatabase(res)) return;
  try {
    const item = await dbPool.query("SELECT id, order_id, fulfillment_status, fulfillment_started_at, fulfillment_last_attempt_at FROM order_items WHERE id=$1", [req.params.itemId]);
    const row = item.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "Order item not found." });
    if (!["FAILED", "SUBMITTING", "RETRYING"].includes(row.fulfillment_status)) return res.status(409).json({ ok: false, error: "This item is not eligible for a safe retry." });
    const ageMs = row.fulfillment_started_at ? Date.now() - new Date(row.fulfillment_started_at).getTime() : Infinity;
    if (ageMs > 6 * 24 * 60 * 60 * 1000) {
      return res.status(409).json({ ok: false, error: "Safe retry window expired; verify the Fazer order before taking action." });
    }
    const attemptAgeMs = row.fulfillment_last_attempt_at ? Date.now() - new Date(row.fulfillment_last_attempt_at).getTime() : 0;
    if (["SUBMITTING", "RETRYING"].includes(row.fulfillment_status) && attemptAgeMs < 2 * 60 * 1000) {
      return res.status(409).json({ ok: false, error: "A fulfillment request is still being submitted." });
    }
    const retried = await executeFulfillmentItem(row.id, true);
    if (!retried) return res.status(409).json({ ok: false, error: "Fulfillment is already being processed." });
    const refreshed = await dbPool.query("SELECT fulfillment_status, fazer_order_id, fazer_status, last_execution_error FROM order_items WHERE id=$1", [row.id]);
    res.json({ ok: true, item: refreshed.rows[0] });
  } catch (error) {
    console.error("[ADMIN] Fulfillment retry failed:", safeDiagnostic(error.message));
    res.status(503).json({ ok: false, error: "Could not retry fulfillment." });
  }
});

app.post("/api/admin/order-items/:itemId/refresh", requireAdmin, async (req, res) => {
  if (!requireDatabase(res)) return;
  try {
    const result = await dbPool.query("SELECT id, order_id, fazer_order_id, fulfillment_status FROM order_items WHERE id=$1", [req.params.itemId]);
    const item = result.rows[0];
    if (!item) return res.status(404).json({ ok: false, error: "Order item not found." });
    if (!item.fazer_order_id) return res.status(409).json({ ok: false, error: "No Fazer order ID is available yet." });
    if (["FULFILLED", "FAILED"].includes(item.fulfillment_status)) {
      return res.json({ ok: true, status: item.fulfillment_status });
    }
    const resultFromFazer = await fazerGet(`/orders/${encodeURIComponent(item.fazer_order_id)}`);
    const remoteOrder = resultFromFazer?.order || {};
    const fazerStatus = String(remoteOrder.status || "processing").toLowerCase();
    const status = ["completed", "fulfilled"].includes(fazerStatus) ? "FULFILLED"
      : fazerStatus === "failed" ? "FAILED" : "PROCESSING";
    await dbPool.query(`UPDATE order_items SET fulfillment_status=$2, fazer_status=$3,
      executed_at=CASE WHEN $2='FULFILLED' THEN NOW() ELSE executed_at END,
      last_execution_error=CASE WHEN $2='FAILED' THEN COALESCE($4,'Fazer marked the order failed') ELSE NULL END WHERE id=$1`,
      [item.id, status, fazerStatus, remoteOrder.error || null]);
    await updateOrderFulfillmentStatus(item.order_id);
    res.json({ ok: true, status, fazerStatus });
  } catch (error) {
    console.error("[FAZER] Status refresh failed:", safeDiagnostic(error.message));
    res.status(503).json({ ok: false, error: "Could not refresh Fazer status." });
  }
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// معالجة المسارات غير المعتمدة للـ API وإرجاع JSON آمن
app.use("/api/*", (req, res) => {
  res.status(404).json({ ok: false, error: "المسار المطلوبة غير موجودة" });
});

async function resumePendingFulfillments() {
  if (!dbPool) return;
  const pending = await dbPool.query("SELECT id FROM order_items WHERE fulfillment_status='PAYMENT_CONFIRMED' ORDER BY id LIMIT 50");
  for (const row of pending.rows) {
    try { await executeFulfillmentItem(row.id); }
    catch (error) { console.error("[FAZER] Pending fulfillment recovery failed:", safeDiagnostic(error.message)); }
  }
}

// ======================================================
// التشغيل الرئيسي لسيرفر Express
// ======================================================

(async () => {
  try {
    await initDatabase();
    resumePendingFulfillments().catch(error => console.error("[FAZER] Recovery scan failed:", safeDiagnostic(error.message)));
  } catch (error) {
    console.error("[DB] Initialization error:", safeDiagnostic(error.message));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`ABESHA STORE running on port ${PORT}`);
    console.log(`Pricing USD -> SDG: ${getPricingConfig().usdToSdg}`);
  });
})();
