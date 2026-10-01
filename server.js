نعم. هذه هي النسخة الكاملة التي سنعتمدها لـ server.js، في كتلة واحدة كما طلبت.
مهم: استبدل محتوى server.js بالكامل بهذه النسخة، ولا تضف إليها أجزاء من النسخة القديمة.
هذه النسخة تعتمد سعر الدولار 8250 SDG، والتسعير الموحد 7% / 8% / 9% / 10%، ولا تحتوي على أسعار خاصة لـ PUBG أو PRICE_OVERRIDES. كما أن price_usd متوافق مع السعر النهائي المعروض بدل استخدام معادلة 8050 القديمة. �
server(5).js
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const FAZER_API = "https://api.fzr.cards/api/v2";
const USD_TO_SDG = 8250;

const PRICING_TIERS = [
  { maxCost: 20000, markup: 0.07 },
  { maxCost: 100000, markup: 0.08 },
  { maxCost: 300000, markup: 0.09 },
  { maxCost: Infinity, markup: 0.10 }
];

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PRICE_CACHE_VERSION = 8;

const PRICE_CACHE_FILE = path.join(__dirname, "pricing-cache.json");
const STORE_SETTINGS_FILE = path.join(__dirname, "store-settings.json");
const ORDERS_FILE = path.join(__dirname, "orders.json");

let pricedCatalogCache = null;
let pricedCatalogBuiltAt = 0;
let priceRefreshPromise = null;

const DEFAULT_STORE_SETTINGS = {
  version: 1,
  catalogMode: "all",
  publishedIds: [],
  hiddenIds: [],
  discounts: {}
};

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* ======================================================
   FILE HELPERS
====================================================== */

function jsonFileRead(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.warn("[FILE READ]", file, error.message);
    return fallback;
  }
}

function jsonFileWrite(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch (error) {
    console.warn("[FILE WRITE]", file, error.message);
    return false;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) return "";
  return value.startsWith("/") ? value : "/" + value;
}

/* ======================================================
   FAZER API
====================================================== */

function requireFazerKey() {
  if (!process.env.FAZER_API_KEY) {
    const error = new Error("FAZER_API_KEY is not configured");
    error.status = 500;
    throw error;
  }
}

function fazerHeaders(extra) {
  return Object.assign(
    {
      "X-API-Key": process.env.FAZER_API_KEY,
      "Accept": "application/json"
    },
    extra || {}
  );
}

async function fazerFetch(endpoint, options) {
  requireFazerKey();

  const opts = Object.assign({}, options || {});
  const timeoutMs =
    Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;

  delete opts.timeoutMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = FAZER_API + normalizeEndpoint(endpoint);

    const response = await fetch(
      url,
      Object.assign({}, opts, {
        headers: fazerHeaders(opts.headers),
        signal: controller.signal
      })
    );

    const text = await response.text();
    let data = {};

    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      data = { raw: text };
    }

    if (!response.ok) {
      const error = new Error(
        data && (data.message || data.error)
          ? data.message || data.error
          : "Fazer API HTTP " + response.status
      );

      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fazerGet(endpoint, timeoutMs) {
  return fazerFetch(endpoint, {
    method: "GET",
    timeoutMs: timeoutMs || 30000
  });
}

function getArray(data, keys) {
  const wanted = keys || ["items", "offers", "cards", "keys"];

  for (const key of wanted) {
    if (Array.isArray(data && data[key])) {
      return data[key];
    }
  }

  if (Array.isArray(data)) return data;

  if (Array.isArray(data && data.data)) {
    return data.data;
  }

  if (data && data.data) {
    for (const key of wanted) {
      if (Array.isArray(data.data[key])) {
        return data.data[key];
      }
    }
  }

  return [];
}

/* ======================================================
   PAGINATION
====================================================== */

async function getAllCategories(endpoint) {
  const items = [];
  let cursor = null;

  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams();

    params.set("limit", "200");

    if (cursor) {
      params.set("cursor", cursor);
    }

    const data = await fazerGet(
      normalizeEndpoint(endpoint) + "?" + params.toString(),
      30000
    );

    const pageItems = getArray(data, [
      "items",
      "categories",
      "games"
    ]);

    if (pageItems.length) {
      items.push.apply(items, pageItems);
    }

    const nextCursor =
      (data &&
        data.meta &&
        data.meta.next_cursor) ||
      (data && data.next_cursor) ||
      (data &&
        data.pagination &&
        data.pagination.next_cursor) ||
      null;

    if (
      !nextCursor ||
      String(nextCursor) === String(cursor)
    ) {
      break;
    }

    const hasMore =
      data &&
      data.meta &&
      typeof data.meta.has_more === "boolean"
        ? data.meta.has_more
        : true;

    if (!hasMore) break;

    cursor = String(nextCursor);
  }

  return items;
}

/* ======================================================
   PRICING
====================================================== */

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

  let step = 100;

  if (value >= 500000) {
    step = 5000;
  } else if (value >= 100000) {
    step = 1000;
  } else if (value >= 10000) {
    step = 500;
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

  return roundCommercialPrice(
    costSdg * (1 + markup)
  );
}

function frontendCompatibleUsd(saleSdg) {
  const sale = Number(saleSdg);

  if (!Number.isFinite(sale) || sale <= 0) {
    return null;
  }

  return sale / USD_TO_SDG;
}

