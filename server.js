const express = require("express");
const path = require("path");
const fs = require("fs");

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
const PRICE_CACHE_FILE = path.join(__dirname, "pricing-cache.json");

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
    const params = new URLSearchParams({ limit: "50" });

    if (cursor) {
      params.set("cursor", cursor);
    }

    const data = await fazerGet(
      `${endpoint}?${params.toString()}`
    );

    if (Array.isArray(data.items)) {
      items.push(...data.items);
    }

    const nextCursor = data.meta?.next_cursor;

    if (!nextCursor || data.meta?.has_more === false) {
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

  return getArray(
    data,
    ["items", "offers"]
  );
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

async function buildPricedCatalog() {
  console.log(
    "[PRICE CACHE] Building complete priced catalog..."
  );

  const [
    topups,
    giftcards,
    gamekeys
  ] = await Promise.all([
    getAllCategories("topups"),
    getAllCategories("giftcards"),
    getAllCategories("gamekeys")
  ]);

  const products = [];

  // ----------------------------------------------------
  // Topups
  // ----------------------------------------------------

  const topupResults = await mapWithConcurrency(
    topups,
    async category => {
      const categoryId = String(
        category.category_id || ""
      );

      const categoryName = String(
        category.name || categoryId
      );

      // PUBG يبقى تحت التحكم اليدوي الموجود في الواجهة.
      if (PRICE_OVERRIDES[categoryId]) {
        return [{
          id: categoryId,
          category_id: categoryId,
          name: categoryName,
          type: "topup",
          note: category.note || "",
          fields: category.fields || [],
          pricing_mode: "manual_override",
          offers: []
        }];
      }

      try {
        const offers = await getTopupOffers(
          categoryId
        );

        return offers.map(
          (offer, index) => {
            const label = offerLabel(offer);
            const priceUsd = offerPriceUsd(offer);
            const calculatedPrice =
              calculateSalePrice(priceUsd);

            const override =
              getOverride(
                categoryId,
                label
              );

            const finalPrice =
              override || calculatedPrice;

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

              note: category.note || "",

              fields: category.fields || [],

              price_usd: priceUsd,

              cost_sdg: priceUsd
                ? Math.round(
                    priceUsd * USD_TO_SDG
                  )
                : null,

              markup_percent: priceUsd
                ? getMarkupForCost(
                    priceUsd * USD_TO_SDG
                  ) * 100
                : null,

              price_sdg: finalPrice,

              pricing_mode:
                override
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

        return [{
          id: categoryId,
          category_id: categoryId,
          name: categoryName,
          type: "topup",
          note: category.note || "",
          fields: category.fields || [],
          price_usd: null,
          price_sdg: null,
          pricing_mode: "unavailable"
        }];
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
          category.category_id || ""
        );

        const categoryName = String(
          category.name || categoryId
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

                type:
                  "gift_card",

                note:
                  category.note || "",

                fields:
                  category.fields || [],

                price_usd:
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

                offer:
                  offer
              };
            }
          );
        } catch (error) {
          console.warn(
            `[PRICE] Failed gift card ${categoryId}: ${error.message}`
          );

          return [{
            id: categoryId,
            category_id: categoryId,
            name: categoryName,
            type: "gift_card",
            note: category.note || "",
            fields: category.fields || [],
            price_usd: null,
            price_sdg: null,
            pricing_mode: "unavailable"
          }];
        }
      },
      6
    );

  for (
    const result
    of giftcardResults
  ) {
    if (Array.isArray(result)) {
      products.push(...result);
    }
  }

  // ----------------------------------------------------
  // Game Keys
  // ----------------------------------------------------
  // لا نفترض وجود endpoint للأسعار غير موثق في مشروعنا الحالي.
  // نحافظ على فئات Game Keys حتى لا نكسر الكتالوج.

  for (const item of gamekeys) {
    const gameKeyUsd =
      Number(item.price_usd);

    const gameKeyPrice =
      Number.isFinite(gameKeyUsd) &&
      gameKeyUsd > 0
        ? calculateSalePrice(
            gameKeyUsd
          )
        : Number(item.price_sdg) ||
          null;

    products.push({
      id:
        item.game_id ||
        item.category_id,

      category_id:
        item.category_id ||
        item.game_id,

      name:
        item.name,

      type:
        "game_key",

      platform:
        item.platform || "",

      region:
        item.region || "",

      region_restriction:
        item.region_restriction ||
        false,

      price_usd:
        Number.isFinite(gameKeyUsd) &&
        gameKeyUsd > 0
          ? gameKeyUsd
          : null,

      cost_sdg:
        Number.isFinite(gameKeyUsd) &&
        gameKeyUsd > 0
          ? Math.round(
              gameKeyUsd *
              USD_TO_SDG
            )
          : null,

      markup_percent:
        Number.isFinite(gameKeyUsd) &&
        gameKeyUsd > 0
          ? getMarkupForCost(
              gameKeyUsd *
              USD_TO_SDG
            ) * 100
          : null,

      price_sdg:
        gameKeyPrice,

      pricing_mode:
        Number.isFinite(gameKeyUsd) &&
        gameKeyUsd > 0
          ? "automatic"
          : "unavailable"
    });
  }

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
    `[PRICE CACHE] Built ${products.length} catalog entries; ${usablePrices} have prices`
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
          pricedCatalogCache.length
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

// ======================================================
// الصحة
// ======================================================

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
          pricedCatalogCache?.length ||
          0
      }
    });
  }
);

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
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message,
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
      const data =
        await fazerGet(
          "/catalog"
        );

      res.json(data);
    } catch (error) {
      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message,
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
      res
        .status(
          error.status || 500
        )
        .json({
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

      const data =
        await fazerGet(
          `/topups/offers?category_id=${encodeURIComponent(
            categoryId
          )}`
        );

      res.json(data);
    } catch (error) {
      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message,
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
      res
        .status(
          error.status || 500
        )
        .json({
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

      const data =
        await fazerGet(
          `/giftcards/cards?category_id=${encodeURIComponent(
            categoryId
          )}`
        );

      res.json(data);
    } catch (error) {
      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message,
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

      res.json({
        ok: true,

        total:
          products.length,

        products,

        pricing: {
          currency:
            "SDG",

          usdToSdg:
            USD_TO_SDG,

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
      res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);

// ======================================================
// تحديث الأسعار يدويًا عند الحاجة
// ======================================================

app.post(
  "/api/prices/refresh",
  async (req, res) => {
    try {
      const adminKey =
        req.headers[
          "x-admin-key"
        ];

      if (
        !process.env.ADMIN_KEY ||
        adminKey !==
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
      res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
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
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                category_id,
                fields
              })
          }
        );

      res.json(data);
    } catch (error) {
      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message,
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
      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message,
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
        .status(
          error.status || 500
        )
        .json({
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

      const data =
        await fazerGet(
          `/steam-gifts/games?limit=${encodeURIComponent(
            limit
          )}`
        );

      res.json(data);
    } catch (error) {
      res
        .status(
          error.status || 500
        )
        .json({
          ok: false,
          error:
            error.message,
          details:
            error.data || null
        });
    }
  }
);

// ======================================================
// الكتالوج الموحد القديم — محفوظ للتوافق
// ======================================================

app.get(
  "/api/catalog",
  async (req, res) => {
    try {
      const [
        topups,
        giftcards,
        gamekeys
      ] = await Promise.all([
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

      const products = [
        ...topups.map(
          item => ({
            id:
              item.category_id,

            name:
              item.name,

            type:
              "topup",

            note:
              item.note || "",

            fields:
              item.fields || []
          })
        ),

        ...giftcards.map(
          item => ({
            id:
              item.category_id,

            name:
              item.name,

            type:
              "gift_card",

            note:
              item.note || "",

            fields:
              item.fields || []
          })
        ),

        ...gamekeys.map(
          item => ({
            id:
              item.game_id ||
              item.category_id,

            name:
              item.name,

            type:
              "game_key",

            platform:
              item.platform ||
              "",

            region:
              item.region ||
              "",

            region_restriction:
              item.region_restriction ||
              false
          })
        )
      ];

      res.json({
        ok: true,
        total:
          products.length,
        products
      });
    } catch (error) {
      res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
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
          error:
            error.message
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
    req.headers[
      "x-admin-key"
    ];

  if (
    !process.env.ADMIN_KEY
  ) {
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
        error:
          "Unauthorized"
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

        total:
          data.length,

        products:
          data,

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
          error:
            error.message
        });
    }
  }
);

// ======================================================
// الطلبات
// ======================================================

const orders =
  new Map();

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

  return `AB-${part1}-${part2}`;
}

app.post(
  "/api/orders",
  (req, res) => {
    try {
      const {
        customer,
        items,
        paymentMethod,
        total
      } = req.body;

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
        !Array.isArray(
          items
        ) ||
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

      if (
        !paymentMethod
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "paymentMethod is required"
          });
      }

      const amount =
        Number(total);

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

      const order = {
        orderNumber,

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
          items.map(
            item => ({
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
                item.quantity ||
                "",

              price:
                Number(
                  item.price
                ) || 0,

              fields:
                item.fields ||
                {}
            })
          ),

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
          new Date()
            .toISOString(),

        updatedAt:
          new Date()
            .toISOString()
      };

      orders.set(
        orderNumber,
        order
      );

      console.log(
        `[ORDER CREATED] ${orderNumber} - ${amount} SDG - ${paymentMethod}`
      );

      res
        .status(201)
        .json({
          ok: true,

          order: {
            orderNumber:
              order.orderNumber,

            status:
              order.status,

            total:
              order.total,

            paymentMethod:
              order.payment
                .method,

            createdAt:
              order.createdAt
          }
        });
    } catch (error) {
      console.error(
        "Create order error:",
        error
      );

      res
        .status(500)
        .json({
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
      orders.get(
        req.params
          .orderNumber
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
  "/api/admin/orders",
  requireAdmin,
  (req, res) => {
    const list =
      Array.from(
        orders.values()
      )
        .sort(
          (a, b) => {
            return (
              new Date(
                b.createdAt
              ) -
              new Date(
                a.createdAt
              )
            );
          }
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
      orders.get(
        req.params
          .orderNumber
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
            `Order cannot be confirmed from status ${order.status}`
        });
    }

    const transactionId =
      String(
        req.body
          ?.transactionId ||
          ""
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
      new Date()
        .toISOString();

    orders.set(
      order.orderNumber,
      order
    );

    console.log(
      `[PAYMENT CONFIRMED] ${order.orderNumber} - ${transactionId}`
    );

    res.json({
      ok: true,
      order
    });
  }
);

// ======================================================
// الصفحة الرئيسية
// ======================================================

app.get(
  "/",
  (req, res) => {
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
  () => {
    console.log(
      `ABESHA STORE running on port ${PORT}`
    );

    console.log(
      `Pricing USD → SDG: ${USD_TO_SDG}`
    );
  }
);
