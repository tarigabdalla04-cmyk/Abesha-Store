const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const FAZER_API = "https://api.fzr.cards/api/v2";
const USD_TO_SDG = 8250;

// ======================================================
// ABESHA STORE — التسعير المركزي
// ======================================================

const PRICING_TIERS = [
  { maxCost: 20000, markup: 0.07 },
  { maxCost: 100000, markup: 0.08 },
  { maxCost: 300000, markup: 0.09 },
  { maxCost: Infinity, markup: 0.10 }
];

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PRICE_CACHE_VERSION = 4;
const PRICE_CACHE_FILE = path.join(__dirname, "pricing-cache.json");
const STORE_SETTINGS_FILE = path.join(__dirname, "store-settings.json");
const ORDERS_FILE = path.join(__dirname, "orders.json");
const STORE_SETTINGS_VERSION = 1;

const PRICE_OVERRIDES = {
  pubg_mobile_auto: {
    "60": 7950,
    "325": 40000,
    "660": 80000,
    "8100": 800000
  },
  pubg_mobile_fast: {
    "1800": 200000,
    "3850": 400000
  },
  pubg_mobile_manual: {
    "1800": 200000,
    "3850": 400000
  }
};

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

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 30000
  );

  try {
    const response = await fetch(`${FAZER_API}${endpoint}`, {
      ...options,
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

    if (!response.ok) {
      const error = new Error(
        data?.message ||
        data?.error ||
        `Fazer API HTTP ${response.status}`
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
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

function getMarkupForCost(costSdg) {
  const tier = PRICING_TIERS.find(
    item => costSdg <= item.maxCost
  );

  return tier ? tier.markup : 0.10;
}

function roundCommercialPrice(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  let step;

  if (value < 10000) {
    step = 100;
  } else if (value < 100000) {
    step = 500;
  } else if (value < 500000) {
    step = 1000;
  } else {
    step = 5000;
  }

  return Math.ceil(value / step) * step;
}

function calculateSalePrice(priceUsd) {
  const usd = Number(priceUsd);

  if (!Number.isFinite(usd) || usd <= 0) {
    return null;
  }

  const costSdg = usd * USD_TO_SDG;
  const markup = getMarkupForCost(costSdg);
  const sale = costSdg * (1 + markup);

  return roundCommercialPrice(sale);
}

function frontendCompatibleUsd(saleSdg) {
  const sale = Number(saleSdg);

  if (!Number.isFinite(sale) || sale <= 0) {
    return null;
  }

  return sale / (8050 * 1.10);
}

function quantityFromText(text) {
  const match = String(text || "").match(
    /\b(8100|6000|3850|3000|1800|1500|1300|1100|660|650|600|325|300|270|205|170|100|65|60|50|40|20)\b/i
  );

  return match ? Number(match[1]) : null;
}

function getOverride(categoryId, label) {
  const overrides = PRICE_OVERRIDES[categoryId];

  if (!overrides) {
    return null;
  }

  const qty = quantityFromText(label);

  if (qty === null) {
    return null;
  }

  return overrides[String(qty)] || null;
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
  discounts: {}
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

    return {
      ...cloneDefaultStoreSettings(),
      ...parsed,
      publishedIds: Array.isArray(parsed.publishedIds)
        ? parsed.publishedIds
        : [],
      hiddenIds: Array.isArray(parsed.hiddenIds)
        ? parsed.hiddenIds
        : [],
      discounts:
        parsed.discounts &&
        typeof parsed.discounts === "object"
          ? parsed.discounts
          : {}
    };
  } catch (error) {
    console.warn(
      "[STORE SETTINGS] Could not load settings:",
      error.message
    );

    return cloneDefaultStoreSettings();
  }
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
      "[STORE SETTINGS] Could not save settings:",
      error.message
    );
  }
}

let storeSettings = loadStoreSettings();

function normalizeDiscount(raw) {
  if (!raw || typeof raw !== "object") return null;

  const type = raw.type === "fixed" ? "fixed" : "percent";
  const value = Number(raw.value);
  const startsAt = raw.startsAt
    ? new Date(raw.startsAt).toISOString()
    : null;
  const endsAt = raw.endsAt
    ? new Date(raw.endsAt).toISOString()
    : null;
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
    label: String(raw.label || "عرض خاص")
      .trim()
      .slice(0, 100)
  };
}

function isDiscountActive(discount) {
  if (!discount || discount.active === false) return false;

  const now = Date.now();

  if (discount.startsAt) {
    const start = Date.parse(discount.startsAt);

    if (Number.isFinite(start) && now < start) {
      return false;
    }
  }

  if (discount.endsAt) {
    const end = Date.parse(discount.endsAt);

    if (Number.isFinite(end) && now > end) {
      return false;
    }
  }

  return true;
}

function applyDiscount(basePrice, discount) {
  const base = Number(basePrice);

  if (
    !Number.isFinite(base) ||
    base <= 0 ||
    !isDiscountActive(discount)
  ) {
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

  if (storeSettings.hiddenIds.includes(id)) {
    return false;
  }

  if (storeSettings.catalogMode === "curated") {
    return storeSettings.publishedIds.includes(id);
  }

  return true;
}

function enrichProductForStore(product) {
  const basePrice = Number(product.price_sdg);
  const discount = storeSettings.discounts[String(product.id)];
  const pricing = applyDiscount(basePrice, discount);

  const result = {
    ...product,
    price_sdg: pricing.price,
    price_usd: frontendCompatibleUsd(pricing.price),
    original_price_sdg: pricing.originalPrice,
    discount: pricing.discount
  };

  delete result.source_price_usd;
  delete result.cost_sdg;
  delete result.markup_percent;

  return result;
}

function getAdminProduct(product) {
  const discount =
    storeSettings.discounts[String(product.id)] || null;

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

function saveStoreSettingsNow() {
  storeSettings.version = STORE_SETTINGS_VERSION;
  saveStoreSettings(storeSettings);
}

// ======================================================
// Cache الأسعار
// ======================================================

function loadPriceCacheFromDisk() {
  try {
    if (!fs.existsSync(PRICE_CACHE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(
      PRICE_CACHE_FILE,
      "utf8"
    );

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
          usdToSdg: USD_TO_SDG,
          products
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.warn(
      "[PRICE CACHE] Could not save cache:",
      error.message
    );
  }
}

function cacheIsFresh() {
  return (
    Array.isArray(pricedCatalogCache) &&
    pricedCatalogCache.length > 0 &&
    Date.now() - pricedCatalogBuiltAt < CACHE_TTL_MS
  );
}

// ======================================================
// تنفيذ طلبات كثيرة بعدد متوازٍ محدود
// ======================================================

async function mapWithConcurrency(
  items,
  worker,
  concurrency = 6
) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await worker(
          items[index],
          index
        );
      } catch (error) {
        results[index] = {
          __error: true,
          error: error.message
        };
      }
    }
  }

  const count = Math.min(
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
// بناء الكتالوج المسعّر
// ======================================================

async function getTopupOffers(categoryId) {
  const data = await fazerGet(
    `/topups/offers?category_id=${encodeURIComponent(categoryId)}`,
    30000
  );

  return getArray(data, ["items", "offers"]);
}

async function getGiftcardOffers(categoryId) {
  const data = await fazerGet(
    `/giftcards/cards?category_id=${encodeURIComponent(categoryId)}`,
    30000
  );

  return getArray(
    data,
    ["items", "cards", "offers"]
  );
}

async function getGameKeyOffers(gameId) {
  const data = await fazerGet(
    `/gamekeys/keys?game_id=${encodeURIComponent(gameId)}`,
    30000
  );

  return getArray(
    data,
    ["keys", "items", "offers"]
  );
}

async function buildPricedCatalog() {
  console.log(
    "[PRICE CACHE] Building complete priced catalog..."
  );

  const familyResults =
    await Promise.allSettled([
      getAllCategories("topups"),
      getAllCategories("giftcards"),
      getAllCategories("gamekeys")
    ]);

  const topups =
    familyResults[0].status === "fulfilled"
      ? familyResults[0].value
      : [];

  const giftcards =
    familyResults[1].status === "fulfilled"
      ? familyResults[1].value
      : [];

  const gamekeys =
    familyResults[2].status === "fulfilled"
      ? familyResults[2].value
      : [];

  if (familyResults[0].status === "rejected") {
    console.warn(
      `[PRICE] Topups catalog unavailable: ${familyResults[0].reason?.message || familyResults[0].reason}`
    );
  }

  if (familyResults[1].status === "rejected") {
    console.warn(
      `[PRICE] Gift Cards catalog unavailable: ${familyResults[1].reason?.message || familyResults[1].reason}`
    );
  }

  if (familyResults[2].status === "rejected") {
    console.warn(
      `[PRICE] Game Keys catalog unavailable: ${familyResults[2].reason?.message || familyResults[2].reason}`
    );
  }

  const products = [];

  // ----------------------------------------------------
  // Topups
  // ----------------------------------------------------

  const topupResults =
    await mapWithConcurrency(
      topups,
      async category => {
        const categoryId = String(
          category.category_id ||
          category.id ||
          ""
        );

        const categoryName = String(
          category.name ||
          category.title ||
          categoryId
        );

        try {
          const offers =
            await getTopupOffers(categoryId);

          return offers.map(
            (offer, index) => {
              const label =
                offerLabel(offer);

              const priceUsd =
                offerPriceUsd(offer);

              const forcedPrice =
                getOverride(
                  categoryId,
                  label
                );

              const calculatedPrice =
                forcedPrice ??
                calculateSalePrice(
                  priceUsd
                );

              return {
                id:
                  `${categoryId}__offer__${offerUniqueId(
                    offer,
                    index
                  )}`,

                category_id: categoryId,

                name:
                  label === "عرض"
                    ? categoryName
                    : `${categoryName} — ${label}`,

                base_name: categoryName,

                type: "topup",

                note:
                  category.note || "",

                fields:
                  category.fields || [],

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
                        USD_TO_SDG
                      )
                    : null,

                markup_percent:
                  forcedPrice !== null
                    ? "custom"
                    : (
                        priceUsd
                          ? getMarkupForCost(
                              priceUsd *
                              USD_TO_SDG
                            ) * 100
                          : null
                      ),

                price_sdg:
                  calculatedPrice,

                pricing_mode:
                  forcedPrice !== null
                    ? "manual_override"
                    : "automatic",

                offer: offer
              };
            }
          );
        } catch (error) {
          console.warn(
            `[PRICE] Failed topup ${categoryId}: ${error.message}`
          );

          return [
            {
              id: categoryId,
              category_id: categoryId,
              name: categoryName,
              type: "topup",
              note: category.note || "",
              fields: category.fields || [],
              price_usd: null,
              price_sdg: null,
              pricing_mode: "unavailable"
            }
          ];
        }
      },
      6
    );

  for (const result of topupResults) {
    if (Array.isArray(result)) {
      products.push(...result);
    }
  }

  // ----------------------------------------------------
  // Gift Cards
  // ----------------------------------------------------

  const giftcardResults =
    await mapWithConcurrency(
      giftcards,
      async category => {
        const categoryId = String(
          category.category_id ||
          category.id ||
          ""
        );

        const categoryName = String(
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
                offerLabel(offer);

              const priceUsd =
                offerPriceUsd(offer);

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

                type: "gift_card",

                note:
                  category.note || "",

                fields:
                  category.fields || [],

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
                        USD_TO_SDG
                      )
                    : null,

                markup_percent:
                  priceUsd
                    ? getMarkupForCost(
                        priceUsd *
                        USD_TO_SDG
                      ) * 100
                    : null,

                price_sdg:
                  calculatedPrice,

                pricing_mode:
                  "automatic",

                stock:
                  offer?.stock ?? null,

                min_order_quantity:
                  offer?.min_order_quantity ?? 1,

                max_order_quantity:
                  offer?.max_order_quantity ?? null,

                offer: offer
              };
            }
          );
        } catch (error) {
          console.warn(
            `[PRICE] Failed gift card ${categoryId}: ${error.message}`
          );

          return [
            {
              id: categoryId,
              category_id: categoryId,
              name: categoryName,
              type: "gift_card",
              note: category.note || "",
              fields: category.fields || [],
              price_usd: null,
              price_sdg: null,
              pricing_mode: "unavailable"
            }
          ];
        }
      },
      6
    );

  for (const result of giftcardResults) {
    if (Array.isArray(result)) {
      products.push(...result);
    }
  }

  // ----------------------------------------------------
  // Game Keys
  // ----------------------------------------------------

  const gameKeyResults =
    await mapWithConcurrency(
      gamekeys,
      async game => {
        const gameId = String(
          game.game_id ||
          game.category_id ||
          game.id ||
          ""
        );

        const gameName = String(
          game.name ||
          game.GameName ||
          gameId
        );

        try {
          const keys =
            await getGameKeyOffers(
              gameId
            );

          return keys.map(
            (key, index) => {
              const priceUsd =
                offerPriceUsd(key);

              const calculatedPrice =
                calculateSalePrice(
                  priceUsd
                );

              const label =
                offerLabel(key);

              return {
                id:
                  `${gameId}__key__${offerUniqueId(
                    key,
                    index
                  )}`,

                category_id: gameId,

                name:
                  label === "عرض"
                    ? gameName
                    : `${gameName} — ${label}`,

                base_name: gameName,

                type: "game_key",

                platform:
                  game.platform || "",

                region:
                  game.region || "",

                region_restriction:
                  game.region_restriction ||
                  false,

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
                        USD_TO_SDG
                      )
                    : null,

                markup_percent:
                  priceUsd
                    ? getMarkupForCost(
                        priceUsd *
                        USD_TO_SDG
                      ) * 100
                    : null,

                price_sdg:
                  calculatedPrice,

                pricing_mode:
                  "automatic",

                stock:
                  key?.stock ?? null,

                min_order_quantity:
                  key?.min_order_quantity ?? 1,

                max_order_quantity:
                  key?.max_order_quantity ?? null,

                offer: key
              };
            }
          );
        } catch (error) {
          console.warn(
            `[PRICE] Failed game keys ${gameId}: ${error.message}`
          );

          return [
            {
              id: gameId,
              category_id: gameId,
              name: gameName,
              type: "game_key",
              platform: game.platform || "",
              region: game.region || "",
              region_restriction:
                game.region_restriction ||
                false,
              price_usd: null,
              price_sdg: null,
              pricing_mode: "unavailable"
            }
          ];
        }
      },
      6
    );

  for (const result of gameKeyResults) {
    if (Array.isArray(result)) {
      products.push(...result);
    }
  }

  const usablePrices =
    products.filter(
      product =>
        Number.isFinite(
          Number(product.price_sdg)
        ) &&
        Number(product.price_sdg) > 0
    ).length;

  console.log(
    `[PRICE CACHE] Built ${products.length} catalog entries; ${usablePrices} have prices`
  );

  pricedCatalogCache = products;
  pricedCatalogBuiltAt = Date.now();

  savePriceCacheToDisk(products);

  return products;
}

