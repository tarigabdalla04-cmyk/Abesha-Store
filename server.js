const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 8080;

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
const authAttempts = new Map();

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
  const maxRetries = Number.isFinite(Number(options.maxRetries)) ? Math.max(0, Number(options.maxRetries)) : 3;
  const baseDelayMs = Number.isFinite(Number(options.baseDelayMs)) ? Math.max(250, Number(options.baseDelayMs)) : 1200;
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
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

      if (response.ok) return data;

      const error = new Error(data?.message || data?.error || `Fazer API HTTP ${response.status}`);
      error.status = response.status;
      
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
    if (!fs.existsSync(STORE_SETTINGS_FILE)) {
      fs.writeFileSync(STORE_SETTINGS_FILE, JSON.stringify(DEFAULT_STORE_SETTINGS, null, 2));
      return DEFAULT_STORE_SETTINGS;
    }
    return JSON.parse(fs.readFileSync(STORE_SETTINGS_FILE, "utf8"));
  } catch (error) {
    return DEFAULT_STORE_SETTINGS;
  }
}

let storeSettings = loadStoreSettings();

function saveStoreSettings(settings) {
  try {
    storeSettings = { ...DEFAULT_STORE_SETTINGS, ...settings };
    fs.writeFileSync(STORE_SETTINGS_FILE, JSON.stringify(storeSettings, null, 2));
    return true;
  } catch (error) {
    console.error("[SETTINGS] Save failed:", error.message);
    return false;
  }
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
  else if (value < 500000) step = Number(r.from500000To500000) || 1000;
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
  try {
    const topups = await getAllCategories("topups");
    for (const category of topups) {
      const categoryId = String(category.category_id || category.id || "");
      const categoryName = String(category.name || category.title || categoryId);
      try {
        const response = await fazerGet(`/topups/offers?category_id=${encodeURIComponent(categoryId)}`);
        const offers = getArray(response, ["items", "offers"]);
        for (let i = 0; i < offers.length; i++) {
          const offer = offers[i];
          const priceUsd = offerPriceUsd(offer);
          products.push({
            id: `${categoryId}__offer__${offer?.id || i}`,
            category_id: categoryId,
            name: offerLabel(offer) === "عرض" ? categoryName : `${categoryName} — ${offerLabel(offer)}`,
            type: "topup",
            price_sdg: calculateSalePrice(priceUsd),
            fields: category.fields || []
          });
        }
      } catch (e) {}
      await sleep(200);
    }
  } catch (e) {}

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
  const adminKey = process.env.ADMIN_KEY || "123456";
  return key && String(key).trim() === String(adminKey).trim();
}

app.post("/api/admin/login", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const { adminKey, key, password } = req.body || {};
  const inputKey = adminKey || key || password;

  if (verifyAdminKey(inputKey)) {
    return res.json({ ok: true, message: "تم تسجيل الدخول بنجاح" });
  }

  return res.status(401).json({ ok: false, error: "مفتاح الإدارة غير صحيح." });
});

app.get("/api/admin/settings", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!verifyAdminKey(key)) {
    return res.status(401).json({ ok: false, error: "غير مصرح بالدخول" });
  }
  res.json({ ok: true, settings: storeSettings });
});

app.post("/api/admin/settings", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const key = req.headers["x-admin-key"] || req.body?.adminKey;
  if (!verifyAdminKey(key)) {
    return res.status(401).json({ ok: false, error: "غير مصرح بالدخول" });
  }

  if (req.body?.settings) {
    saveStoreSettings(req.body.settings);
    pricedCatalogCache = null; // إعادة بناء الكاش عند تغيير التسعير
    return res.json({ ok: true, message: "تم حفظ الإعدادات بنجاح", settings: storeSettings });
  }

  res.status(400).json({ ok: false, error: "بيانات غير صالحة" });
});

// ======================================================
// المسارات العامة (PUBLIC API & ROUTES)
// ======================================================

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, status: "healthy", timestamp: new Date().toISOString() });
});

app.get("/api/products", async (req, res) => {
  try {
    const products = await getPricedCatalog();
    const visible = products.filter(productVisibility).filter(p => Number(p.price_sdg) > 0);
    res.json({ ok: true, total: visible.length, products: visible });
  } catch (error) {
    res.status(500).json({ ok: false, error: "تعذر تحميل المنتجات." });
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

    res.json({ ok: true, orders: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: "تعذر استرجاع الطلبات." });
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

// ======================================================
// التشغيل الرئيسي لسيرفر Express
// ======================================================

(async () => {
  try {
    await initDatabase();
  } catch (error) {
    console.error("[DB] Initialization error:", error.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`ABESHA STORE running on port ${PORT}`);
    console.log(`Pricing USD -> SDG: ${getPricingConfig().usdToSdg}`);
  });
})();
 express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// الاتصال بقاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect()
  .then(() => console.log('[DB] PostgreSQL ready'))
  .catch(err => console.error('[DB] Connection error:', err.message));

// مسار فحص الصحة - يجب أن يستجيب فوراً بدون أي تأخير
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ذاكرة تخزين مؤقتة للكتالوج
let catalogCache = [];
let lastFetchTime = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 دقيقة

// دالة جلب كل المنتجات من Fazer مع الترقيم الصفحي (Pagination)
async function fetchAllFazerProducts() {
  const apiKey = process.env.FAZER_API_KEY;
  if (!apiKey) return [];

  let allProducts = [];
  let page = 1;
  let hasMore = true;

  try {
    while (hasMore && page <= 15) {
      const response = await fetch(`https://api.fazer.net/v1/products?page=${page}&limit=1000`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!response.ok) break;

      const data = await response.json();
      const items = data.products || data.data || (Array.isArray(data) ? data : []);

      if (!items || items.length === 0) {
        hasMore = false;
      } else {
        allProducts = allProducts.concat(items);
        page++;
        if (items.length < 1000) hasMore = false;
      }
    }
  } catch (err) {
    console.error('[FAZER API ERROR]', err.message);
  }
  return allProducts;
}

// مسار جلب المنتجات للمتجر وللوحة الإدارة
app.get('/api/products', async (req, res) => {
  try {
    const now = Date.now();
    if (catalogCache.length === 0 || (now - lastFetchTime) > CACHE_DURATION) {
      console.log('[PRICE CACHE] Building complete catalog...');
      const rawProducts = await fetchAllFazerProducts();

      catalogCache = rawProducts.map(item => {
        let cat = (item.category || item.category_name || 'عام').trim();
        if (cat.toLowerCase().includes('steam')) cat = 'Steam';

        return {
          id: item.id || item.product_id,
          name: item.name || item.title,
          category: cat,
          price: item.price,
          image: item.image || item.icon || ''
        };
      });
      lastFetchTime = now;
    }
    res.json({ ok: true, success: true, count: catalogCache.length, products: catalogCache });
  } catch (err) {
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// مسار تسجيل دخول الإدارة المصلح
app.post('/api/admin/login', (req, res) => {
  const keyInput = req.body.adminKey || req.body.key;
  const envAdminKey = process.env.ADMIN_KEY;

  if (!envAdminKey) {
    return res.status(500).json({ ok: false, error: 'مفتاح الإدارة غير مضبوط في السيرفر.' });
  }

  if (keyInput === envAdminKey) {
    return res.json({ ok: true, message: 'تم تسجيل الدخول بنجاح' });
  } else {
    return res.status(401).json({ ok: false, error: 'مفتاح الإدارة غير صحيح' });
  }
});

app.listen(PORT, () => {
  console.log(`ABESHA STORE running on port ${PORT}`);
});