function offerPriceUsd(offer) {
  const candidates = [
    offer && offer.price_usd,
    offer && offer.priceUSD,
    offer && offer.usd_price,
    offer && offer.cost_usd,
    offer && offer.costUSD,
    offer && offer.price
  ];

  for (const value of candidates) {
    const number = Number(value);

    if (
      Number.isFinite(number) &&
      number > 0
    ) {
      return number;
    }
  }

  return null;
}

function offerLabel(offer) {
  return String(
    (offer && offer.name) ||
      (offer && offer.title) ||
      (offer && offer.description) ||
      (offer && offer.product_name) ||
      (offer && offer.productName) ||
      (offer && offer.amount) ||
      (offer && offer.quantity) ||
      (offer && offer.denomination) ||
      "عرض"
  ).trim();
}

/* ======================================================
   STORE SETTINGS
====================================================== */

function loadStoreSettings() {
  const parsed = jsonFileRead(
    STORE_SETTINGS_FILE,
    null
  );

  if (
    !parsed ||
    typeof parsed !== "object"
  ) {
    const fresh = clone(
      DEFAULT_STORE_SETTINGS
    );

    jsonFileWrite(
      STORE_SETTINGS_FILE,
      fresh
    );

    return fresh;
  }

  return Object.assign(
    clone(DEFAULT_STORE_SETTINGS),
    parsed,
    {
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
          : {}
    }
  );
}

let storeSettings =
  loadStoreSettings();

function saveStoreSettings() {
  storeSettings.version = 1;
  jsonFileWrite(
    STORE_SETTINGS_FILE,
    storeSettings
  );
}

/* ======================================================
   DISCOUNTS
====================================================== */

function normalizeDiscount(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const type =
    raw.type === "fixed"
      ? "fixed"
      : "percent";

  const value = Number(raw.value);

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

  let startsAt = null;
  let endsAt = null;

  try {
    if (raw.startsAt) {
      startsAt =
        new Date(
          raw.startsAt
        ).toISOString();
    }

    if (raw.endsAt) {
      endsAt =
        new Date(
          raw.endsAt
        ).toISOString();
    }
  } catch (_) {
    return null;
  }

  return {
    type,
    value,
    startsAt,
    endsAt,
    active: raw.active !== false,
    label: String(
      raw.label || "عرض خاص"
    )
      .trim()
      .slice(0, 100)
  };
}