async function getPricedCatalog() {
  if (cacheIsFresh()) {
    return pricedCatalogCache;
  }

  if (priceRefreshPromise) {
    return priceRefreshPromise;
  }

  priceRefreshPromise =
    buildPricedCatalog()
      .catch(error => {
        console.error(
          "[PRICE CACHE] Build failed:",
          error.message
        );

        if (
          Array.isArray(
            pricedCatalogCache
          ) &&
          pricedCatalogCache.length
        ) {
          return pricedCatalogCache;
        }

        throw error;
      })
      .finally(() => {
        priceRefreshPromise = null;
      });

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
      usdToSdg: USD_TO_SDG,
      cacheFresh: cacheIsFresh(),
      cachedProducts:
        pricedCatalogCache?.length || 0
    }
  });
});

// ======================================================
// Fazer /me
// ======================================================

app.get(
  "/api/fazer/me",
  async (req, res) => {
    try {
      const data =
        await fazerGet("/me");

      res.json(data);
    } catch (error) {
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

// ======================================================
// Fazer catalog
// ======================================================

app.get(
  "/api/fazer/catalog",
  async (req, res) => {
    try {
      const results =
        await Promise.allSettled([
          getAllCategories("topups"),
          getAllCategories("giftcards"),
          getAllCategories("gamekeys")
        ]);

      const topups =
        results[0].status === "fulfilled"
          ? results[0].value
          : [];

      const giftcards =
        results[1].status === "fulfilled"
          ? results[1].value
          : [];

      const gamekeys =
        results[2].status === "fulfilled"
          ? results[2].value
          : [];

      res.json({
        ok: true,

        families: {
          topups: {
            ok:
              results[0].status ===
              "fulfilled",
            items: topups
          },

          giftcards: {
            ok:
              results[1].status ===
              "fulfilled",
            items: giftcards
          },

          gamekeys: {
            ok:
              results[2].status ===
              "fulfilled",
            items: gamekeys
          }
        },

        total:
          topups.length +
          giftcards.length +
          gamekeys.length
      });
    } catch (error) {
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

// ======================================================
// Topups
// ======================================================

app.get(
  "/api/fazer/topups",
  async (req, res) => {
    try {
      const items =
        await getAllCategories(
          "topups"
        );

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
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

app.get(
  "/api/fazer/topups/offers",
  async (req, res) => {
    try {
      const categoryId =
        req.query.category_id;

      if (!categoryId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "category_id is required"
          });
      }

      const data =
        await fazerGet(
          `/topups/offers?category_id=${encodeURIComponent(categoryId)}`
        );

      res.json(data);
    } catch (error) {
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

// ======================================================
// Gift Cards
// ======================================================

app.get(
  "/api/fazer/giftcards",
  async (req, res) => {
    try {
      const items =
        await getAllCategories(
          "giftcards"
        );

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
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

app.get(
  "/api/fazer/giftcards/cards",
  async (req, res) => {
    try {
      const categoryId =
        req.query.category_id;

      if (!categoryId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "category_id is required"
          });
      }

      const data =
        await fazerGet(
          `/giftcards/cards?category_id=${encodeURIComponent(categoryId)}`
        );

      res.json(data);
    } catch (error) {
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

// ======================================================
// المنتجات — النسخة المسعّرة
// ======================================================

app.get(
  "/api/products",
  async (req, res) => {
    try {
      const products =
        await getPricedCatalog();

      const visibleProducts =
        getPublicProducts(products);

      res.json({
        ok: true,
        total:
          visibleProducts.length,

        products:
          visibleProducts,

        pricing: {
          currency: "SDG",
          usdToSdg: USD_TO_SDG,

          catalogMode:
            storeSettings.catalogMode,

          tiers:
            PRICING_TIERS.map(
              tier => ({
                maxCost:
                  Number.isFinite(
                    tier.maxCost
                  )
                    ? tier.maxCost
                    : null,

                markupPercent:
                  tier.markup * 100
              })
            ),

          roundRules: {
            under10000: 100,
            from10000To100000: 500,
            from100000To500000: 1000,
            from500000: 5000
          }
        }
      });
    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,
          error: error.message
        });
    }
  }
);

// ======================================================
// تحديث الأسعار يدويًا
// ======================================================

app.post(
  "/api/prices/refresh",
  async (req, res) => {
    try {
      const adminKey =
        req.headers["x-admin-key"];

      if (
        !process.env.ADMIN_KEY ||
        adminKey !==
          process.env.ADMIN_KEY
      ) {
        return res
          .status(401)
          .json({
            ok: false,
            error: "Unauthorized"
          });
      }

      pricedCatalogCache = null;
      pricedCatalogBuiltAt = 0;

      const products =
        await getPricedCatalog();

      res.json({
        ok: true,
        total: products.length,
        refreshedAt:
          new Date().toISOString()
      });
    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,
          error: error.message
        });
    }
  }
);

// ======================================================
// PUBG ID validation
// ======================================================

app.post(
  "/api/fazer/topups/validate-id",
  async (req, res) => {
    try {
      const {
        category_id,
        fields
      } = req.body;

      const data =
        await fazerFetch(
          "/topups/validate-id",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              category_id,
              fields
            })
          }
        );

      res.json(data);
    } catch (error) {
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

// ======================================================
// Game Keys
// ======================================================

app.get(
  "/api/fazer/gamekeys",
  async (req, res) => {
    try {
      const items =
        await getAllCategories(
          "gamekeys"
        );

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
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

// ======================================================
// Steam
// ======================================================

app.get(
  "/api/fazer/steam-topup/rates",
  async (req, res) => {
    try {
      const data =
        await fazerGet(
          "/steam-topup/rates"
        );

      res.json(data);
    } catch (error) {
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

app.get(
  "/api/fazer/steam-gifts/games",
  async (req, res) => {
    try {
      const limit =
        req.query.limit || "100";

      const data =
        await fazerGet(
          `/steam-gifts/games?limit=${encodeURIComponent(limit)}`
        );

      res.json(data);
    } catch (error) {
      res
        .status(error.status || 500)
        .json({
          ok: false,
          error: error.message,
          details:
            error.data || null
        });
    }
  }
);

// ======================================================
// الكتالوج الموحد القديم
// ======================================================

app.get(
  "/api/catalog",
  async (req, res) => {
    try {
      const familyResults =
        await Promise.allSettled([
          getAllCategories("topups"),
          getAllCategories("giftcards"),
          getAllCategories("gamekeys")
        ]);

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

      const products = [
        ...topups.map(item => ({
          id: item.category_id,
          name: item.name,
          type: "topup",
          note: item.note || "",
          fields:
            item.fields || []
        })),

        ...giftcards.map(item => ({
          id: item.category_id,
          name: item.name,
          type: "gift_card",
          note: item.note || "",
          fields:
            item.fields || []
        })),

        ...gamekeys.map(item => ({
          id:
            item.game_id ||
            item.category_id,

          name: item.name,

          type: "game_key",

          platform:
            item.platform || "",

          region:
            item.region || "",

          region_restriction:
            item.region_restriction ||
            false
        }))
      ];

      res.json({
        ok: true,
        total: products.length,
        products
      });
    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,
          error: error.message
        });
    }
  }
);

// ======================================================
// المنتجات المنشورة
// ======================================================

app.get(
  "/api/catalog/published",
  (req, res) => {
    try {
      const configPath =
        path.join(
          __dirname,
          "catalog-config.json"
        );

      const config =
        JSON.parse(
          fs.readFileSync(
            configPath,
            "utf8"
          )
        );

      res.json({
        ok: true,

        total:
          Array.isArray(
            config.published
          )
            ? config.published.length
            : 0,

        published:
          Array.isArray(
            config.published
          )
            ? config.published
            : [],

        pricing:
          config.pricing || {}
      });
    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,
          error: error.message
        });
    }
  }
);

// ======================================================
// الإدارة
// ======================================================

app.get(
  "/api/admin/status",
  (req, res) => {
    res.json({
      ok: true,
      adminKeyConfigured:
        Boolean(
          process.env.ADMIN_KEY
        )
    });
  }
);

function requireAdmin(
  req,
  res,
  next
) {
  const adminKey =
    req.headers["x-admin-key"];

  if (!process.env.ADMIN_KEY) {
    return res
      .status(500)
      .json({
        ok: false,
        error:
          "ADMIN_KEY is not configured"
      });
  }

  if (
    !adminKey ||
    adminKey !==
      process.env.ADMIN_KEY
  ) {
    return res
      .status(401)
      .json({
        ok: false,
        error: "Unauthorized"
      });
  }

  next();
}

app.get(
  "/api/admin/catalog",
  requireAdmin,
  async (req, res) => {
    try {
      const data =
        await getPricedCatalog();

      res.json({
        ok: true,
        total: data.length,

        products:
          data.map(
            getAdminProduct
          ),

        settings:
          storeSettings,

        pricing: {
          usdToSdg:
            USD_TO_SDG,

          tiers:
            PRICING_TIERS
        }
      });
    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,
          error: error.message
        });
    }
  }
);

app.get(
  "/api/admin/settings",
  requireAdmin,
  (req, res) => {
    res.json({
      ok: true,

      settings:
        storeSettings,

      pricing: {
        usdToSdg:
          USD_TO_SDG,

        tiers:
          PRICING_TIERS
      }
    });
  }
);

app.post(
  "/api/admin/catalog/mode",
  requireAdmin,
  (req, res) => {
    const mode =
      String(
        req.body?.mode || ""
      ).trim();

    if (
      !["all", "curated"]
        .includes(mode)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "mode must be all or curated"
        });
    }

    storeSettings.catalogMode =
      mode;

    saveStoreSettingsNow();

    res.json({
      ok: true,
      catalogMode:
        storeSettings.catalogMode
    });
  }
);

app.post(
  "/api/admin/catalog/publish",
  requireAdmin,
  (req, res) => {
    const productId =
      String(
        req.body?.productId || ""
      ).trim();

    if (!productId) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "productId is required"
        });
    }

    storeSettings.hiddenIds =
      storeSettings.hiddenIds.filter(
        id => id !== productId
      );

    if (
      !storeSettings.publishedIds
        .includes(productId)
    ) {
      storeSettings.publishedIds.push(
        productId
      );
    }

    saveStoreSettingsNow();

    res.json({
      ok: true,
      productId,
      published: true
    });
  }
);

app.post(
  "/api/admin/catalog/unpublish",
  requireAdmin,
  (req, res) => {
    const productId =
      String(
        req.body?.productId || ""
      ).trim();

    if (!productId) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "productId is required"
        });
    }

    storeSettings.publishedIds =
      storeSettings.publishedIds.filter(
        id => id !== productId
      );

    storeSettings.hiddenIds =
      Array.from(
        new Set([
          ...storeSettings.hiddenIds,
          productId
        ])
      );

    saveStoreSettingsNow();

    res.json({
      ok: true,
      productId,
      published: false
    });
  }
);

app.post(
  "/api/admin/catalog/discount",
  requireAdmin,
  (req, res) => {
    const productId =
      String(
        req.body?.productId || ""
      ).trim();

    const discount =
      normalizeDiscount(
        req.body?.discount
      );

    if (!productId) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "productId is required"
        });
    }

    if (!discount) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Invalid discount"
        });
    }

    storeSettings.discounts[
      productId
    ] = discount;

    saveStoreSettingsNow();

    res.json({
      ok: true,
      productId,
      discount
    });
  }
);

