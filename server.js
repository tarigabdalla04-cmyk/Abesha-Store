const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");
const storeCore = (() => {
  function roundCommercialPrice(value, rounding = {}) {
    const price = Number(value);
    if (!Number.isFinite(price) || price <= 0) return 0;
    const step = price < 10000 ? rounding.under10000
      : price < 100000 ? rounding.from10000To100000
        : price < 500000 ? rounding.from100000To500000 : rounding.from500000;
    const increment = Number(step);
    return increment > 0 ? Math.ceil(price / increment) * increment : Math.ceil(price);
  }

  function markupForCost(costSdg, tiers = []) {
    const cost = Number(costSdg);
    if (!Number.isFinite(cost) || cost <= 0) return 0;
    const tier = tiers.find(item => item && (item.maxCost == null || cost <= Number(item.maxCost)));
    return tier && Number.isFinite(Number(tier.markup)) ? Number(tier.markup) : 0;
  }

  function calculateSalePrice(priceUsd, pricing = {}) {
    const usd = Number(priceUsd);
    const exchangeRate = Number(pricing.usdToSdg);
    if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) return 0;
    const cost = usd * exchangeRate;
    return roundCommercialPrice(cost * (1 + markupForCost(cost, pricing.tiers)), pricing.rounding);
  }

  function applyProductSettings(product, settings = {}) {
    const id = String(product?.id || "");
    const override = Number(settings.pricing?.priceOverrides?.[id]);
    const base = Number(product?.base_price_sdg ?? product?.price_sdg);
    const price = Number.isFinite(override) && override > 0 ? override : base;
    const discount = Number(settings.discounts?.[id]);
    const finalPrice = Number.isFinite(discount) && discount > 0 && discount <= 90 ? price * (1 - discount / 100) : price;
    const categoryRule = settings.categoryRules?.[String(product?.category_id || "")] || {};
    return {
      ...product,
      price_sdg: Math.max(0, Math.round(finalPrice)),
      ...(categoryRule.storeCategory ? { store_category: categoryRule.storeCategory } : {}),
      ...(typeof categoryRule.religiousDisclaimer === "boolean" ? { religious_disclaimer: categoryRule.religiousDisclaimer } : {})
    };
  }

  function safeProviderImageUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return "";
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.toString() : "";
    } catch {
      return "";
    }
  }

  function catalogIsValid(products) {
    return Array.isArray(products) && products.length > 0 && products.every(product => {
      const price = Number(product?.base_price_sdg ?? product?.price_sdg);
      return product && typeof product === "object" && String(product.id || "").trim() && Number.isFinite(price) && price > 0;
    }) && new Set(products.map(product => String(product.id))).size === products.length;
  }

  function adminKeyMatches(expected, actual) {
    if (typeof expected !== "string" || !expected || typeof actual !== "string") return false;
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }

  function adminToken(key) {
    return crypto.createHmac("sha256", key).update("abesha-admin-session-v1").digest("hex");
  }

  function createAdminSessionToken(key) {
    return adminToken(String(key));
  }

  function verifyAdminSessionToken(key, token) {
    if (typeof key !== "string" || !key || typeof token !== "string") return false;
    const expectedBuffer = Buffer.from(adminToken(key));
    const actualBuffer = Buffer.from(token);
    return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  }

  function deterministicOrderNumber(customerId, requestKey) {
    const digest = crypto.createHash("sha256").update(`${customerId}:${requestKey}`).digest("hex").slice(0, 24).toUpperCase();
    return `ABS-${digest}`;
  }

  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }

  function sameOrderIntent(order, storedItems, intent) {
    if (!order || !Array.isArray(storedItems) || !Array.isArray(intent?.items)) return false;
    const expectedItems = intent.items.map(item => ({
      product_id: String(item?.productId || ""),
      quantity: Number(item?.quantity || 1),
      fields: canonical(item?.fields || {})
    })).sort((a, b) => a.product_id.localeCompare(b.product_id));
    const actualItems = storedItems.map(item => ({
      product_id: String(item.product_id || ""),
      quantity: Number(item.quantity),
      fields: canonical(item.fields_json?.buyer || {})
    })).sort((a, b) => a.product_id.localeCompare(b.product_id));
    return String(order.payment_method) === String(intent.paymentMethod) &&
      String(order.payment_reference || "") === String(intent.paymentReference || "") &&
      String(order.customer_note || "") === String(intent.note || "") &&
      JSON.stringify(actualItems) === JSON.stringify(expectedItems);
  }

  return {
    roundCommercialPrice, markupForCost, calculateSalePrice, applyProductSettings,
    safeProviderImageUrl, catalogIsValid, adminKeyMatches, createAdminSessionToken,
    verifyAdminSessionToken, deterministicOrderNumber, sameOrderIntent
  };
})();
const catalogConfig = require("./catalog-config.json");

