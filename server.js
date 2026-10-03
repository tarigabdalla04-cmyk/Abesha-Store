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
// PostgreSQL
// ======================================================

const dbPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : undefined,
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

// ======================================================
// أدوات العملاء والجلسات
// ======================================================

function normalizePhone(value) {
  return String(value || "")
    .replace(/[^0-9]/g, "")
    .slice(0, 20);
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
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
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }

  return out;
}

function setSessionCookie(res, token) {
  const secure =
    process.env.NODE_ENV === "production" ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(
      token
    )}; Max-Age=${SESSION_DAYS * 86400}; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
}

function clearSessionCookie(res) {
  const secure =
    process.env.NODE_ENV === "production" ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`
  );
}

function hashSessionToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);

  const derived = await scryptAsync(
    String(password),
    salt,
    64,
    {
      N: 16384,
      r: 8,
      p: 1
    }
  );

  return {
    hash: Buffer.from(derived).toString("base64"),
    salt: salt.toString("base64")
  };
}

async function verifyPassword(password, hash, salt) {
  const derived = await scryptAsync(
    String(password),
    Buffer.from(salt, "base64"),
    64,
    {
      N: 16384,
      r: 8,
      p: 1
    }
  );

  const expected = Buffer.from(hash, "base64");

  return (
    expected.length === derived.length &&
    crypto.timingSafeEqual(
      expected,
      Buffer.from(derived)
    )
  );
}

function authRateLimited(req) {
  const key =
    `${req.ip || "unknown"}:` +
    `${normalizePhone(req.body?.phone) || "none"}`;

  const now = Date.now();

  const record =
    authAttempts.get(key) || {
      count: 0,
      resetAt: now + 15 * 60 * 1000
    };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + 15 * 60 * 1000;
  }

  record.count += 1;

  authAttempts.set(key, record);

  return record.count > 12;
}

// تنظيف سجل محاولات الدخول من الذاكرة
setInterval(() => {
  const now = Date.now();

  for (const [key, record] of authAttempts.entries()) {
    if (now > record.resetAt) {
      authAttempts.delete(key);
    }
  }
}, 15 * 60 * 1000).unref();

// ======================================================
// قاعدة البيانات
// ======================================================

async function initDatabase() {
  if (!dbPool) {
    console.warn(
      "[DB] DATABASE_URL is not configured."
    );
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
      customer_id BIGINT NOT NULL
        REFERENCES customers(id)
        ON DELETE CASCADE,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS sessions_customer_idx
      ON sessions(customer_id);

    CREATE INDEX IF NOT EXISTS sessions_expiry_idx
      ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_number VARCHAR(32) NOT NULL UNIQUE,
      customer_id BIGINT NOT NULL
        REFERENCES customers(id)
        ON DELETE RESTRICT,
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

    CREATE INDEX IF NOT EXISTS orders_customer_idx
      ON orders(customer_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL
        REFERENCES orders(id)
        ON DELETE CASCADE,
      product_id VARCHAR(200) NOT NULL,
      product_name VARCHAR(500) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price_sdg NUMERIC(14,2) NOT NULL,
      fields_json JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS order_items_order_idx
      ON order_items(order_id);
  `);

  await dbPool.query(
    "DELETE FROM sessions WHERE expires_at < NOW()"
  );

  console.log("[DB] PostgreSQL ready");

  return true;
}

async function getCurrentCustomer(req) {
  if (!dbPool) return null;

  const token =
    parseCookies(req)[SESSION_COOKIE];

  if (!token) return null;

  const tokenHash =
    hashSessionToken(token);

  const result = await dbPool.query(
    `
      SELECT c.id, c.name, c.phone
      FROM sessions s
      JOIN customers c
        ON c.id = s.customer_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
      LIMIT 1
    `,
    [tokenHash]
  );

  return result.rows[0] || null;
}