function isDiscountActive(discount) {
  if (
    !discount ||
    discount.active === false
  ) {
    return false;
  }

  const now = Date.now();

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
    sale =
      base -
      Number(discount.value);
  } else {
    sale =
      base *
      (1 -
        Number(discount.value) /
          100);
  }

  sale = roundCommercialPrice(
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

/* ======================================================
   PRODUCT VISIBILITY
====================================================== */

function productVisibility(product) {
  const id = String(
    (product && product.id) || ""
  );

  if (
    storeSettings.hiddenIds.indexOf(id) !== -1
  ) {
    return false;
  }

  if (
    storeSettings.catalogMode ===
    "curated"
  ) {
    return (
      storeSettings.publishedIds.indexOf(
        id
      ) !== -1
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

  const result =
    Object.assign(
      {},
      product,
      {
        price_sdg:
          pricing.price,

        price_usd:
          frontendCompatibleUsd(
            pricing.price
          ),

        original_price_sdg:
          pricing.originalPrice,

        discount:
          pricing.discount
      }
    );

  delete result.source_price_usd;
  delete result.cost_sdg;
  delete result.markup_percent;

  return result;
}

function getAdminProduct(product) {
  return Object.assign(
    {},
    product,
    {
      published:
        productVisibility(product),

      discount:
        storeSettings.discounts[
          String(product.id)
        ] || null
    }
  );
}

function getPublicProducts(
  products
) {
  return products
    .filter(productVisibility)
    .filter(product =>
      Number(product.price_sdg) > 0
    )
    .map(
      enrichProductForStore
    );
}

/* ======================================================
   PRICE CACHE
====================================================== */

function loadPriceCacheFromDisk() {
  const parsed =
    jsonFileRead(
      PRICE_CACHE_FILE,
      null
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
      "[PRICE CACHE] Loaded " +
        pricedCatalogCache.length +
        " products from disk"
    );
  }
}

function savePriceCacheToDisk(
  products
) {
  jsonFileWrite(
    PRICE_CACHE_FILE,
    {
      version:
        PRICE_CACHE_VERSION,

      builtAt:
        Date.now(),

      usdToSdg:
        USD_TO_SDG,

      products
    }
  );
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

async function mapWithConcurrency(
  items,
  worker,
  concurrency
) {
  const results =
    new Array(items.length);

  let nextIndex = 0;

  const limit = Math.max(
    1,
    Math.min(
      concurrency || 6,
      items.length
    )
  );

  async function runner() {
    while (true) {
      const index =
        nextIndex++;

      if (
        index >=
        items.length
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
          error: error.message
        };
      }
    }
  }

  if (!items.length) {
    return results;
  }

  await Promise.all(
    Array.from(
      {
        length: limit
      },
      () => runner()
    )
  );

  return results;
}

/* ======================================================
   FAZER OFFERS
====================================================== */

async function getTopupOffers(
  categoryId
) {
  const data =
    await fazerGet(
      "/topups/offers?category_id=" +
        encodeURIComponent(
          categoryId
        )
    );

  return {
    offers: getArray(
      data,
      ["offers", "items"]
    ),

    fields:
      Array.isArray(
        data && data.fields
      )
        ? data.fields
        : [],

    name:
      data && data.name
        ? data.name
        : null,

    raw: data
  };
}

async function getGiftcardOffers(
  categoryId
) {
  const data =
    await fazerGet(
      "/giftcards/cards?category_id=" +
        encodeURIComponent(
          categoryId
        )
    );

  return {
    offers: getArray(
      data,
      [
        "offers",
        "cards",
        "items"
      ]
    ),

    fields:
      Array.isArray(
        data && data.fields
      )
        ? data.fields
        : [],

    name:
      data && data.name
        ? data.name
        : null,

    raw: data
  };
}

async function getGameKeyOffers(
  gameId
) {
  const data =
    await fazerGet(
      "/gamekeys/keys?game_id=" +
        encodeURIComponent(
          gameId
        )
    );

  return {
    offers: getArray(
      data,
      [
        "keys",
        "items",
        "offers"
      ]
    ),

    name:
      (data &&
        data.GameName) ||
      (data && data.name) ||
      null,

    platform:
      (data &&
        data.platform) ||
      "",

    region:
      (data &&
        data.region) ||
      "",

    regionRestriction:
      Boolean(
        data &&
          data.region_restriction
      ),

    raw: data
  };
}

/* ======================================================
   PRODUCT BUILDER
====================================================== */

function makePricedProduct(
  base,
  priceUsd,
  offer
) {
  const priceSdg =
    calculateSalePrice(
      priceUsd
    );

  return Object.assign(
    {},
    base,
    {
      price_usd:
        frontendCompatibleUsd(
          priceSdg
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
        priceSdg,

      pricing_mode:
        "automatic",

      stock:
        offer &&
        offer.stock != null
          ? offer.stock
          : null,

      min_order_quantity:
        offer &&
        offer.min_order_quantity !=
          null
          ? offer.min_order_quantity
          : 1,

      max_order_quantity:
        offer &&
        offer.max_order_quantity !=
          null
          ? offer.max_order_quantity
          : null,

      offer:
        offer || null
    }
  );
}

/* ======================================================
   BUILD COMPLETE CATALOG
====================================================== */

async function buildPricedCatalog() {
  console.log(
    "[PRICE CACHE] Building complete priced catalog..."
  );

  const families =
    await Promise.allSettled([
      getAllCategories(
        "topups"
      ),

      getAllCategories(
        "giftcards"
      ),

      getAllCategories(
        "gamekeys"
      )
    ]);

  const topups =
    families[0].status ===
    "fulfilled"
      ? families[0].value
      : [];

  const giftcards =
    families[1].status ===
    "fulfilled"
      ? families[1].value
      : [];

  const gamekeys =
    families[2].status ===
    "fulfilled"
      ? families[2].value
      : [];

  families.forEach(
    (family, index) => {
      if (
        family.status ===
        "rejected"
      ) {
        console.warn(
          "[PRICE] Family " +
            index +
            " unavailable: " +
            (
              family.reason &&
              family.reason.message
            ) ||
            family.reason
        );
      }
    }
  );

  const products = [];

  /* TOPUPS */

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

        if (!categoryId) {
          return [];
        }

        try {
          const response =
            await getTopupOffers(
              categoryId
            );

          const fields =
            response.fields.length >
            0
              ? response.fields
              : Array.isArray(
                  category.fields
                )
              ? category.fields
              : [];

          return response.offers.map(
            (offer, index) => {
              const label =
                offerLabel(
                  offer
                );

              const priceUsd =
                offerPriceUsd(
                  offer
                );

              const offerId =
                String(
                  offer.offer_id ||
                    offer.id ||
                    offer.offerId ||
                    offer.sku ||
                    offer.code ||
                    index
                );

              return makePricedProduct(
                {
                  id:
                    categoryId +
                    "__offer__" +
                    offerId,

                  category_id:
                    categoryId,

                  offer_id:
                    offerId,

                  name:
                    label === "عرض"
                      ? categoryName
                      : categoryName +
                        " — " +
                        label,

                  base_name:
                    categoryName,

                  type:
                    "topup",

                  family:
                    "topup",

                  note:
                    category.note ||
                    "",

                  fields
                },

                priceUsd,
                offer
              );
            }
          );
        } catch (error) {
          console.warn(
            "[PRICE] Failed topup " +
              categoryId +
              ": " +
              error.message
          );

          return [];
        }
      },
      6
    );

  topupResults.forEach(
    result => {
      if (Array.isArray(result)) {
        products.push(
          ...result
        );
      }
    }
  );

  /* GIFT CARDS */

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

        if (!categoryId) {
          return [];
        }

        try {
          const response =
            await getGiftcardOffers(
              categoryId
            );

          const fields =
            response.fields.length >
            0
              ? response.fields
              : Array.isArray(
                  category.fields
                )
              ? category.fields
              : [];

          return response.offers.map(
            (offer, index) => {
              const label =
                offerLabel(
                  offer
                );

              const priceUsd =
                offerPriceUsd(
                  offer
                );

              const cardId =
                String(
                  offer.card_id ||
                    offer.id ||
                    offer.cardId ||
                    offer.sku ||
                    offer.code ||
                    index
                );

              return makePricedProduct(
                {
                  id:
                    categoryId +
                    "__card__" +
                    cardId,

                  category_id:
                    categoryId,

                  card_id:
                    cardId,

                  name:
                    label === "عرض"
                      ? categoryName
                      : categoryName +
                        " — " +
                        label,

                  base_name:
                    categoryName,

                  type:
                    "gift_card",

                  family:
                    "giftcard",

                  note:
                    category.note ||
                    "",

                  fields
                },

                priceUsd,
                offer
              );
            }
          );
        } catch (error) {
          console.warn(
            "[PRICE] Failed gift card " +
              categoryId +
              ": " +
              error.message
          );

          return [];
        }
      },
      6
    );

  giftcardResults.forEach(
    result => {
      if (Array.isArray(result)) {
        products.push(
          ...result
        );
      }
    }
  );

  /* GAME KEYS */

  const gameKeyResults =
    await mapWithConcurrency(
      gamekeys,
      async game => {
        const gameId =
          String(
            game.game_id ||
              game.category_id ||
              game.id ||
              ""
          );

        const gameName =
          String(
            game.GameName ||
              game.name ||
              game.title ||
              gameId
          );

        if (!gameId) {
          return [];
        }

        try {
          const response =
            await getGameKeyOffers(
              gameId
            );

          return response.offers.map(
            (key, index) => {
              const priceUsd =
                offerPriceUsd(
                  key
                );

              const label =
                offerLabel(
                  key
                );

              const keyId =
                String(
                  key.key_id ||
                    key.id ||
                    key.keyId ||
                    key.sku ||
                    key.code ||
                    index
                );

              return makePricedProduct(
                {
                  id:
                    gameId +
                    "__key__" +
                    keyId,

                  category_id:
                    gameId,

                  game_id:
                    gameId,

                  key_id:
                    keyId,

                  name:
                    label === "عرض"
                      ? gameName
                      : gameName +
                        " — " +
                        label,

                  base_name:
                    gameName,

                  type:
                    "game_key",

                  family:
                    "gamekey",

                  platform:
                    game.platform ||
                    response.platform ||
                    "",

                  region:
                    game.region ||
                    response.region ||
                    "",

                  region_restriction:
                    Boolean(
                      game.region_restriction ||
                        response.regionRestriction
                    )
                },

                priceUsd,
                key
              );
            }
          );
        } catch (error) {
          console.warn(
            "[PRICE] Failed game keys " +
              gameId +
              ": " +
              error.message
          );

          return [];
        }
      },
      6
    );

  gameKeyResults.forEach(
    result => {
      if (Array.isArray(result)) {
        products.push(
          ...result
        );
      }
    }
  );

  const usablePrices =
    products.filter(
      product =>
        Number.isFinite(
          Number(
            product.price_sdg
          )
        ) &&
        Number(
          product.price_sdg
        ) > 0
    ).length;

  console.log(
    "[PRICE CACHE] Built " +
      products.length +
      " catalog entries; " +
      usablePrices +
      " have prices"
  );

  pricedCatalogCache =
    products;

  pricedCatalogBuiltAt =
    Date.now();

  savePriceCacheToDisk(
    products
  );

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
          pricedCatalogCache.length >
            0
        ) {
          return pricedCatalogCache;
        }

        throw error;
      })
      .finally(() => {
        priceRefreshPromise =
          null;
      });

  return priceRefreshPromise;
}