const app = express();
const PORT = process.env.PORT || 8080;
const configuredProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || "1", 10);
app.set("trust proxy", Number.isInteger(configuredProxyHops) && configuredProxyHops >= 0 && configuredProxyHops <= 5 ? configuredProxyHops : 1);

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
    if (key) {
      try { out[key] = decodeURIComponent(val); }
      catch (_) { out[key] = ""; }
    }
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
  `);
  const settingResult = await dbPool.query("SELECT id, version, settings_json FROM store_settings");
  if (settingResult.rowCount !== 1) {
    throw new Error(`Expected exactly one store_settings row; found ${settingResult.rowCount}. Refusing to create or replace settings.`);
  }
  if (!settingResult.rows[0].settings_json || typeof settingResult.rows[0].settings_json !== "object" || Array.isArray(settingResult.rows[0].settings_json)) {
    throw new Error("store_settings.settings_json is not a JSON object; refusing to replace settings.");
  }
  storeSettings = settingResult.rows[0].settings_json;
  const savedCatalog = storeSettings.catalogSnapshot?.products;
  if (storeCore.catalogIsValid(savedCatalog)) {
    pricedCatalogCache = savedCatalog;
    pricedCatalogBuiltAt = Date.now();
    console.log(`[CATALOG] Restored ${savedCatalog.length} products from PostgreSQL snapshot`);
  }
  storeSettingsReady = true;
  await dbPool.query("DELETE FROM sessions WHERE expires_at < NOW()");
  databaseReady = true;
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
const STORE_SETTINGS_VERSION = 1;
const FAZER_MIN_REQUEST_INTERVAL_MS = 550;

let pricedCatalogCache = null;
let pricedCatalogBuiltAt = 0;
let priceRefreshPromise = null;
let fazerRequestQueue = Promise.resolve();
let fazerLastRequestStartedAt = 0;
let catalogLastRefreshOk = false;
let storeSettingsReady = false;
let databaseReady = false;

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
      await scheduleFazerRequest();
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

function scheduleFazerRequest() {
  const scheduled = fazerRequestQueue.then(async () => {
    const waitMs = Math.max(0, FAZER_MIN_REQUEST_INTERVAL_MS - (Date.now() - fazerLastRequestStartedAt));
    if (waitMs) await sleep(waitMs);
    fazerLastRequestStartedAt = Date.now();
  });
  fazerRequestQueue = scheduled.catch(() => {});
  return scheduled;
}

async function getAllCategories(endpoint, extraParams = {}) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams();
    params.set("limit", "50");
    for (const [key, value] of Object.entries(extraParams)) params.set(key, String(value));
    if (cursor) params.set("cursor", cursor);

    const data = await fazerGet(`${endpoint}?${params.toString()}`);
    if (!hasArrayResponse(data, ["items", "categories", "games"])) throw new Error(`Unexpected Fazer category response for ${endpoint}`);
    const pageItems = getArray(data, ["items", "categories", "games"]);
    if (pageItems.length) items.push(...pageItems);

    const nextCursor = data?.meta?.next_cursor || data?.next_cursor || data?.pagination?.next_cursor || null;
    if (!nextCursor && data?.meta?.has_more === true) throw new Error(`Fazer reported more ${endpoint} categories without a continuation cursor`);
    if (!nextCursor) break;
    if (page === 99) throw new Error(`Fazer category pagination exceeded the safety limit for ${endpoint}`);
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

function hasArrayResponse(data, keys) {
  return Array.isArray(data) || keys.some(key => Array.isArray(data?.[key])) || Array.isArray(data?.data);
}

const DEFAULT_STORE_SETTINGS = {
  version: STORE_SETTINGS_VERSION,
  catalogMode: "all",
  publishedIds: [],
  hiddenIds: [],
  categoryRules: {},
  discounts: {},
  pricing: {
    usdToSdg: DEFAULT_USD_TO_SDG,
    priceOverrides: {},
    tiers: [
      { maxCost: 20000, markup: 0.07 },
      { maxCost: 100000, markup: 0.08 },
      { maxCost: 300000, markup: 0.09 },
      { maxCost: null, markup: 0.10 }
    ],
    rounding: { under10000: 100, from10000To100000: 500, from100000To500000: 1000, from500000: 5000 }
  }
};

let storeSettings = JSON.parse(JSON.stringify(DEFAULT_STORE_SETTINGS));

function mergeSettings(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return current;
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeSettings(current?.[key] && typeof current[key] === "object" && !Array.isArray(current[key]) ? current[key] : {}, value)
      : value;
  }
  return merged;
}

async function updateStoreSettings(mutator) {
  if (!dbPool) throw new Error("Database is not configured");
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query("SELECT id, settings_json FROM store_settings FOR UPDATE");
    if (currentResult.rowCount !== 1) {
      throw new Error(`Expected exactly one store_settings row; found ${currentResult.rowCount}. Refusing to save.`);
    }
    const current = currentResult.rows[0].settings_json;
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error("store_settings.settings_json is not a JSON object; refusing to save.");
    }
    const next = await mutator(JSON.parse(JSON.stringify(current)));
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("Settings update must produce an object.");
    const updated = await client.query(
      "UPDATE store_settings SET settings_json = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING settings_json",
      [JSON.stringify(next), currentResult.rows[0].id]
    );
    if (updated.rowCount !== 1) throw new Error("The existing store_settings row could not be updated.");
    await client.query("COMMIT");
    storeSettings = updated.rows[0].settings_json;
    storeSettingsReady = true;
    return storeSettings;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function saveStoreSettings(settings) {
  return updateStoreSettings(current => mergeSettings(current, settings));
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
  return storeCore.markupForCost(costSdg, pricing.tiers);
}

function roundCommercialPrice(value) {
  return storeCore.roundCommercialPrice(value, getPricingConfig().rounding);
}

function calculateSalePrice(priceUsd) {
  return storeCore.calculateSalePrice(priceUsd, getPricingConfig());
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

function categoryRuleFor(product) {
  const categoryId = String(product?.category_id || "");
  return storeSettings.categoryRules?.[categoryId] || catalogConfig.catalog?.categoryRules?.[categoryId] || {};
}

function currentPricedProduct(product) {
  const cost = Number(product?._cost_usd);
  const basePrice = Number.isFinite(cost) && cost > 0
    ? calculateSalePrice(cost)
    : Number(product?.base_price_sdg ?? product?.price_sdg);
  return storeCore.applyProductSettings({ ...product, price_sdg: basePrice, base_price_sdg: basePrice }, {
    ...storeSettings,
    categoryRules: { ...(catalogConfig.catalog?.categoryRules || {}), ...(storeSettings.categoryRules || {}) }
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildPricedCatalog() {
  console.log("[PRICE CACHE] Building complete catalog...");
  catalogLastRefreshOk = false;
  const products = [];
  const previous = Array.isArray(storeSettings.catalogSnapshot?.products)
    ? storeSettings.catalogSnapshot.products : (pricedCatalogCache || []);
  let complete = true;

  async function readFamily(type, loader) {
    try {
      const familyProducts = await loader();
      products.push(...familyProducts);
    } catch (error) {
      if (Number(error?.status) === 403) {
        // Fazer documents 403 as a service that is not enabled on the reseller account.
        const savedFamily = previous.filter(product => product.type === type);
        products.push(...savedFamily);
        console.warn(`[CATALOG] ${type} is not enabled; retaining ${savedFamily.length} saved products`);
        return;
      }
      complete = false;
      console.error(`[CATALOG] ${type} source unavailable:`, safeDiagnostic(error.message));
    }
  }

  function providerImage(...records) {
    const candidates = [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const ui = record.ui && typeof record.ui === "object" ? record.ui : {};
      const images = record.images && typeof record.images === "object" ? record.images : {};
      candidates.push(record.cover_url, record.coverUrl, record.image_url, record.imageUrl,
        record.icon_url, record.iconUrl, record.image, record.cover,
        ui.cover_url, ui.coverUrl, ui.image_url, ui.image, ui.cover,
        images.cover, images.icon, images.thumbnail);
    }
    for (const value of candidates) {
      const safe = storeCore.safeProviderImageUrl(value);
      if (safe) return safe;
    }
    return "";
  }

  await readFamily("topup", async () => {
    const family = [];
    const categories = await getAllCategories("topups", { include_ui: "true" });
    for (const category of categories) {
      const categoryId = String(category.category_id || category.id || "");
      if (!categoryId) continue;
      const response = await fazerGet(`/topups/offers?category_id=${encodeURIComponent(categoryId)}`);
      if (!hasArrayResponse(response, ["offers", "items"])) throw new Error("Unexpected Fazer top-up response");
      for (const offer of getArray(response, ["offers", "items"])) {
        const offerId = String(offer.offer_id || offer.id || "");
        if (!offerId) continue;
        const priceUsd = offerPriceUsd(offer);
        const basePrice = calculateSalePrice(priceUsd);
        family.push({ id: `topup__${categoryId}__${offerId}`, category_id: categoryId, category_name: String(category.name || category.title || categoryId),
          _cost_usd: priceUsd, offer_id: offerId, name: `${category.name || category.title || categoryId} — ${offerLabel(offer)}`,
          type: "topup", price_sdg: basePrice, base_price_sdg: basePrice,
          image_url: providerImage(offer, response, category), fields: response.fields || category.fields || [] });
      }
      await sleep(100);
    }
    return family;
  });

  await readFamily("giftcard", async () => {
    const family = [];
    const categories = await getAllCategories("giftcards");
    for (const category of categories) {
      const categoryId = String(category.category_id || category.id || "");
      if (!categoryId) continue;
      const response = await fazerGet(`/giftcards/cards?category_id=${encodeURIComponent(categoryId)}`);
      if (!hasArrayResponse(response, ["offers", "cards", "items"])) throw new Error("Unexpected Fazer gift card response");
      for (const card of getArray(response, ["offers", "cards", "items"])) {
        const cardId = String(card.card_id || card.id || "");
        if (!cardId) continue;
        const priceUsd = offerPriceUsd(card);
        const basePrice = calculateSalePrice(priceUsd);
        family.push({ id: `giftcard__${categoryId}__${cardId}`, category_id: categoryId, category_name: String(category.name || response.name || categoryId),
          card_id: cardId, _cost_usd: priceUsd, name: `${category.name || response.name || categoryId} — ${offerLabel(card)}`,
          type: "giftcard", price_sdg: basePrice, base_price_sdg: basePrice,
          image_url: providerImage(card, response, category), fields: [],
          max_quantity: Number(card.max_order_quantity) || 100, stock: card.stock == null ? null : Number(card.stock) });
      }
      await sleep(100);
    }
    return family;
  });

  await readFamily("gamekey", async () => {
    const family = [];
    const categories = await getAllCategories("gamekeys");
    for (const category of categories) {
      const gameId = String(category.game_id || category.id || "");
      if (!gameId) continue;
      const response = await fazerGet(`/gamekeys/keys?game_id=${encodeURIComponent(gameId)}`);
      if (!hasArrayResponse(response, ["keys", "items"])) throw new Error("Unexpected Fazer game key response");
      for (const key of getArray(response, ["keys", "items"])) {
        const keyId = String(key.key_id || key.id || "");
        if (!keyId) continue;
        const priceUsd = offerPriceUsd(key);
        const basePrice = calculateSalePrice(priceUsd);
        family.push({ id: `gamekey__${gameId}__${keyId}`, category_id: gameId, category_name: String(category.name || response.GameName || gameId),
          game_id: gameId, key_id: keyId, _cost_usd: priceUsd, name: `${category.name || response.GameName || gameId} — ${offerLabel(key)}`,
          type: "gamekey", price_sdg: basePrice, base_price_sdg: basePrice,
          image_url: providerImage(key, response, category), fields: [],
          max_quantity: Number(key.max_order_quantity) || 100, stock: key.stock == null ? null : Number(key.stock) });
      }
      await sleep(100);
    }
    return family;
  });

  const unique = new Map();
  for (const product of products) {
    if (!product.id || !Number.isFinite(Number(product.base_price_sdg)) || Number(product.base_price_sdg) <= 0 || unique.has(product.id)) {
      complete = false;
      continue;
    }
    unique.set(product.id, product);
  }
  if (!complete || !storeCore.catalogIsValid([...unique.values()])) {
    if (pricedCatalogCache?.length) {
      console.warn("[CATALOG] Refresh was incomplete; retaining last known good catalog.");
      pricedCatalogBuiltAt = Date.now();
      return pricedCatalogCache;
    }
    throw new Error("Fazer catalog refresh was empty or incomplete; no valid catalog is available.");
  }

  const nextCatalog = [...unique.values()];
  if (dbPool && storeSettingsReady) {
    try {
      await saveStoreSettings({ catalogSnapshot: { version: 1, updatedAt: new Date().toISOString(), products: nextCatalog } });
    } catch (error) {
      if (pricedCatalogCache?.length) {
        console.error("[CATALOG] Could not persist refresh; retaining last known good catalog:", safeDiagnostic(error.message));
        return pricedCatalogCache;
      }
      throw new Error("Fazer catalog was fetched but could not be saved to PostgreSQL.");
    }
  }
  pricedCatalogCache = nextCatalog;
  pricedCatalogBuiltAt = Date.now();
  catalogLastRefreshOk = true;
  return pricedCatalogCache;
}

async function getPricedCatalog(forceRefresh = false) {
  if (!forceRefresh && pricedCatalogCache && (Date.now() - pricedCatalogBuiltAt < CACHE_TTL_MS)) {
    return pricedCatalogCache;
  }
  if (!priceRefreshPromise) priceRefreshPromise = buildPricedCatalog().finally(() => { priceRefreshPromise = null; });
  if (pricedCatalogCache && !forceRefresh) {
    priceRefreshPromise.catch(error => console.error("[CATALOG] Background refresh failed:", safeDiagnostic(error.message)));
    return pricedCatalogCache;
  }
  return priceRefreshPromise;
}

// ======================================================
// مسارات لوحة الإدارة (ADMIN ROUTES) - حل مشكلة JSON
// ======================================================

function verifyAdminKey(key) {
  return storeCore.adminKeyMatches(process.env.ADMIN_KEY, key);
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ ok: false, error: "Admin access is not configured." });
  const cookieValid = storeCore.verifyAdminSessionToken(process.env.ADMIN_KEY, parseCookies(req).abeshaadmin);
  if (!cookieValid && !verifyAdminKey(req.headers["x-admin-key"])) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

function setAdminCookie(res, key) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const token = storeCore.createAdminSessionToken(key);
  res.setHeader("Set-Cookie", `abeshaadmin=${encodeURIComponent(token)}; Max-Age=1800; Path=/api/admin; HttpOnly; SameSite=Strict${secure}`);
}

app.post("/api/admin/login", (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(503).json({ ok: false, error: "Admin access is not configured." });
  if (authRateLimited(req)) return res.status(429).json({ ok: false, error: "Too many attempts. Try again later." });
  res.setHeader("Content-Type", "application/json");
  const { adminKey, key, password } = req.body || {};
  const inputKey = adminKey || key || password;

  if (verifyAdminKey(inputKey)) {
    setAdminCookie(res, String(inputKey));
    return res.json({ ok: true, message: "تم تسجيل الدخول بنجاح" });
  }

  return res.status(401).json({ ok: false, error: "مفتاح الإدارة غير صحيح." });
});

app.get("/api/admin/settings", requireAdmin, (req, res) => {
  if (!storeSettingsReady) return res.status(503).json({ ok: false, error: "Persistent settings are unavailable." });
  res.setHeader("Content-Type", "application/json");
  const { catalogSnapshot, ...settings } = storeSettings;
  res.json({ ok: true, settings });
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  const rate = Number(req.body?.settings?.pricing?.usdToSdg);
  if (!Number.isFinite(rate) || rate < 1 || rate > 1000000) {
    return res.status(400).json({ ok: false, error: "Exchange rate must be between 1 and 1,000,000 SDG per USD." });
  }
  try {
    const settings = await saveStoreSettings({ pricing: { usdToSdg: rate } });
    if (pricedCatalogCache) {
      pricedCatalogCache = pricedCatalogCache.map(product => {
        const basePrice = calculateSalePrice(product._cost_usd);
        return { ...product, price_sdg: basePrice, base_price_sdg: basePrice };
      });
      pricedCatalogBuiltAt = Date.now();
    }
    const { catalogSnapshot, ...safeSettings } = settings;
    return res.json({ ok: true, settings: safeSettings });
  } catch (error) {
    console.error("[SETTINGS] Database save failed:", safeDiagnostic(error.message));
    return res.status(503).json({ ok: false, error: "Could not save settings." });
  }
});

app.get("/api/admin/products", requireAdmin, async (req, res) => {
  if (!storeSettingsReady) return res.status(503).json({ ok: false, error: "Persistent settings are unavailable." });
  try {
    const products = await getPricedCatalog();
    res.json({ ok: true, total: products.length, products: products.map(product => ({
      ...currentPricedProduct(product), cost_usd: Number(product._cost_usd),
      visible: productVisibility(product)
    })) });
  } catch (error) {
    res.status(error.status || 503).json({ ok: false, error: "تعذر تحميل كتالوج الإدارة حاليًا." });
  }
});

app.post("/api/admin/products/:productId/settings", requireAdmin, async (req, res) => {
  if (!storeSettingsReady) return res.status(503).json({ ok: false, error: "Persistent settings are unavailable." });
  try {
    const catalog = await getPricedCatalog();
    const product = catalog.find(item => item.id === req.params.productId);
    if (!product) return res.status(404).json({ ok: false, error: "Product not found in the current catalog." });
    const body = req.body || {};
    const categoryOptions = new Set(["mobile", "game", "gift", "subscription", "steam", "other"]);
    if (body.visible !== undefined && typeof body.visible !== "boolean") return res.status(400).json({ ok: false, error: "Visibility value is invalid." });
    if (body.storeCategory !== undefined && !categoryOptions.has(String(body.storeCategory))) return res.status(400).json({ ok: false, error: "Product category is invalid." });
    if (body.religiousDisclaimer !== undefined && (typeof body.religiousDisclaimer !== "boolean" || product.type !== "topup")) {
      return res.status(400).json({ ok: false, error: "The notice can only be set for a Fazer top-up category." });
    }
    if (body.priceOverride !== undefined && body.priceOverride !== null && (!Number.isFinite(Number(body.priceOverride)) || Number(body.priceOverride) <= 0 || Number(body.priceOverride) > 1000000000000)) {
      return res.status(400).json({ ok: false, error: "Manual price must be a positive number." });
    }
    if (body.discountPercent !== undefined && body.discountPercent !== null && (!Number.isFinite(Number(body.discountPercent)) || Number(body.discountPercent) < 0 || Number(body.discountPercent) > 90)) {
      return res.status(400).json({ ok: false, error: "Discount must be between 0 and 90 percent." });
    }

    const saved = await updateStoreSettings(current => {
      current.hiddenIds = Array.isArray(current.hiddenIds) ? current.hiddenIds : [];
      if (body.visible === true) current.hiddenIds = current.hiddenIds.filter(id => id !== product.id);
      if (body.visible === false && !current.hiddenIds.includes(product.id)) current.hiddenIds.push(product.id);
      current.categoryRules = current.categoryRules && typeof current.categoryRules === "object" ? current.categoryRules : {};
      const categoryId = String(product.category_id || "");
      if (categoryId && (body.storeCategory !== undefined || body.religiousDisclaimer !== undefined)) {
        const rule = { ...(current.categoryRules[categoryId] || {}) };
        if (body.storeCategory !== undefined) rule.storeCategory = String(body.storeCategory);
        if (body.religiousDisclaimer !== undefined) rule.religiousDisclaimer = body.religiousDisclaimer;
        current.categoryRules[categoryId] = rule;
      }
      current.pricing = current.pricing && typeof current.pricing === "object" ? current.pricing : {};
      current.pricing.priceOverrides = current.pricing.priceOverrides && typeof current.pricing.priceOverrides === "object" ? current.pricing.priceOverrides : {};
      current.discounts = current.discounts && typeof current.discounts === "object" ? current.discounts : {};
      if (body.priceOverride !== undefined) {
        if (body.priceOverride === null) delete current.pricing.priceOverrides[product.id];
        else current.pricing.priceOverrides[product.id] = Math.round(Number(body.priceOverride));
      }
      if (body.discountPercent !== undefined) {
        if (body.discountPercent === null || Number(body.discountPercent) === 0) delete current.discounts[product.id];
        else current.discounts[product.id] = Number(body.discountPercent);
      }
      return current;
    });
    const updated = currentPricedProduct(product);
    res.json({ ok: true, product: { ...updated, visible: productVisibility(product) }, settingsUpdated: Boolean(saved) });
  } catch (error) {
    console.error("[ADMIN] Product settings save failed:", safeDiagnostic(error.message));
    res.status(503).json({ ok: false, error: "Could not save product settings." });
  }
});

app.post("/api/admin/catalog/refresh", requireAdmin, async (req, res) => {
  if (!getFazerApiKey()) return res.status(503).json({ ok: false, error: "Fazer API key is not configured; the saved catalog remains available." });
  try {
    const products = await getPricedCatalog(true);
    if (!catalogLastRefreshOk) return res.status(503).json({ ok: false, total: products.length, staleCatalogKept: products.length > 0, error: "تعذر تحديث Fazer؛ أبقينا آخر نسخة محفوظة دون تغيير." });
    res.json({ ok: true, total: products.length, updatedAt: new Date(pricedCatalogBuiltAt).toISOString() });
  } catch (error) {
    res.status(error.status || 503).json({ ok: false, error: "تعذر تحديث الكتالوج. احتفظنا بآخر نسخة محفوظة إن وجدت." });
  }
});

// ======================================================
// المسارات العامة (PUBLIC API & ROUTES)
// ======================================================

// Deployment liveness probe: the HTTP process can serve the storefront even
// while optional database-backed features are unavailable.
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy", timestamp: new Date().toISOString() });
});

// Dependency readiness probe for monitoring database-backed features.
app.get("/ready", async (req, res) => {
  let ready = Boolean(dbPool && databaseReady && storeSettingsReady);
  if (ready) {
    try { await dbPool.query({ text: "SELECT 1", statement_timeout: 3000 }); }
    catch (_) { ready = false; }
  }
  res.status(ready ? 200 : 503).json({ ok: ready, status: ready ? "healthy" : "not_ready", timestamp: new Date().toISOString() });
});

app.get("/api/products", async (req, res) => {
  try {
    const products = await getPricedCatalog();
    const visible = products.filter(productVisibility).map(currentPricedProduct).filter(p => Number(p.price_sdg) > 0);
    res.json({ ok: true, total: visible.length, updatedAt: new Date(pricedCatalogBuiltAt).toISOString(), products: visible.map(({ _cost_usd, ...product }) => product) });
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
  const requestKey = String(req.get("Idempotency-Key") || "");
  if (requestKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) {
    return res.status(400).json({ ok: false, error: "Invalid order retry key." });
  }
  const orderNumber = requestKey
    ? storeCore.deterministicOrderNumber(req.customer.id, requestKey)
    : `ABS-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  try {
    if (requestKey) {
      const prior = await dbPool.query("SELECT * FROM orders WHERE order_number=$1 AND customer_id=$2", [orderNumber, req.customer.id]);
      if (prior.rows[0]) {
        const priorItems = await dbPool.query("SELECT product_id, quantity, fields_json FROM order_items WHERE order_id=$1 ORDER BY id", [prior.rows[0].id]);
        const existing = prior.rows[0];
        if (!storeCore.sameOrderIntent(existing, priorItems.rows, { items, paymentMethod, paymentReference: reference, note })) {
          return res.status(409).json({ ok: false, error: "مفتاح إعادة المحاولة مرتبط بطلب مختلف." });
        }
        return res.json({ ok: true, order: frontendOrder(existing), replayed: true });
      }
    }
    const catalog = (await getPricedCatalog()).map(currentPricedProduct);
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
    const expectedTotal = Number(req.body?.expectedTotal);
    if (Number.isFinite(expectedTotal) && Math.abs(expectedTotal - total) > 0.01) {
      return res.status(409).json({ ok: false, error: "تغير سعر منتج أو إجمالي الطلب. راجع الإجمالي الجديد قبل المتابعة.", total });
    }
    const client = await dbPool.connect();
    let order;
    try {
      await client.query("BEGIN");
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
    if (requestKey && error.code === "23505") {
      try {
        const prior = await dbPool.query("SELECT * FROM orders WHERE order_number=$1 AND customer_id=$2", [orderNumber, req.customer.id]);
        if (prior.rows[0]) {
          const priorItems = await dbPool.query("SELECT product_id, quantity, fields_json FROM order_items WHERE order_id=$1 ORDER BY id", [prior.rows[0].id]);
          if (storeCore.sameOrderIntent(prior.rows[0], priorItems.rows, { items, paymentMethod, paymentReference: reference, note })) {
            return res.json({ ok: true, order: frontendOrder(prior.rows[0]), replayed: true });
          }
          return res.status(409).json({ ok: false, error: "مفتاح إعادة المحاولة مرتبط بطلب مختلف." });
        }
      } catch (lookupError) {
        console.error("[ORDER] Retry lookup failed:", safeDiagnostic(lookupError.message));
      }
    }
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
    WHERE id = $1 AND EXISTS (SELECT 1 FROM orders o WHERE o.id=order_items.order_id AND o.payment_status='CONFIRMED') AND
      (fulfillment_status = ANY($3::varchar[]) OR
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
    const item = await dbPool.query(`SELECT i.id, i.order_id, i.fulfillment_status, i.fulfillment_started_at,
      i.fulfillment_last_attempt_at, i.idempotency_key, o.payment_status
      FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=$1`, [req.params.itemId]);
    const row = item.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "Order item not found." });
    if (row.payment_status !== "CONFIRMED") return res.status(409).json({ ok: false, error: "Payment must be confirmed before fulfillment." });
    if (!row.idempotency_key) return res.status(409).json({ ok: false, error: "No saved Fazer retry key exists; verify the provider order before retrying." });
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
  let afterId = 0;
  while (true) {
    const pending = await dbPool.query("SELECT id FROM order_items WHERE fulfillment_status='PAYMENT_CONFIRMED' AND id>$1 ORDER BY id LIMIT 50", [afterId]);
    if (!pending.rows.length) break;
    for (const row of pending.rows) {
      afterId = Number(row.id);
      try { await executeFulfillmentItem(row.id); }
      catch (error) { console.error("[FAZER] Pending fulfillment recovery failed:", safeDiagnostic(error.message)); }
    }
  }
  afterId = 0;
  while (true) {
    const uncertain = await dbPool.query(`SELECT i.id FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE i.id>$1 AND i.fulfillment_status IN ('SUBMITTING','RETRYING') AND o.payment_status='CONFIRMED'
      AND i.idempotency_key IS NOT NULL AND i.fulfillment_started_at > NOW() - INTERVAL '6 days'
      AND i.fulfillment_last_attempt_at < NOW() - INTERVAL '2 minutes' ORDER BY i.id LIMIT 50`, [afterId]);
    if (!uncertain.rows.length) break;
    for (const row of uncertain.rows) {
      afterId = Number(row.id);
      try { await executeFulfillmentItem(row.id, true); }
      catch (error) { console.error("[FAZER] Uncertain fulfillment recovery failed:", safeDiagnostic(error.message)); }
    }
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
    if (getFazerApiKey()) {
      getPricedCatalog(true).catch(error => console.error("[CATALOG] Startup refresh failed:", safeDiagnostic(error.message)));
      const catalogTimer = setInterval(() => {
        getPricedCatalog(true).catch(error => console.error("[CATALOG] Scheduled refresh failed:", safeDiagnostic(error.message)));
      }, CACHE_TTL_MS);
      catalogTimer.unref?.();
    }
  });
})();