async function requireCustomer(req, res, next) {
  try {
    const customer =
      await getCurrentCustomer(req);

    if (!customer) {
      clearSessionCookie(res);

      return res.status(401).json({
        ok: false,
        error: "Authentication required"
      });
    }

    req.customer = customer;

    next();
  } catch (error) {
    console.error(
      "[AUTH] Session check failed:",
      error.message
    );

    res.status(503).json({
      ok: false,
      error: "Authentication service unavailable"
    });
  }
}

function requireDatabase(res) {
  if (!dbPool) {
    res.status(503).json({
      ok: false,
      error: "Database is not configured"
    });

    return false;
  }

  return true;
}

// ======================================================
// إعدادات المتجر والتسعير
// ======================================================

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const PRICE_CACHE_VERSION = 6;

const PRICE_CACHE_FILE =
  path.join(__dirname, "pricing-cache.json");

const STORE_SETTINGS_FILE =
  path.join(__dirname, "store-settings.json");

const STORE_SETTINGS_VERSION = 2;

const DEFAULT_STORE_SETTINGS = {
  version: STORE_SETTINGS_VERSION,

  catalogMode: "all",

  publishedIds: [],

  hiddenIds: [],

  discounts: {},

  pricing: {
    usdToSdg: DEFAULT_USD_TO_SDG,

    tiers: [
      {
        maxCost: 20000,
        markup: 0.07
      },
      {
        maxCost: 100000,
        markup: 0.08
      },
      {
        maxCost: 300000,
        markup: 0.09
      },
      {
        maxCost: null,
        markup: 0.10
      }
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
  return JSON.parse(
    JSON.stringify(DEFAULT_STORE_SETTINGS)
  );
}

function saveStoreSettings(settings) {
  try {
    fs.writeFileSync(
      STORE_SETTINGS_FILE,
      JSON.stringify(settings, null, 2),
      "utf8"
    );
  } catch (error) {
    console.warn(
      "[STORE SETTINGS] Save failed:",
      error.message
    );
  }
}

function loadStoreSettings() {
  try {
    if (!fs.existsSync(STORE_SETTINGS_FILE)) {
      const defaults =
        cloneDefaultStoreSettings();

      saveStoreSettings(defaults);

      return defaults;
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          STORE_SETTINGS_FILE,
          "utf8"
        )
      );

    const defaults =
      cloneDefaultStoreSettings();

    const pricing =
      parsed.pricing &&
      typeof parsed.pricing === "object"
        ? parsed.pricing
        : {};

    let tiers =
      Array.isArray(pricing.tiers) &&
      pricing.tiers.length === 4
        ? pricing.tiers.map((tier, index) => ({
            maxCost:
              index === 3
                ? null
                : Number(tier.maxCost),

            markup:
              Number(tier.markup)
          }))
        : defaults.pricing.tiers;

    const validTiers =
      tiers.length === 4 &&
      tiers.every((tier, index) => {
        if (
          !Number.isFinite(tier.markup) ||
          tier.markup < 0
        ) {
          return false;
        }

        if (index < 3) {
          return (
            Number.isFinite(tier.maxCost) &&
            tier.maxCost > 0
          );
        }

        return true;
      });

    if (!validTiers) {
      tiers = defaults.pricing.tiers;
    }

    return {
      ...defaults,
      ...parsed,

      publishedIds:
        Array.isArray(parsed.publishedIds)
          ? parsed.publishedIds
          : [],

      hiddenIds:
        Array.isArray(parsed.hiddenIds)
          ? parsed.hiddenIds
          : [],

      discounts:
        parsed.discounts &&
        typeof parsed.discounts === "object"
          ? parsed.discounts
          : {},

      pricing: {
        ...defaults.pricing,
        ...pricing,

        usdToSdg:
          Number.isFinite(
            Number(pricing.usdToSdg)
          ) &&
          Number(pricing.usdToSdg) > 0
            ? Number(pricing.usdToSdg)
            : defaults.pricing.usdToSdg,

        tiers,

        rounding: {
          ...defaults.pricing.rounding,
          ...(pricing.rounding || {})
        }
      }
    };
  } catch (error) {
    console.warn(
      "[STORE SETTINGS] Load failed:",
      error.message
    );

    return cloneDefaultStoreSettings();
  }
}

let storeSettings =
  loadStoreSettings();

function saveStoreSettingsNow() {
  storeSettings.version =
    STORE_SETTINGS_VERSION;

  saveStoreSettings(storeSettings);
}

// ======================================================
// التسعير
// ======================================================

function getPricingConfig() {
  const pricing =
    storeSettings?.pricing ||
    DEFAULT_STORE_SETTINGS.pricing;

  return {
    usdToSdg:
      Number(pricing.usdToSdg) > 0
        ? Number(pricing.usdToSdg)
        : DEFAULT_USD_TO_SDG,

    tiers:
      Array.isArray(pricing.tiers) &&
      pricing.tiers.length === 4
        ? pricing.tiers
        : DEFAULT_STORE_SETTINGS.pricing.tiers,

    rounding: {
      ...DEFAULT_STORE_SETTINGS.pricing.rounding,
      ...(pricing.rounding || {})
    }
  };
}

function getMarkupForCost(costSdg) {
  const pricing =
    getPricingConfig();

  const tier =
    pricing.tiers.find(item => {
      const max =
        item.maxCost == null
          ? Infinity
          : Number(item.maxCost);

      return costSdg <= max;
    });

  return tier
    ? Number(tier.markup)
    : 0.10;
}

function roundCommercialPrice(value) {
  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return null;
  }

  const rounding =
    getPricingConfig().rounding;

  let step;

  if (value < 10000) {
    step =
      Number(rounding.under10000) ||
      100;
  } else if (value < 100000) {
    step =
      Number(rounding.from10000To100000) ||
      500;
  } else if (value < 500000) {
    step =
      Number(rounding.from100000To500000) ||
      1000;
  } else {
    step =
      Number(rounding.from500000) ||
      5000;
  }

  return Math.ceil(value / step) * step;
}