loadPriceCacheFromDisk();

/* ======================================================
   HEALTH
====================================================== */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "ABESHA STORE",
      status:
        "running",

      pricing: {
        usdToSdg:
          USD_TO_SDG,

        cacheFresh:
          cacheIsFresh(),

        cachedProducts:
          pricedCatalogCache
            ? pricedCatalogCache.length
            : 0
      }
    });
  }
);

/* ======================================================
   FAZER ROUTES
====================================================== */

app.get(
  "/api/fazer/me",
  async (req, res) => {
    try {
      res.json(
        await fazerGet("/me")
      );
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
        details:
          error.data || null
      });
    }
  }
);

async function sendFamilyCatalog(
  res
) {
  const results =
    await Promise.allSettled([
      getAllCategories(
        "topups"
      ),

      getAllCategories(
        "giftcards"
      ),

      getAllCategories(
        "gamekeys"
      )
    ]);

  const topups =
    results[0].status ===
    "fulfilled"
      ? results[0].value
      : [];

  const giftcards =
    results[1].status ===
    "fulfilled"
      ? results[1].value
      : [];

  const gamekeys =
    results[2].status ===
    "fulfilled"
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
}

app.get(
  "/api/fazer/catalog",
  async (req, res) => {
    try {
      await sendFamilyCatalog(
        res
      );
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
        details:
          error.data || null
      });
    }
  }
);

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
          total:
            items.length,

          limit:
            items.length,

          next_cursor:
            null,

          has_more:
            false
        }
      });
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
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

      res.json(
        await fazerGet(
          "/topups/offers?category_id=" +
            encodeURIComponent(
              categoryId
            )
        )
      );
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
        details:
          error.data || null
      });
    }
  }
);

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
        kind:
          "gift_card",
        items,

        meta: {
          total:
            items.length,

          limit:
            items.length,

          next_cursor:
            null,

          has_more:
            false
        }
      });
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
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

      res.json(
        await fazerGet(
          "/giftcards/cards?category_id=" +
            encodeURIComponent(
              categoryId
            )
        )
      );
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
        details:
          error.data || null
      });
    }
  }
);

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
        kind:
          "game_key",
        items,

        meta: {
          total:
            items.length,

          limit:
            items.length,

          next_cursor:
            null,

          has_more:
            false
        }
      });
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
        details:
          error.data || null
      });
    }
  }
);

app.get(
  "/api/fazer/gamekeys/keys",
  async (req, res) => {
    try {
      const gameId =
        req.query.game_id;

      if (!gameId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "game_id is required"
          });
      }

      res.json(
        await fazerGet(
          "/gamekeys/keys?game_id=" +
            encodeURIComponent(
              gameId
            )
        )
      );
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
        details:
          error.data || null
      });
    }
  }
);