app.delete(
  "/api/admin/catalog/discount/:productId",
  requireAdmin,
  (req, res) => {
    const productId =
      String(
        req.params.productId || ""
      ).trim();

    delete storeSettings.discounts[
      productId
    ];

    saveStoreSettingsNow();

    res.json({
      ok: true,
      productId,
      discount: null
    });
  }
);

// ======================================================
// لوحة الإدارة
// ======================================================

app.get(
  "/admin",
  (req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ABESHA STORE — الإدارة</title>

<style>
*{box-sizing:border-box}

body{
margin:0;
font-family:Arial,sans-serif;
background:#071426;
color:#eef5ff
}

header{
padding:18px 16px;
background:#0b1f3a;
border-bottom:1px solid #1d416e;
position:sticky;
top:0;
z-index:5
}

h1{
margin:0 0 6px;
font-size:22px
}

.muted{
color:#9fb3cc;
font-size:13px
}

.wrap{
max-width:1200px;
margin:auto;
padding:16px
}

.panel{
background:#0b1f3a;
border:1px solid #1d416e;
border-radius:14px;
padding:14px;
margin-bottom:14px
}

.row{
display:flex;
gap:10px;
flex-wrap:wrap;
align-items:center
}

input,select,button{
font:inherit;
border-radius:9px;
border:1px solid #31577f;
padding:10px
}

input,select{
background:#071426;
color:#fff;
min-width:180px
}

button{
background:#123866;
color:#fff;
cursor:pointer
}

button.primary{
background:#1769aa
}

button.danger{
background:#7d2633
}

.stats{
display:grid;
grid-template-columns:
repeat(auto-fit,minmax(150px,1fr));
gap:10px
}

.stat{
background:#071426;
border-radius:10px;
padding:12px
}

.num{
font-size:22px;
font-weight:bold;
margin-top:5px
}

#products{
display:grid;
grid-template-columns:
repeat(auto-fill,minmax(280px,1fr));
gap:12px
}

.card{
background:#0b1f3a;
border:1px solid #1d416e;
border-radius:12px;
padding:13px
}

.card h3{
font-size:15px;
margin:0 0 8px;
line-height:1.4
}

.price{
font-size:19px;
font-weight:bold
}

.badge{
display:inline-block;
padding:4px 7px;
border-radius:7px;
background:#123866;
color:#cfe6ff;
font-size:11px;
margin:2px
}

.actions{
display:flex;
gap:7px;
flex-wrap:wrap;
margin-top:10px
}

.small{
font-size:12px;
color:#a9bdd3
}

.discount{
color:#ffd36b
}

.hidden{
display:none
}
</style>
</head>

<body>

<header>
<div class="wrap" style="padding:0">

<h1>
ABESHA STORE — لوحة الإدارة
</h1>

<div class="muted">
إدارة المنتجات، النشر، الأسعار والعروض
</div>

</div>
</header>

<main class="wrap">

<section class="panel">

<div class="row">

<input
id="key"
type="password"
placeholder="ADMIN_KEY">

<button
class="primary"
onclick="loadAll()">
دخول وتحميل الكتالوج
</button>

<select
id="mode"
onchange="changeMode()">

<option value="all">
عرض كل المنتجات الحالية
</option>

<option value="curated">
عرض المنتجات التي أختارها فقط
</option>

</select>

</div>

<div
id="msg"
class="muted"
style="margin-top:9px">
</div>

</section>

<section class="panel">

<div class="stats">

<div class="stat">
إجمالي الكتالوج
<div class="num" id="total">—</div>
</div>

<div class="stat">
المنشور
<div class="num" id="published">—</div>
</div>

<div class="stat">
المخفي
<div class="num" id="hidden">—</div>
</div>

<div class="stat">
عروض نشطة
<div class="num" id="discounts">—</div>
</div>

</div>

</section>

<section class="panel">

<div class="row">

<input
id="search"
placeholder="ابحث باسم المنتج..."
oninput="render()">

<select
id="type"
onchange="render()">

<option value="">
كل الأقسام
</option>

<option value="topup">
Topups
</option>

<option value="gift_card">
Gift Cards
</option>

<option value="game_key">
Game Keys
</option>

</select>

</div>

</section>

<section id="products"></section>

</main>

<script>

let key="";
let data=[];
let settings={};

function esc(s){
return String(s??"").replace(
/[&<>"']/g,
m=>({
"&":"&amp;",
"<":"&lt;",
">":"&gt;",
"\\":"&quot;",
"'":"&#039;"
}[m])
);
}

function headers(){
return {
"Content-Type":"application/json",
"x-admin-key":key
}
}

function msg(t){
document.getElementById(
"msg"
).textContent=t||"";
}

async function api(url,opts={}){
const r=await fetch(
url,
{
...opts,
headers:{
...headers(),
...(opts.headers||{})
}
}
);

const j=await r.json()
.catch(()=>({}));

if(!r.ok)
throw new Error(
j.error||"حدث خطأ"
);

return j;
}

async function loadAll(){

key=document
.getElementById("key")
.value
.trim();

if(!key){
msg("أدخل مفتاح الإدارة.");
return;
}

try{

const j=
await api(
"/api/admin/catalog"
);

data=j.products||[];
settings=j.settings||{};

document.getElementById(
"mode"
).value=
settings.catalogMode||"all";

updateStats();
render();

msg(
"تم تحميل الكتالوج."
);

}catch(e){

msg(e.message);

}
}

function updateStats(){

document.getElementById(
"total"
).textContent=
data.length;

document.getElementById(
"published"
).textContent=
data.filter(
p=>p.published
).length;

document.getElementById(
"hidden"
).textContent=
data.filter(
p=>!p.published
).length;

document.getElementById(
"discounts"
).textContent=
data.filter(
p=>
p.discount &&
p.discount.active!==false
).length;

}

function render(){

const q=
document
.getElementById("search")
.value
.trim()
.toLowerCase();

const type=
document
.getElementById("type")
.value;

const list=
data.filter(
p=>
(!q||
String(
p.name||""
)
.toLowerCase()
.includes(q))
&&
(!type||
p.type===type)
);

const box=
document.getElementById(
"products"
);

box.innerHTML=
list
.slice(0,500)
.map(
p=>{

const d=p.discount;

const price=
Number(
p.price_sdg||0
);

const state=
p.published
?"منشور"
:"مخفي";

return '<article class="card">'+
'<h3>'+
esc(p.name)+
'</h3>'+
'<div class="small">'+
esc(p.type)+
' · '+
esc(p.id)+
'</div>'+
'<div class="price">'+
price.toLocaleString("en-US")+
' SDG</div>'+
(
d
?
'<div class="discount">'+
'عرض: '+
esc(d.label)+
' — '+
(
d.type==="percent"
?
d.value+"%"
:
d.value.toLocaleString(
"en-US"
)+" SDG"
)+
'</div>'
:
''
)+
'<div>'+
'<span class="badge">'+
state+
'</span>'+
(
p.stock!==undefined&&
p.stock!==null
?
'<span class="badge">Stock: '+
esc(p.stock)+
'</span>'
:
''
)+
'</div>'+
'<div class="actions">'+
'<button class="primary" onclick="togglePublish('+
JSON.stringify(p.id)+
','+
(!p.published)+
')">'+
(
p.published
?"إخفاء"
:"نشر"
)+
'</button>'+
'<button onclick="setDiscount('+
JSON.stringify(p.id)+
')">'+
'عرض/خصم'+
'</button>'+
(
d
?
'<button class="danger" onclick="removeDiscount('+
JSON.stringify(p.id)+
')">'+
'إزالة العرض'+
'</button>'
:
''
)+
'</div></article>';

}
)
.join("");

}

async function togglePublish(
id,
publish
){

try{

await api(
publish
?"/api/admin/catalog/publish"
:"/api/admin/catalog/unpublish",
{
method:"POST",
body:JSON.stringify({
productId:id
})
}
);

const p=
data.find(
x=>x.id===id
);

if(p)
p.published=
publish;

updateStats();
render();

msg(
publish
?"تم نشر المنتج."
:"تم إخفاء المنتج."
);

}catch(e){

msg(e.message);

}

}

async function setDiscount(id){

const type=
prompt(
"نوع الخصم: percent للنسبة أو fixed لمبلغ SDG",
"percent"
);

if(type===null)
return;

if(
!["percent","fixed"]
.includes(type.trim())
){

msg(
"نوع الخصم غير صحيح."
);

return;
}

const value=
prompt(
type==="percent"
?"نسبة الخصم"
:"قيمة الخصم بالجنيه السوداني",
"10"
);

if(value===null)
return;

const n=Number(value);

if(
!Number.isFinite(n)||
n<=0
){

msg(
"قيمة الخصم غير صحيحة."
);

return;
}

const label=
prompt(
"اسم العرض",
"عرض خاص"
);

if(label===null)
return;

try{

const j=
await api(
"/api/admin/catalog/discount",
{
method:"POST",
body:JSON.stringify({
productId:id,

discount:{
type,
value:n,
label,
active:true
}

})
}
);

const p=
data.find(
x=>x.id===id
);

if(p)
p.discount=
j.discount;

updateStats();
render();

msg(
"تم حفظ العرض."
);

}catch(e){

msg(e.message);

}

}

async function removeDiscount(id){

try{

await api(
"/api/admin/catalog/discount/"+
encodeURIComponent(id),
{
method:"DELETE"
}
);

const p=
data.find(
x=>x.id===id
);

if(p)
p.discount=null;

updateStats();
render();

msg(
"تمت إزالة العرض."
);

}catch(e){

msg(e.message);

}

}

async function changeMode(){

if(!key){

msg(
"أدخل ADMIN_KEY أولاً."
);

return;
}

try{

const mode=
document
.getElementById("mode")
.value;

await api(
"/api/admin/catalog/mode",
{
method:"POST",
body:JSON.stringify({
mode
})
}
);

settings.catalogMode=
mode;

msg(
"تم تغيير طريقة عرض الكتالوج."
);

}catch(e){

msg(e.message);

}

}

</script>

</body>
</html>`);
});

// ======================================================
// الطلبات
// ======================================================

const ORDERS = new Map();

function loadOrdersFromDisk() {

try {

if(
!fs.existsSync(
ORDERS_FILE
)
)
return;

const parsed=
JSON.parse(
fs.readFileSync(
ORDERS_FILE,
"utf8"
)
);

if(
!Array.isArray(parsed)
)
return;

for(
const order of parsed
){

if(
order?.orderNumber
)
ORDERS.set(
order.orderNumber,
order
);

}

console.log(
`[ORDERS] Loaded ${ORDERS.size} orders from disk`
);

}catch(error){

console.warn(
"[ORDERS] Could not load orders:",
error.message
);

}

}

function saveOrdersToDisk(){

try{

fs.writeFileSync(
ORDERS_FILE,
JSON.stringify(
Array.from(
ORDERS.values()
),
null,
2
),
"utf8"
);

}catch(error){

console.warn(
"[ORDERS] Could not save orders:",
error.message
);

}

}

function customerKey(
customer={}
){

const raw=
String(
customer.phone||
customer.email||
""
)
.trim()
.toLowerCase();

if(!raw)
return null;

return crypto
.createHash("sha256")
.update(raw)
.digest("hex")
.slice(0,24);

}

loadOrdersFromDisk();

function generateOrderNumber(){

const part1=
Math.floor(
100000+
Math.random()*
900000
);

const part2=
Math.floor(
100000+
Math.random()*
900000
);

return `AB-${part1}-${part2}`;

}

app.post(
"/api/orders",
(req,res)=>{

try{

const {
customer,
items,
paymentMethod,
total
}=req.body;

if(
!customer||
typeof customer!=="object"
){

return res
.status(400)
.json({
ok:false,
error:
"customer is required"
});

}

if(
!Array.isArray(items)||
items.length===0
){

return res
.status(400)
.json({
ok:false,
error:
"items are required"
});

}

if(!paymentMethod){

return res
.status(400)
.json({
ok:false,
error:
"paymentMethod is required"
});

}

const amount=
Number(total);

if(
!Number.isFinite(amount)||
amount<=0
){

return res
.status(400)
.json({
ok:false,
error:
"Invalid total"
});

}

const orderNumber=
generateOrderNumber();

const order={

orderNumber,

customer:{
name:
String(
customer.name||""
).trim(),

phone:
String(
customer.phone||""
).trim(),

email:
String(
customer.email||""
).trim()
},

items:
items.map(
item=>({

productId:
String(
item.productId||""
),

name:
String(
item.name||""
),

quantity:
item.quantity||"",

price:
Number(
item.price
)||0,

fields:
item.fields||{}

})
),

payment:{
method:
String(
paymentMethod
),

status:
"PENDING",

transactionId:null
},

total:amount,

status:
"PAYMENT_PENDING",

createdAt:
new Date().toISOString(),

updatedAt:
new Date().toISOString()

};

ORDERS.set(
orderNumber,
order
);

console.log(
`[ORDER CREATED] ${orderNumber} - ${amount} SDG - ${paymentMethod}`
);

res
.status(201)
.json({
ok:true,

order:{
orderNumber:
order.orderNumber,

status:
order.status,

total:
order.total,

paymentMethod:
order.payment.method,

createdAt:
order.createdAt
}

});

}catch(error){

console.error(
"Create order error:",
error
);

res
.status(500)
.json({
ok:false,
error:
"Failed to create order"
});

}

}
);

app.get(
"/api/orders/:orderNumber",
(req,res)=>{

const order=
ORDERS.get(
req.params.orderNumber
);

if(!order){

return res
.status(404)
.json({
ok:false,
error:
"Order not found"
});

}

res.json({
ok:true,
order
});

}
);

app.get(
"/api/customer/orders",
(req,res)=>{

const phone=
String(
req.query.phone||""
).trim();

const email=
String(
req.query.email||""
).trim();

const key=
customerKey({
phone,
email
});

if(!key){

return res
.status(400)
.json({
ok:false,
error:
"phone or email is required"
});

}

const customerOrders=
Array.from(
ORDERS.values()
)
.filter(
order =>
order.customerKey===key
)
.sort(
(a,b)=>
new Date(b.createdAt)-
new Date(a.createdAt)
)
.map(
order=>({

orderNumber:
order.orderNumber,

total:
order.total,

status:
order.status,

paymentMethod:
order.payment?.method||
null,

createdAt:
order.createdAt,

items:
order.items

})
);

res.json({
ok:true,

total:
customerOrders.length,

orders:
customerOrders
});

}
);

app.post(
"/api/customer/reorder",
async (req,res)=>{

try{

const orderNumber=
String(
req.body?.orderNumber||""
).trim();

const order=
ORDERS.get(
orderNumber
);

if(!order){

return res
.status(404)
.json({
ok:false,
error:
"Order not found"
});

}

const catalog=
await getPricedCatalog();

const byId=
new Map(
catalog.map(
product =>
[
String(product.id),
product
]
)
);

const items=
order.items
.map(
item =>
byId.get(
String(
item.productId
)
)
)
.filter(
product =>
product&&
Number(
product.price_sdg
)>0
)
.map(
product=>{

const publicProduct=
enrichProductForStore(
product
);

return {

productId:
publicProduct.id,

name:
publicProduct.name,

price:
publicProduct.price_sdg,

quantity:1,

fields:
publicProduct.fields||{}

};

}
);

res.json({

ok:true,

sourceOrderNumber:
orderNumber,

total:
items.reduce(
(sum,item)=>
sum+
Number(
item.price||0
),
0
),

items

});

}catch(error){

res
.status(500)
.json({
ok:false,
error:
error.message
});

}

}
);

app.get(
"/api/admin/orders",
requireAdmin,
(req,res)=>{

const list=
Array.from(
ORDERS.values()
)
.sort(
(a,b)=>
new Date(b.createdAt)-
new Date(a.createdAt)
);

res.json({

ok:true,

total:
list.length,

orders:
list

});

}
);

app.post(
"/api/admin/orders/:orderNumber/confirm-payment",
requireAdmin,
(req,res)=>{

const order=
ORDERS.get(
req.params.orderNumber
);

if(!order){

return res
.status(404)
.json({
ok:false,
error:
"Order not found"
});

}

if(
order.status!==
"PAYMENT_PENDING"
){

return res
.status(409)
.json({
ok:false,
error:
`Order cannot be confirmed from status ${order.status}`
});

}

const transactionId=
String(
req.body?.transactionId||
""
).trim();

if(!transactionId){

return res
.status(400)
.json({
ok:false,
error:
"transactionId is required"
});

}

order.payment.transactionId=
transactionId;

order.payment.status=
"CONFIRMED";

order.status=
"PAYMENT_CONFIRMED";

order.updatedAt=
new Date().toISOString();

ORDERS.set(
order.orderNumber,
order
);

saveOrdersToDisk();

console.log(
`[PAYMENT CONFIRMED] ${order.orderNumber} - ${transactionId}`
);

res.json({
ok:true,
order
});

}
);

// ======================================================
// الصفحة الرئيسية
// ======================================================

app.get(
"/",
(req,res)=>{

res.sendFile(
path.join(
__dirname,
"public",
"index.html"
)
);

}
);

// ======================================================
// تشغيل
// ======================================================

app.listen(
PORT,
()=>{
console.log(
`ABESHA STORE running on port ${PORT}`
);

console.log(
`Pricing USD → SDG: ${USD_TO_SDG}`
);

}
);