function calculateSalePrice(priceUsd) {
  const usd = Number(priceUsd);

  if (
    !Number.isFinite(usd) ||
    usd <= 0
  ) {
    return null;
  }

  const pricing =
    getPricingConfig();

  const costSdg =
    usd * pricing.usdToSdg;

  const markup =
    getMarkupForCost(costSdg);

  return roundCommercialPrice(
    costSdg * (1 + markup)
  );
}

// هذا الحقل يستخدم للتوافق فقط.
// السعر الحقيقي الذي يعتمد عليه المتجر هو price_sdg.
function frontendCompatibleUsd(saleSdg) {
  const sale = Number(saleSdg);

  if (
    !Number.isFinite(sale) ||
    sale <= 0
  ) {
    return null;
  }

  return (
    sale /
    getPricingConfig().usdToSdg
  );
}

// ======================================================
// أدوات Fazer
// ======================================================

function requireFazerKey() {
  if (!process.env.FAZER_API_KEY) {
    const error =
      new Error(
        "FAZER_API_KEY is not configured"
      );

    error.status = 500;

    throw error;
  }
}

function fazerHeaders(extra = {}) {
  return {
    "X-API-Key":
      process.env.FAZER_API_KEY,

    "Accept":
      "application/json",

    ...extra
  };
}