/* ======================================================
   PUBLIC PRODUCTS
====================================================== */

app.get(
  "/api/products",
  async (req, res) => {
    try {
      const products =
        await getPricedCatalog();

      const visibleProducts =
        getPublicProducts(
          products
        );

      res.json({
        ok: true,

        total:
          visibleProducts.length,

        products:
          visibleProducts,

        pricing: {
          currency:
            "SDG",

          usdToSdg:
            USD_TO_SDG,

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
                  tier.markup *
                  100
              })
            ),

          roundRules: {
            under10000:
              100,

            from10000To100000:
              500,

            from100000To500000:
              1000,

            from500000:
              5000
          }
        }
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* ======================================================
   PRICE REFRESH
====================================================== */

app.post(
  "/api/prices/refresh",
  async (req, res) => {
    try {
      if (
        !process.env.ADMIN_KEY ||
        req.headers[
          "x-admin-key"
        ] !==
          process.env.ADMIN_KEY
      ) {
        return res
          .status(401)
          .json({
            ok: false,
            error:
              "Unauthorized"
          });
      }

      pricedCatalogCache =
        null;

      pricedCatalogBuiltAt =
        0;

      const products =
        await getPricedCatalog();

      res.json({
        ok: true,

        total:
          products.length,

        refreshedAt:
          new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* ======================================================
   TOPUP VALIDATION
====================================================== */

app.post(
  "/api/fazer/topups/validate-id",
  async (req, res) => {
    try {
      const body = {
        category_id:
          req.body &&
          req.body.category_id,

        fields:
          req.body &&
          req.body.fields
      };

      res.json(
        await fazerFetch(
          "/topups/validate-id",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify(
                body
              )
          }
        )
      );
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
        details:
          error.data || null
      });
    }
  }
);

/* ======================================================
   STEAM
====================================================== */

app.get(
  "/api/fazer/steam-topup/rates",
  async (req, res) => {
    try {
      res.json(
        await fazerGet(
          "/steam-topup/rates"
        )
      );
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
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
        req.query.limit ||
        "100";

      res.json(
        await fazerGet(
          "/steam-gifts/games?limit=" +
            encodeURIComponent(
              limit
            )
        )
      );
    } catch (error) {
      res.status(
        error.status || 500
      ).json({
        ok: false,
        error:
          error.message,
        details:
          error.data || null
      });
    }
  }
);

/* ======================================================
   BASIC CATALOG
====================================================== */

app.get(
  "/api/catalog",
  async (req, res) => {
    try {
      const results =
        await Promise.allSettled([
          getAllCategories(
            "topups"
          ),

          getAllCategories(
            "giftcards"
          ),

          getAllCategories(
            "gamekeys"
          )
        ]);

      const topups =
        results[0].status ===
        "fulfilled"
          ? results[0].value
          : [];

      const giftcards =
        results[1].status ===
        "fulfilled"
          ? results[1].value
          : [];

      const gamekeys =
        results[2].status ===
        "fulfilled"
          ? results[2].value
          : [];

      const products = [];

      topups.forEach(item => {
        products.push({
          id:
            item.category_id ||
            item.id,

          name:
            item.name ||
            item.title,

          type:
            "topup",

          family:
            "topup",

          note:
            item.note || "",

          fields:
            item.fields || []
        });
      });

      giftcards.forEach(item => {
        products.push({
          id:
            item.category_id ||
            item.id,

          name:
            item.name ||
            item.title,

          type:
            "gift_card",

          family:
            "giftcard",

          note:
            item.note || "",

          fields:
            item.fields || []
        });
      });

      gamekeys.forEach(item => {
        products.push({
          id:
            item.game_id ||
            item.category_id ||
            item.id,

          name:
            item.name ||
            item.GameName ||
            item.title,

          type:
            "game_key",

          family:
            "gamekey",

          platform:
            item.platform || "",

          region:
            item.region || "",

          region_restriction:
            Boolean(
              item.region_restriction
            )
        });
      });

      res.json({
        ok: true,

        total:
          products.length,

        products
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* ======================================================
   ADMIN AUTH
====================================================== */

function requireAdmin(
  req,
  res,
  next
) {
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
    !req.headers[
      "x-admin-key"
    ] ||
    req.headers[
      "x-admin-key"
    ] !==
      process.env.ADMIN_KEY
  ) {
    return res
      .status(401)
      .json({
        ok: false,
        error:
          "Unauthorized"
      });
  }

  next();
}

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

app.get(
  "/api/admin/catalog",
  requireAdmin,
  async (req, res) => {
    try {
      const data =
        await getPricedCatalog();

      res.json({
        ok: true,

        total:
          data.length,

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
      res.status(500).json({
        ok: false,
        error:
          error.message
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
        (req.body &&
          req.body.mode) ||
          ""
      ).trim();

    if (
      ![
        "all",
        "curated"
      ].includes(mode)
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

    saveStoreSettings();

    res.json({
      ok: true,
      catalogMode:
        mode
    });
  }
);

app.post(
  "/api/admin/catalog/publish",
  requireAdmin,
  (req, res) => {
    const productId =
      String(
        (req.body &&
          req.body.productId) ||
          ""
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
      !storeSettings.publishedIds.includes(
        productId
      )
    ) {
      storeSettings.publishedIds.push(
        productId
      );
    }

    saveStoreSettings();

    res.json({
      ok: true,
      productId,
      published:
        true
    });
  }
);

app.post(
  "/api/admin/catalog/unpublish",
  requireAdmin,
  (req, res) => {
    const productId =
      String(
        (req.body &&
          req.body.productId) ||
          ""
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

    if (
      !storeSettings.hiddenIds.includes(
        productId
      )
    ) {
      storeSettings.hiddenIds.push(
        productId
      );
    }

    saveStoreSettings();

    res.json({
      ok: true,
      productId,
      published:
        false
    });
  }
);

app.post(
  "/api/admin/catalog/discount",
  requireAdmin,
  (req, res) => {
    const productId =
      String(
        (req.body &&
          req.body.productId) ||
          ""
      ).trim();

    const discount =
      normalizeDiscount(
        req.body &&
          req.body.discount
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

    saveStoreSettings();

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
        req.params.productId ||
          ""
      ).trim();

    delete storeSettings.discounts[
      productId
    ];

    saveStoreSettings();

    res.json({
      ok: true,
      productId,
      discount:
        null
    });
  }
);

/* ======================================================
   ADMIN PAGE
====================================================== */

const ADMIN_HTML = `
<!doctype html>
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
h1{margin:0 0 6px;font-size:22px}
.muted{color:#9fb3cc;font-size:13px}
.wrap{max-width:1200px;margin:auto;padding:16px}
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
button.primary{background:#1769aa}
button.danger{background:#7d2633}
.stats{
 display:grid;
 grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
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
 grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
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
 color:#ffd36b;
 margin-top:6px
}
</style>
</head>

<body>

<header>
<div class="wrap" style="padding:0">
<h1>ABESHA STORE — لوحة الإدارة</h1>
<div class="muted">
إدارة المنتجات والنشر والأسعار والعروض
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

<select id="mode" onchange="changeMode()">
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

<select id="type" onchange="render()">
<option value="">كل الأقسام</option>
<option value="topup">Topups</option>
<option value="gift_card">Gift Cards</option>
<option value="game_key">Game Keys</option>
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
 return String(s==null?"":s)
  .replace(/[&<>"]/g,function(m){
   return {
    "&":"&amp;",
    "<":"&lt;",
    ">":"&gt;",
    '"':"&quot;"
   }[m];
  });
}

function headers(){
 return {
  "Content-Type":"application/json",
  "x-admin-key":key
 };
}

function msg(t){
 document.getElementById("msg").textContent=t||"";
}

async function api(url,opts){
 opts=opts||{};

 const response=await fetch(
  url,
  Object.assign(
   {},
   opts,
   {
    headers:Object.assign(
     {},
     headers(),
     opts.headers||{}
    )
   }
  )
 );

 const json=await response
  .json()
  .catch(function(){
   return {};
  });

 if(!response.ok){
  throw new Error(
   json.error||"حدث خطأ"
  );
 }

 return json;
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
  const json=
   await api(
    "/api/admin/catalog"
   );

  data=json.products||[];
  settings=json.settings||{};

  document
   .getElementById("mode")
   .value=
   settings.catalogMode||"all";

  updateStats();
  render();

  msg("تم تحميل الكتالوج.");
 }catch(error){
  msg(error.message);
 }
}

function updateStats(){
 document.getElementById("total")
  .textContent=data.length;

 document.getElementById("published")
  .textContent=
   data.filter(
    p=>p.published
   ).length;

 document.getElementById("hidden")
  .textContent=
   data.filter(
    p=>!p.published
   ).length;

 document.getElementById("discounts")
  .textContent=
   data.filter(
    p=>p.discount &&
       p.discount.active!==false
   ).length;
}

function render(){
 const query=
  document
   .getElementById("search")
   .value
   .trim()
   .toLowerCase();

 const type=
  document
   .getElementById("type")
   .value;

 const list=data.filter(
  function(product){
   const name=
    String(
     product.name||""
    ).toLowerCase();

   return (
    (!query ||
     name.includes(query)) &&
    (!type ||
     product.type===type)
   );
  }
 );

 const box=
  document.getElementById(
   "products"
  );

 box.innerHTML="";

 list.slice(0,500)
 .forEach(function(product){

  const discount=
   product.discount;

  const price=
   Number(
    product.price_sdg||0
   );

  const state=
   product.published
    ? "منشور"
    : "مخفي";

  let html=
   '<article class="card">';

  html+=
   '<h3>'+
   esc(product.name)+
   '</h3>';

  html+=
   '<div class="small">'+
   esc(product.type)+
   " · "+
   esc(product.id)+
   '</div>';

  html+=
   '<div class="price">'+
   price.toLocaleString("en-US")+
   ' SDG</div>';

  if(discount){
   html+=
    '<div class="discount">'+
    "عرض: "+
    esc(
     discount.label||
     "عرض خاص"
    )+
    " — ";

   if(
    discount.type===
    "percent"
   ){
    html+=
     esc(
      discount.value
     )+"%";
   }else{
    html+=
     Number(
      discount.value||0
     ).toLocaleString(
      "en-US"
     )+" SDG";
   }

   html+="</div>";
  }

  html+=
   '<div>'+
   '<span class="badge">'+
   state+
   '</span>';

  if(
   product.stock!==undefined &&
   product.stock!==null
  ){
   html+=
    '<span class="badge">'+
    "Stock: "+
    esc(product.stock)+
    "</span>";
  }

  html+="</div>";

  html+=
   '<div class="actions">';

  html+=
   '<button class="primary" '+
   'onclick=\'togglePublish('+
   JSON.stringify(product.id)+
   ","+
   String(!product.published)+
   ")\'>"+
   (
    product.published
     ? "إخفاء"
     : "نشر"
   )+
   "</button>";

  html+=
   '<button onclick=\'setDiscount('+
   JSON.stringify(product.id)+
   ")\'>عرض/خصم</button>";

  if(discount){
   html+=
    '<button class="danger" '+
    'onclick=\'removeDiscount('+
    JSON.stringify(product.id)+
    ")\'>"+
    "إزالة العرض"+
    "</button>";
  }

  html+=
   "</div></article>";

  box.insertAdjacentHTML(
   "beforeend",
   html
  );
 });
}

async function togglePublish(
 id,
 publish
){
 try{
  await api(
   publish
    ? "/api/admin/catalog/publish"
    : "/api/admin/catalog/unpublish",
   {
    method:"POST",
    body:JSON.stringify({
     productId:id
    })
   }
  );

  const product=
   data.find(
    item=>item.id===id
   );

  if(product){
   product.published=
    publish;
  }

  updateStats();
  render();

  msg(
   publish
    ? "تم نشر المنتج."
    : "تم إخفاء المنتج."
  );
 }catch(error){
  msg(error.message);
 }
}

async function setDiscount(id){
 const type=
  prompt(
   "نوع الخصم: percent للنسبة أو fixed لمبلغ SDG",
   "percent"
  );

 if(type===null)return;

 const normalizedType=
  type.trim();

 if(
  ["percent","fixed"]
   .indexOf(
    normalizedType
   )===-1
 ){
  msg("نوع الخصم غير صحيح.");
  return;
 }

 const value=
  prompt(
   normalizedType==="percent"
    ? "نسبة الخصم"
    : "قيمة الخصم بالجنيه السوداني",
   "10"
  );

 if(value===null)return;

 const number=
  Number(value);

 if(
  !Number.isFinite(number) ||
  number<=0
 ){
  msg("قيمة الخصم غير صحيحة.");
  return;
 }

 const label=
  prompt(
   "اسم العرض",
   "عرض خاص"
  );

 if(label===null)return;

 try{
  const json=
   await api(
    "/api/admin/catalog/discount",
    {
     method:"POST",
     body:JSON.stringify({
      productId:id,
      discount:{
       type:
        normalizedType,
       value:number,
       label:label,
       active:true
      }
     })
    }
   );

  const product=
   data.find(
    item=>item.id===id
   );

  if(product){
   product.discount=
    json.discount;
  }

  updateStats();
  render();

  msg("تم حفظ العرض.");
 }catch(error){
  msg(error.message);
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

  const product=
   data.find(
    item=>item.id===id
   );

  if(product){
   product.discount=null;
  }

  updateStats();
  render();

  msg("تمت إزالة العرض.");
 }catch(error){
  msg(error.message);
 }
}

async function changeMode(){
 if(!key){
  msg("أدخل ADMIN_KEY أولاً.");
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
     mode:mode
    })
   }
  );

  settings.catalogMode=
   mode;

  msg(
   "تم تغيير طريقة عرض الكتالوج."
  );
 }catch(error){
  msg(error.message);
 }
}
</script>

</body>
</html>
`;

app.get(
  "/admin",
  (req, res) => {
    res
      .type("html")
      .send(
        ADMIN_HTML
      );
  }
);

/* ======================================================
   ORDERS
====================================================== */

const ORDERS =
  new Map();

function loadOrdersFromDisk() {
  const parsed =
    jsonFileRead(
      ORDERS_FILE,
      []
    );

  if (
    !Array.isArray(parsed)
  ) {
    return;
  }

  parsed.forEach(
    order => {
      if (
        order &&
        order.orderNumber
      ) {
        ORDERS.set(
          order.orderNumber,
          order
        );
      }
    }
  );

  console.log(
    "[ORDERS] Loaded " +
      ORDERS.size +
      " orders from disk"
  );
}

function saveOrdersToDisk() {
  jsonFileWrite(
    ORDERS_FILE,
    Array.from(
      ORDERS.values()
    )
  );
}

function customerKey(
  customer
) {
  const value =
    String(
      (
        customer &&
        (
          customer.phone ||
          customer.email
        )
      ) ||
        ""
    )
      .trim()
      .toLowerCase();

  if (!value) {
    return null;
  }

  return crypto
    .createHash(
      "sha256"
    )
    .update(value)
    .digest("hex")
    .slice(0, 24);
}

function generateOrderNumber() {
  const part1 =
    Math.floor(
      100000 +
        Math.random() *
          900000
    );

  const part2 =
    Math.floor(
      100000 +
        Math.random() *
          900000
    );

  return (
    "AB-" +
    part1 +
    "-" +
    part2
  );
}

loadOrdersFromDisk();

app.post(
  "/api/orders",
  (req, res) => {
    try {
      const body =
        req.body || {};

      const customer =
        body.customer;

      const items =
        body.items;

      const paymentMethod =
        body.paymentMethod;

      const amount =
        Number(body.total);

      if (
        !customer ||
        typeof customer !==
          "object"
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "customer is required"
          });
      }

      if (
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "items are required"
          });
      }

      if (!paymentMethod) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "paymentMethod is required"
          });
      }

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid total"
          });
      }

      const orderNumber =
        generateOrderNumber();

      const now =
        new Date().toISOString();

      const order = {
        orderNumber,

        customerKey:
          customerKey(
            customer
          ),

        customer: {
          name:
            String(
              customer.name ||
                ""
            ).trim(),

          phone:
            String(
              customer.phone ||
                ""
            ).trim(),

          email:
            String(
              customer.email ||
                ""
            ).trim()
        },

        items:
          items.map(item => ({
            productId:
              String(
                item.productId ||
                  ""
              ),

            name:
              String(
                item.name ||
                  ""
              ),

            quantity:
              Number(
                item.quantity
              ) || 1,

            price:
              Number(
                item.price
              ) || 0,

            fields:
              item.fields || {}
          })),

        payment: {
          method:
            String(
              paymentMethod
            ),

          status:
            "PENDING",

          transactionId:
            null
        },

        total:
          amount,

        status:
          "PAYMENT_PENDING",

        createdAt:
          now,

        updatedAt:
          now
      };

      ORDERS.set(
        orderNumber,
        order
      );

      saveOrdersToDisk();

      console.log(
        "[ORDER CREATED] " +
          orderNumber +
          " - " +
          amount +
          " SDG - " +
          paymentMethod
      );

      res.status(201).json({
        ok: true,

        order: {
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
    } catch (error) {
      console.error(
        "Create order error:",
        error
      );

      res.status(500).json({
        ok: false,
        error:
          "Failed to create order"
      });
    }
  }
);

app.get(
  "/api/orders/:orderNumber",
  (req, res) => {
    const order =
      ORDERS.get(
        req.params.orderNumber
      );

    if (!order) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "Order not found"
        });
    }

    res.json({
      ok: true,
      order
    });
  }
);

app.get(
  "/api/customer/orders",
  (req, res) => {
    const phone =
      String(
        req.query.phone ||
          ""
      ).trim();

    const email =
      String(
        req.query.email ||
          ""
      ).trim();

    const key =
      customerKey({
        phone,
        email
      });

    if (!key) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "phone or email is required"
        });
    }

    const customerOrders =
      Array.from(
        ORDERS.values()
      )
        .filter(
          order =>
            order.customerKey ===
            key
        )
        .sort(
          (a, b) =>
            new Date(
              b.createdAt
            ) -
            new Date(
              a.createdAt
            )
        )
        .map(order => ({
          orderNumber:
            order.orderNumber,

          total:
            order.total,

          status:
            order.status,

          paymentMethod:
            order.payment
              ? order.payment.method
              : null,

          createdAt:
            order.createdAt,

          items:
            order.items
        }));

    res.json({
      ok: true,

      total:
        customerOrders.length,

      orders:
        customerOrders
    });
  }
);

app.post(
  "/api/customer/reorder",
  async (req, res) => {
    try {
      const orderNumber =
        String(
          (
            req.body &&
            req.body.orderNumber
          ) || ""
        ).trim();

      const order =
        ORDERS.get(
          orderNumber
        );

      if (!order) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Order not found"
          });
      }

      const catalog =
        await getPricedCatalog();

      const byId =
        new Map(
          catalog.map(
            product => [
              String(
                product.id
              ),
              product
            ]
          )
        );

      const items =
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
              product &&
              Number(
                product.price_sdg
              ) > 0
          )
          .map(
            product => {
              const publicProduct =
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

                quantity:
                  1,

                fields:
                  publicProduct.fields ||
                  {}
              };
            }
          );

      res.json({
        ok: true,

        sourceOrderNumber:
          orderNumber,

        total:
          items.reduce(
            (sum, item) =>
              sum +
              Number(
                item.price || 0
              ),
            0
          ),

        items
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/* ======================================================
   ADMIN ORDERS
====================================================== */

app.get(
  "/api/admin/orders",
  requireAdmin,
  (req, res) => {
    const list =
      Array.from(
        ORDERS.values()
      ).sort(
        (a, b) =>
          new Date(
            b.createdAt
          ) -
          new Date(
            a.createdAt
          )
      );

    res.json({
      ok: true,
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
  (req, res) => {
    const order =
      ORDERS.get(
        req.params.orderNumber
      );

    if (!order) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "Order not found"
        });
    }

    if (
      order.status !==
      "PAYMENT_PENDING"
    ) {
      return res
        .status(409)
        .json({
          ok: false,
          error:
            "Order cannot be confirmed from status " +
            order.status
        });
    }

    const transactionId =
      String(
        (
          req.body &&
          req.body.transactionId
        ) || ""
      ).trim();

    if (!transactionId) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "transactionId is required"
        });
    }

    order.payment.transactionId =
      transactionId;

    order.payment.status =
      "CONFIRMED";

    order.status =
      "PAYMENT_CONFIRMED";

    order.updatedAt =
      new Date().toISOString();

    ORDERS.set(
      order.orderNumber,
      order
    );

    saveOrdersToDisk();

    console.log(
      "[PAYMENT CONFIRMED] " +
        order.orderNumber +
        " - " +
        transactionId
    );

    res.json({
      ok: true,
      order
    });
  }
);

/* ======================================================
   HOME
====================================================== */

app.get(
  "/",
  (req, res) => {
    const indexFile =
      path.join(
        __dirname,
        "public",
        "index.html"
      );

    if (
      fs.existsSync(indexFile)
    ) {
      return res.sendFile(
        indexFile
      );
    }

    res
      .status(404)
      .send(
        "ABESHA STORE frontend not found"
      );
  }
);

/* ======================================================
   START
====================================================== */

app.listen(
  PORT,
  () => {
    console.log(
      "ABESHA STORE running on port " +
        PORT
    );

    console.log(
      "Pricing USD -> SDG: " +
        USD_TO_SDG
    );

    console.log(
      "Pricing tiers: 7% / 8% / 9% / 10%"
    );

    console.log(
      "Fazer API: " +
        FAZER_API
    );
  }
);