async function fazerFetch(
  endpoint,
  options = {}
) {
  requireFazerKey();

  const maxRetries =
    Number.isFinite(
      Number(options.maxRetries)
    )
      ? Math.max(
          0,
          Number(options.maxRetries)
        )
      : 3;

  const baseDelayMs =
    Number.isFinite(
      Number(options.baseDelayMs)
    )
      ? Math.max(
          250,
          Number(options.baseDelayMs)
        )
      : 1200;

  const timeoutMs =
    options.timeoutMs || 30000;

  for (
    let attempt = 0;
    attempt <= maxRetries;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        timeoutMs
      );

    try {
      const response =
        await fetch(
          `${FAZER_API}${endpoint}`,
          {
            ...options,

            method:
              options.method || "GET",

            headers: {
              ...fazerHeaders(
                options.headers || {}
              )
            },

            signal:
              controller.signal
          }
        );

      const text =
        await response.text();

      let data;

      try {
        data =
          text
            ? JSON.parse(text)
            : {};
      } catch {
        data = {
          raw: text
        };
      }

      if (response.ok) {
        return data;
      }

      const error =
        new Error(
          data?.message ||
          data?.error ||
          `Fazer API HTTP ${response.status}`
        );

      error.status =
        response.status;

      error.data = data;

      error.retryAfter =
        response.headers.get(
          "retry-after"
        );

      const retryable =
        [
          429,
          500,
          502,
          503,
          504
        ].includes(
          response.status
        );

      if (
        !retryable ||
        attempt >= maxRetries
      ) {
        throw error;
      }

      let waitMs = 0;

      const retryAfter =
        Number(
          error.retryAfter
        );

      if (
        Number.isFinite(
          retryAfter
        ) &&
        retryAfter > 0
      ) {
        waitMs =
          retryAfter * 1000;
      } else {
        waitMs =
          Math.min(
            15000,
            baseDelayMs *
              (2 ** attempt)
          );

        waitMs +=
          Math.floor(
            Math.random() * 400
          );
      }

      console.warn(
        `[FAZER] HTTP ${response.status}; ` +
        `retry ${attempt + 1}/${maxRetries} ` +
        `in ${waitMs}ms: ${endpoint}`
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            waitMs
          )
      );
    } catch (error) {
      const retryable =
        error?.name ===
          "AbortError" ||
        [
          429,
          500,
          502,
          503,
          504
        ].includes(
          error?.status
        );

      if (
        !retryable ||
        attempt >= maxRetries
      ) {
        throw error;
      }

      const waitMs =
        Math.min(
          15000,
          baseDelayMs *
            (2 ** attempt)
        ) +
        Math.floor(
          Math.random() * 400
        );

      console.warn(
        `[FAZER] ${
          error.name === "AbortError"
            ? "timeout"
            : `HTTP ${error.status}`
        }; retry ${attempt + 1}/${maxRetries} ` +
        `in ${waitMs}ms: ${endpoint}`
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            waitMs
          )
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    "Fazer request failed after retries"
  );
}

async function fazerGet(
  endpoint,
  timeoutMs = 30000
) {
  return fazerFetch(
    endpoint,
    {
      method: "GET",
      timeoutMs
    }
  );
}

function getArray(
  data,
  keys = [
    "items",
    "offers",
    "cards"
  ]
) {
  for (const key of keys) {
    if (
      Array.isArray(
        data?.[key]
      )
    ) {
      return data[key];
    }
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (
    Array.isArray(
      data?.data
    )
  ) {
    return data.data;
  }

  if (
    Array.isArray(
      data?.data?.items
    )
  ) {
    return data.data.items;
  }

  if (
    Array.isArray(
      data?.data?.offers
    )
  ) {
    return data.data.offers;
  }

  if (
    Array.isArray(
      data?.data?.cards
    )
  ) {
    return data.data.cards;
  }

  return [];
}

async function getAllCategories(
  endpoint
) {
  const items = [];

  let cursor = null;

  for (
    let page = 0;
    page < 500;
    page++
  ) {
    const query =
      cursor
        ? `?cursor=${encodeURIComponent(cursor)}`
        : "";

    const data =
      await fazerGet(
        `${endpoint}${query}`
      );

    const pageItems =
      getArray(
        data,
        [
          "items",
          "categories",
          "games"
        ]
      );

    if (pageItems.length) {
      items.push(
        ...pageItems
      );
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

// ======================================================
// بيانات عروض Fazer
// ======================================================

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

    if (
      Number.isFinite(n) &&
      n > 0
    ) {
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

function offerUniqueId(
  offer,
  index
) {
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
// الخصومات
// ======================================================

function parseOptionalDate(value) {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const date =
    new Date(value);

  if (
    !Number.isFinite(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
}

function normalizeDiscount(raw) {
  if (
    !raw ||
    typeof raw !== "object"
  ) {
    return null;
  }

  const type =
    raw.type === "fixed"
      ? "fixed"
      : "percent";

  const value =
    Number(raw.value);

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return null;
  }

  if (
    type === "percent" &&
    value >= 100
  ) {
    return null;
  }

  if (
    type === "fixed" &&
    value >= 100000000
  ) {
    return null;
  }

  const startsAt =
    parseOptionalDate(
      raw.startsAt
    );

  const endsAt =
    parseOptionalDate(
      raw.endsAt
    );

  if (
    raw.startsAt &&
    !startsAt
  ) {
    return null;
  }

  if (
    raw.endsAt &&
    !endsAt
  ) {
    return null;
  }

  if (
    startsAt &&
    endsAt &&
    Date.parse(startsAt) >
      Date.parse(endsAt)
  ) {
    return null;
  }

  return {
    type,
    value,
    startsAt,
    endsAt,
    active:
      raw.active !== false,
    label:
      String(
        raw.label ||
          "عرض خاص"
      )
        .trim()
        .slice(0, 100)
  };
}

function isDiscountActive(
  discount
) {
  if (
    !discount ||
    discount.active === false
  ) {
    return false;
  }

  const now =
    Date.now();

  if (discount.startsAt) {
    const start =
      Date.parse(
        discount.startsAt
      );

    if (
      Number.isFinite(start) &&
      now < start
    ) {
      return false;
    }
  }

  if (discount.endsAt) {
    const end =
      Date.parse(
        discount.endsAt
      );

    if (
      Number.isFinite(end) &&
      now > end
    ) {
      return false;
    }
  }

  return true;
}

function applyDiscount(
  basePrice,
  discount
) {
  const base =
    Number(basePrice);

  if (
    !Number.isFinite(base) ||
    base <= 0 ||
    !isDiscountActive(
      discount
    )
  ) {
    return {
      price: basePrice,
      originalPrice: null,
      discount: null
    };
  }

  let sale = base;

  if (
    discount.type ===
    "fixed"
  ) {
    sale =
      base -
      Number(
        discount.value
      );
  } else {
    sale =
      base *
      (
        1 -
        Number(
          discount.value
        ) / 100
      );
  }

  sale =
    roundCommercialPrice(
      Math.max(100, sale)
    );

  if (
    !sale ||
    sale >= base
  ) {
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

// ======================================================
// تصنيف المنتجات
// ======================================================

function classifyStoreCategory(
  product
) {
  const family =
    String(
      product.family ||
      product.product_family ||
      product.productFamily ||
      ""
    )
      .toLowerCase()
      .replace(
        /[\s_-]+/g,
        ""
      );

  const type =
    String(
      product.type || ""
    )
      .toLowerCase()
      .replace(
        /[\s_-]+/g,
        ""
      );

  const raw = [
    product.category,
    product.subcategory,
    product.brand,
    product.name,
    product.title,
    product.base_name,
    product.product_name,
    product.productName,
    product.description,
    product.platform,
    product.region,
    product.tags,
    product.offer?.category,
    product.offer?.subcategory,
    product.offer?.brand,
    product.offer?.name,
    product.offer?.title,
    product.offer?.description,
    product.offer?.platform,
    product.offer?.tags
  ]
    .flat()
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    family === "steam" ||
    type === "steam" ||
    /\bsteam\b/.test(raw)
  ) {
    return "steam";
  }

  const subscriptionSignals = [
    "subscription",
    "membership",
    "netflix",
    "spotify",
    "game pass",
    "xbox game pass",
    "playstation plus",
    "ps plus",
    "apple music",
    "youtube premium",
    "prime video",
    "disney+",
    "disney plus",
    "crunchyroll",
    "discord nitro",
    "nitro"
  ];

  if (
    subscriptionSignals.some(
      x => raw.includes(x)
    )
  ) {
    return "subscription";
  }

  if (
    family === "giftcard" ||
    family === "gift_card" ||
    family === "gift-card" ||
    type === "giftcard" ||
    type === "gift_card"
  ) {
    return "gift";
  }

  if (
    family === "topup" ||
    type === "topup"
  ) {
    return "mobile";
  }

  if (
    family === "gamekey" ||
    type === "gamekey"
  ) {
    return "game";
  }

  if (
    /\b(pubg|free fire|roblox|valorant|mobile legends|call of duty mobile)\b/
      .test(raw)
  ) {
    return "mobile";
  }

  if (
    /gift card|giftcard|google play|apple gift|playstation|xbox|nintendo/
      .test(raw)
  ) {
    return "gift";
  }

  return "game";
}

// ======================================================
// رؤية المنتجات
// ======================================================

function productVisibility(
  product
) {
  const id =
    String(product.id || "");

  if (
    storeSettings.hiddenIds.includes(id)
  ) {
    return false;
  }

  if (
    storeSettings.catalogMode ===
    "curated"
  ) {
    return storeSettings.publishedIds.includes(
      id
    );
  }

  return true;
}

function enrichProductForStore(
  product
) {
  const basePrice =
    Number(product.price_sdg);

  const discount =
    storeSettings.discounts[
      String(product.id)
    ];

  const pricing =
    applyDiscount(
      basePrice,
      discount
    );

  const result = {
    ...product,

    price_sdg:
      pricing.price,

    store_category:
      product.store_category ||
      classifyStoreCategory(
        product
      ),

    original_price_sdg:
      pricing.originalPrice,

    discount:
      pricing.discount
  };

  delete result.source_price_usd;
  delete result.cost_sdg;
  delete result.markup_percent;
  delete result.price_usd;
  delete result.offer;

  return result;
}

function getAdminProduct(
  product
) {
  return {
    ...product,

    published:
      productVisibility(
        product
      ),

    discount:
      storeSettings.discounts[
        String(product.id)
      ] || null
  };
}

function getPublicProducts(
  products
) {
  return products
    .filter(
      productVisibility
    )
    .filter(
      product =>
        Number(product.price_sdg) > 0
    )
    .map(
      enrichProductForStore
    );
}

// ======================================================
// Cache
// ======================================================

let pricedCatalogCache = null;
let pricedCatalogBuiltAt = 0;
let priceRefreshPromise = null;

function loadPriceCacheFromDisk() {
  try {
    if (
      !fs.existsSync(
        PRICE_CACHE_FILE
      )
    ) {
      return;
    }

    const parsed =
      JSON.parse(
        fs.readFileSync(
          PRICE_CACHE_FILE,
          "utf8"
        )
      );

    if (
      parsed &&
      parsed.version ===
        PRICE_CACHE_VERSION &&
      Array.isArray(
        parsed.products
      ) &&
      Number.isFinite(
        parsed.builtAt
      )
    ) {
      pricedCatalogCache =
        parsed.products;

      pricedCatalogBuiltAt =
        parsed.builtAt;

      console.log(
        `[PRICE CACHE] Loaded ` +
        `${pricedCatalogCache.length} products`
      );
    }
  } catch (error) {
    console.warn(
      "[PRICE CACHE] Load failed:",
      error.message
    );
  }
}

function savePriceCacheToDisk(
  products
) {
  try {
    fs.writeFileSync(
      PRICE_CACHE_FILE,
      JSON.stringify(
        {
          version:
            PRICE_CACHE_VERSION,

          builtAt:
            Date.now(),

          usdToSdg:
            getPricingConfig()
              .usdToSdg,

          products
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.warn(
      "[PRICE CACHE] Save failed:",
      error.message
    );
  }
}

function cacheIsFresh() {
  return (
    Array.isArray(
      pricedCatalogCache
    ) &&
    pricedCatalogCache.length > 0 &&
    Date.now() -
      pricedCatalogBuiltAt <
      CACHE_TTL_MS
  );
}

// ======================================================
// محدودية التوازي
// ======================================================

async function mapWithConcurrency(
  items,
  worker,
  concurrency = 2
) {
  const results =
    new Array(
      items.length
    );

  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index =
        nextIndex++;

      if (
        index >= items.length
      ) {
        return;
      }

      try {
        results[index] =
          await worker(
            items[index],
            index
          );
      } catch (error) {
        results[index] = {
          __error: true,
          error:
            error.message
        };
      }
    }
  }

  const count =
    Math.min(
      concurrency,
      items.length
    );

  await Promise.all(
    Array.from(
      { length: count },
      () => runner()
    )
  );

  return results;
}

// ======================================================
// عروض المنتجات
// ======================================================

async function getTopupOffers(
  categoryId
) {
  const data =
    await fazerGet(
      `/topups/offers?category_id=${encodeURIComponent(
        categoryId
      )}`
    );

  return getArray(
    data,
    [
      "items",
      "offers"
    ]
  );
}

async function getGiftcardOffers(
  categoryId
) {
  const data =
    await fazerGet(
      `/giftcards/cards?category_id=${encodeURIComponent(
        categoryId
      )}`
    );

  return getArray(
    data,
    [
      "items",
      "cards",
      "offers"
    ]
  );
}

async function getGameKeyOffers(
  gameId
) {
  const data =
    await fazerGet(
      `/gamekeys/keys?game_id=${encodeURIComponent(
        gameId
      )}`
    );

  return getArray(
    data,
    [
      "keys",
      "items",
      "offers"
    ]
  );
}

// ======================================================
// بناء الكتالوج المسعر
// ======================================================

async function buildPricedCatalog() {
  console.log(
    "[PRICE CACHE] Building catalog..."
  );

  const familyResults = [];

  for (
    const family of [
      "topups",
      "giftcards",
      "gamekeys"
    ]
  ) {
    try {
      familyResults.push({
        status:
          "fulfilled",
        value:
          await getAllCategories(
            family
          )
      });
    } catch (error) {
      familyResults.push({
        status:
          "rejected",
        reason:
          error
      });

      console.warn(
        `[PRICE] ${family} unavailable:`,
        error.message
      );
    }
  }

  const topups =
    familyResults[0].status ===
    "fulfilled"
      ? familyResults[0].value
      : [];

  const giftcards =
    familyResults[1].status ===
    "fulfilled"
      ? familyResults[1].value
      : [];

  const gamekeys =
    familyResults[2].status ===
    "fulfilled"
      ? familyResults[2].value
      : [];

  const products = [];

  // ----------------------------------------------------
  // TOPUPS
  // ----------------------------------------------------

  const topupResults =
    await mapWithConcurrency(
      topups,
      async category => {
        const categoryId =
          String(
            category.category_id ||
            category.id ||
            ""
          );

        const categoryName =
          String(
            category.name ||
            category.title ||
            categoryId
          );

        try {
          const offers =
            await getTopupOffers(
              categoryId
            );

          return offers.map(
            (offer, index) => {
              const label =
                offerLabel(
                  offer
                );

              const priceUsd =
                offerPriceUsd(
                  offer
                );

              const calculatedPrice =
                calculateSalePrice(
                  priceUsd
                );

              return {
                id:
                  `${categoryId}__offer__${offerUniqueId(
                    offer,
                    index
                  )}`,

                category_id:
                  categoryId,

                name:
                  label === "عرض"
                    ? categoryName
                    : `${categoryName} — ${label}`,

                base_name:
                  categoryName,

                type:
                  "topup",

                note:
                  category.note ||
                  "",

                fields:
                  category.fields ||
                  [],

                price_usd:
                  frontendCompatibleUsd(
                    calculatedPrice
                  ),

                source_price_usd:
                  priceUsd,

                cost_sdg:
                  priceUsd
                    ? Math.round(
                        priceUsd *
                          getPricingConfig()
                            .usdToSdg
                      )
                    : null,

                markup_percent:
                  priceUsd
                    ? getMarkupForCost(
                        priceUsd *
                          getPricingConfig()
                            .usdToSdg
                      ) * 100
                    : null,

                price_sdg:
                  calculatedPrice,

                pricing_mode:
                  "automatic",

                offer
              };
            }
          );
        } catch (error) {
          console.warn(
            `[PRICE] Topup ${categoryId} failed:`,
            error.message
          );

          return [
            {
              id:
                categoryId,

              category_id:
                categoryId,

              name:
                categoryName,

              type:
                "topup",

              note:
                category.note ||
                "",

              fields:
                category.fields ||
                [],

              price_usd:
                null,

              price_sdg:
                null,

              pricing_mode:
                "unavailable"
            }
          ];
        }
      },
      2
    );

  for (
    const result of topupResults
  ) {
    if (
      Array.isArray(result)
    ) {
      products.push(
        ...result
      );
    }
  }

  // ----------------------------------------------------
  // GIFT CARDS
  // ----------------------------------------------------

  const giftcardResults =
    await mapWithConcurrency(
      giftcards,
      async category => {
        const categoryId =
          String(
            category.category_id ||
            category.id ||
            ""
          );

        const categoryName =
          String(
            category.name ||
            category.title ||
            categoryId
          );

        try {
          const offers =
            await getGiftcardOffers(
              categoryId
            );

          return offers.map(
            (offer, index) => {
              const label =
                offerLabel(
                  offer
                );

              const priceUsd =
                offerPriceUsd(
                  offer
                );

              const calculatedPrice =
                calculateSalePrice(
                  priceUsd
                );

              return {
                id:
                  `${categoryId}__card__${offerUniqueId(
                    offer,
                    index
                  )}`,

                category_id:
                  categoryId,

                name:
                  label === "عرض"
                    ? categoryName
                    : `${categoryName} — ${label}`,

                base_name:
                  categoryName,

                type:
                  "gift_card",

                note:
                  category.note ||
                  "",

                fields:
                  category.fields ||
                  [],

                price_usd:
                  frontendCompatibleUsd(
                    calculatedPrice
                  ),

                source_price_usd:
                  priceUsd,

                cost_sdg:
                  priceUsd
                    ? Math.round(
                        priceUsd *
                          getPricingConfig()
                            .usdToSdg
                      )
                    : null,

                markup_percent:
                  priceUsd
                    ? getMarkupForCost(
                        priceUsd *
                          getPricingConfig()
                            .usdToSdg
                      ) * 100
                    : null,

                price_sdg:
                  calculatedPrice,

                pricing_mode:
                  "automatic",

                stock:
                  offer?.stock ??
                  null,

                min_order_quantity:
                  offer?.min_order_quantity ??
                  1,

                max_order_quantity:
                  offer?.max_order_quantity ??
                  null,

                offer
              };
            }
          );
        } catch (error) {
          console.warn(
            `[PRICE] Gift card ${categoryId} failed:`,
            error.message
          );

          return [
            {
              id:
                categoryId,

              category_id:
                categoryId,

              name:
                categoryName,

              type:
                "gift_card",

              note:
                category.note ||
                "",

              fields:
                category.fields ||
                [],

              price_usd:
                null,

              price_sdg:
                null,

              pricing_mode:
                "unavailable"
            }
          ];
        }
      },
      2
    );

  for (
    const result of
      giftcardResults
  ) {
    if (
      Array.isArray(result)
    ) {
      products.push(
        ...result
      );
    }
  }

  // ----------------------------------------------------
  // GAME KEYS
  // ----------------------------------------------------

  const gameKeyResults =
    await mapWithConcurrency(
      gamekeys,
      async game => {
        const gameId =
          String(
            