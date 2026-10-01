const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const FAZER_API = "https://api.fzr.cards/api/v2";
const USD_TO_SDG = 8250;

const CACHE_FILE = path.join(__dirname, "pricing-cache.json");
const CACHE_TTL = 6 * 60 * 60 * 1000;

// ======================================================
// ABESHA STORE
// نظام التسعير
// ======================================================

const PRICING_TIERS = [
  { max: 20000, markup: 0.07 },
  { max: 100000, markup: 0.08 },
  { max: 300000, markup: 0.09 },
  { max: Infinity, markup: 0.10 }
];

// ======================================================
// أسعار PUBG المتفق عليها
// ======================================================

const PUBG_PRICES = {
  pubg_mobile_auto: {
    60: 7950,
    325: 40000,
    660: 80000,
    8100: 800000
  },

  pubg_mobile_fast: {
    1800: 200000,
    3850: 400000
  },

  pubg_mobile_manual: {
    1800: 200000,
    3850: 400000
  }
};

// ======================================================
// الذاكرة المؤقتة
// ======================================================

let priceCache = null;
let cacheTime = 0;
let building = null;

// ======================================================
// الطلبات
// ======================================================

const orders = new Map();

// ======================================================
// Express
// ======================================================

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// ======================================================
// Fazer API
// ======================================================

function requireFazerKey() {
  if (!process.env.FAZER_API_KEY) {
    const error = new Error(
      "FAZER_API_KEY is not configured"
    );

    error.status = 500;

    throw error;
  }
}

async function fazer(endpoint, options = {}) {
  requireFazerKey();

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    options.timeout || 30000
  );

  try {
    const response = await fetch(
      FAZER_API + endpoint,
      {
        ...options,

        headers: {
          "X-API-Key":
            process.env.FAZER_API_KEY,

          "Accept":
            "application/json",

          ...(options.headers || {})
        },

        signal: controller.signal
      }
    );

    const text = await response.text();

    let data = {};

    try {
      data = text
        ? JSON.parse(text)
        : {};
    } catch {
      data = {
        raw: text
      };
    }

    if (!response.ok) {
      const error = new Error(
        data?.message ||
        data?.error ||
        `Fazer API HTTP ${response.status}`
      );

      error.status =
        response.status;

      error.data = data;

      throw error;
    }

    return data;

  } finally {
    clearTimeout(timer);
  }
}

// ======================================================
// قراءة Arrays من استجابات Fazer
// ======================================================

function getArray(
  data,
  keys = []
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

// ======================================================
// جلب فئات Fazer باستخدام Cursor Pagination
// ======================================================

async function getCategories(
  family
) {
  const result = [];

  let cursor = null;

  for (
    let page = 0;
    page < 100;
    page++
  ) {
    const endpoint = cursor
      ? `/${family}?cursor=${encodeURIComponent(cursor)}`
      : `/${family}`;

    const data =
      await fazer(endpoint);

    const items = getArray(
      data,
      [
        "items",
        "categories",
        "games"
      ]
    );

    result.push(...items);

    cursor =
      data?.meta?.next_cursor ||
      data?.next_cursor ||
      data?.pagination?.next_cursor ||
      null;

    if (!cursor) {
      break;
    }
  }

  return result;
}

// ======================================================
// عروض Topups / Gift Cards
// ======================================================

function getOffersArray(
  data,
  family
) {
  if (
    family === "giftcards"
  ) {
    return getArray(
      data,
      [
        "items",
        "cards",
        "offers"
      ]
    );
  }

  return getArray(
    data,
    [
      "items",
      "offers"
    ]
  );
}

// ======================================================
// استخراج السعر بالدولار
// ======================================================

function getUsdPrice(
  product
) {
  const fields = [
    "price_usd",
    "priceUSD",
    "usd_price",
    "cost_usd",
    "costUSD",
    "price"
  ];

  for (
    const field of fields
  ) {
    const value =
      Number(product?.[field]);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }

  return null;
}

// ======================================================
// اسم العرض
// ======================================================

function getOfferLabel(
  offer
) {
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

// ======================================================
// رقم الكمية لـ PUBG
// ======================================================

function getQuantity(
  text
) {
  const match =
    String(text || "").match(
      /\b(8100|6000|3850|3000|1800|1500|1300|1100|660|650|600|325|300|270|205|170|100|65|60|50|40|20)\b/i
    );

  return match
    ? Number(match[1])
    : null;
}

// ======================================================
// سعر PUBG اليدوي
// ======================================================

function getPubgOverride(
  categoryId,
  text
) {
  const quantity =
    getQuantity(text);

  if (
    quantity === null
  ) {
    return null;
  }

  return (
    PUBG_PRICES[
      categoryId
    ]?.[quantity] || null
  );
}

// ======================================================
// نسبة الربح
// ======================================================

function getMarkup(
  costSdg
) {
  const tier =
    PRICING_TIERS.find(
      item =>
        costSdg <= item.max
    );

  return tier
    ? tier.markup
    : 0.10;
}

// ======================================================
// التقريب التجاري
// ======================================================

function roundPrice(
  value
) {
  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return null;
  }

  let step;

  if (value < 10000) {
    step = 100;
  }

  else if (
    value < 100000
  ) {
    step = 500;
  }

  else if (
    value < 500000
  ) {
    step = 1000;
  }

  else {
    step = 5000;
  }

  return (
    Math.ceil(
      value / step
    ) * step
  );
}

// ======================================================
// حساب سعر البيع
// ======================================================

function calculateSalePrice(
  usd
) {
  const priceUsd =
    Number(usd);

  if (
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0
  ) {
    return null;
  }

  const costSdg =
    priceUsd * USD_TO_SDG;

  const markup =
    getMarkup(costSdg);

  const sale =
    costSdg *
    (1 + markup);

  return roundPrice(
    sale
  );
}

// ======================================================
// توافق مع index.html الحالي
// ======================================================

function frontendCompatibleUsd(
  saleSdg
) {
  const sale =
    Number(saleSdg);

  if (
    !Number.isFinite(sale) ||
    sale <= 0
  ) {
    return null;
  }

  /*
    index.html الحالي يحسب:

    USD × 8050 × 1.10

    لذلك نعيد قيمة USD اصطناعية
    حتى تظهر قيمة البيع الصحيحة
    بدون تعديل index.html.
  */

  return (
    sale /
    (8050 * 1.10)
  );
}

// ======================================================
// ID للعرض
// ======================================================

function getOfferId(
  offer,
  index
) {
  return String(
    offer?.id ||
    offer?.offer_id ||
    offer?.offerId ||
    offer?.sku ||
    offer?.code ||
    index
  );
}

// ======================================================
// تنفيذ مهام بعدد متوازٍ محدود
// ======================================================

async function mapLimit(
  items,
  worker,
  limit = 6
) {
  const result =
    new Array(
      items.length
    );

  let index = 0;

  async function runner() {
    while (true) {
      const current =
        index++;

      if (
        current >=
        items.length
      ) {
        return;
      }

      try {
        result[current] =
          await worker(
            items[current],
            current
          );
      }

      catch (error) {
        result[current] = [];

        console.warn(
          "[PRICE WORKER]",
          error.message
        );
      }
    }
  }

  const count =
    Math.min(
      limit,
      items.length || 1
    );

  await Promise.all(
    Array.from(
      {
        length: count
      },
      () => runner()
    )
  );

  return result;
}

// ======================================================
// بناء منتجات Topups / Gift Cards
// ======================================================

async function buildFamilyProducts(
  category,
  family
) {
  const categoryId =
    String(
      category?.category_id ||
      category?.game_id ||
      ""
    );

  const categoryName =
    String(
      category?.name ||
      categoryId
    );

  if (!categoryId) {
    return [];
  }

  // PUBG بأسعارنا الخاصة
  if (
    family === "topups" &&
    PUBG_PRICES[categoryId]
  ) {
    return [
      {
        id: categoryId,

        category_id:
          categoryId,

        name:
          categoryName,

        type:
          "topup",

        fields:
          category.fields ||
          [],

        note:
          category.note ||
          "",

        pricing_mode:
          "manual_override",

        price_sdg:
          null,

        price_usd:
          null
      }
    ];
  }

  try {
    let endpoint;

    if (
      family === "giftcards"
    ) {
      endpoint =
        `/giftcards/cards?category_id=${encodeURIComponent(categoryId)}`;
    }

    else {
      endpoint =
        `/topups/offers?category_id=${encodeURIComponent(categoryId)}`;
    }

    const data =
      await fazer(endpoint);

    const offers =
      getOffersArray(
        data,
        family
      );

    return offers.map(
      (offer, index) => {
        const offerLabel =
          getOfferLabel(
            offer
          );

        const usd =
          getUsdPrice(
            offer
          );

        let sale =
          calculateSalePrice(
            usd
          );

        const forced =
          family === "topups"
            ? getPubgOverride(
                categoryId,
                offerLabel
              )
            : null;

        if (
          forced !== null
        ) {
          sale = forced;
        }

        return {
          id:
            `${categoryId}__offer__${getOfferId(
              offer,
              index
            )}`,

          category_id:
            categoryId,

          name:
            offerLabel === "عرض"
              ? categoryName
              : `${categoryName} — ${offerLabel}`,

          base_name:
            categoryName,

          type:
            family === "giftcards"
              ? "gift_card"
              : "topup",

          fields:
            category.fields ||
            [],

          note:
            category.note ||
            "",

          price_usd:
            frontendCompatibleUsd(
              sale
            ),

          source_price_usd:
            usd,

          cost_sdg:
            usd
              ? Math.round(
                  usd *
                  USD_TO_SDG
                )
              : null,

          markup_percent:
            usd
              ? getMarkup(
                  usd *
                  USD_TO_SDG
                ) * 100
              : null,

          price_sdg:
            sale,

          pricing_mode:
            forced !== null
              ? "manual_override"
              : "automatic",

          offer
        };
      }
    );
  }

  catch (error) {
    /*
      مهم جداً:

      إذا كان Gift Cards غير متاح
      في حساب Fazer أو المسار يرجع 404،
      لا نسقط /api/products بالكامل.
    */

    console.warn(
      `[PRICE] ${family} ${categoryId}: ${error.message}`
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
          family === "giftcards"
            ? "gift_card"
            : "topup",

        fields:
          category.fields ||
          [],

        note:
          category.note ||
          "",

        price_usd:
          null,

        price_sdg:
          null,

        pricing_mode:
          "unavailable"
      }
    ];
  }
}

// ======================================================
// بناء الكتالوج الكامل
// ======================================================

async function buildCatalog() {
  console.log(
    "[PRICE] Building Fazer catalog..."
  );

  /*
    كل عائلة مستقلة.

    Topups
    Gift Cards
    Game Keys
  */

  const families =
    await Promise.allSettled(
      [
        getCategories(
          "topups"
        ),

        getCategories(
          "giftcards"
        ),

        getCategories(
          "gamekeys"
        )
      ]
    );

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

  if (
    families[0].status ===
    "rejected"
  ) {
    console.warn(
      "[FAZER] Topups unavailable:",
      families[0].reason?.message
    );
  }

  if (
    families[1].status ===
    "rejected"
  ) {
    console.warn(
      "[FAZER] Gift Cards unavailable:",
      families[1].reason?.message
    );
  }

  if (
    families[2].status ===
    "rejected"
  ) {
    console.warn(
      "[FAZER] Game Keys unavailable:",
      families[2].reason?.message
    );
  }

  const products = [];

  // ====================================================
  // TOPUPS
  // ====================================================

  const topupProducts =
    await mapLimit(
      topups,

      category =>
        buildFamilyProducts(
          category,
          "topups"
        ),

      6
    );

  for (
    const group of topupProducts
  ) {
    products.push(
      ...group
    );
  }

  // ====================================================
  // GIFT CARDS
  // ====================================================

  const giftcardProducts =
    await mapLimit(
      giftcards,

      category =>
        buildFamilyProducts(
          category,
          "giftcards"
        ),

      6
    );

  for (
    const group of giftcardProducts
  ) {
    products.push(
      ...group
    );
  }

  // ====================================================
  // GAME KEYS
  // ====================================================

  for (
    const game of gamekeys
  ) {
    const usd =
      getUsdPrice(
        game
      );

    const sale =
      calculateSalePrice(
        usd
      );

    products.push(
      {
        id:
          String(
            game.game_id ||
            game.category_id ||
            ""
          ),

        category_id:
          String(
            game.category_id ||
            game.game_id ||
            ""
          ),

        name:
          game.name,

        type:
          "game_key",

        platform:
          game.platform ||
          "",

        region:
          game.region ||
          "",

        region_restriction:
          game.region_restriction ||
          false,

        price_usd:
          frontendCompatibleUsd(
            sale
          ),

        source_price_usd:
          usd,

        cost_sdg:
          usd
            ? Math.round(
                usd *
                USD_TO_SDG
              )
            : null,

        markup_percent:
          usd
            ? getMarkup(
                usd *
                USD_TO_SDG
              ) * 100
            : null,

        price_sdg:
          sale,

        pricing_mode:
          sale
            ? "automatic"
            : "unavailable"
      }
    );
  }

  // ====================================================
  // حفظ الكاش
  // ====================================================

  priceCache =
    products;

  cacheTime =
    Date.now();

  try {
    fs.writeFileSync(
      CACHE_FILE,

      JSON.stringify(
        {
          builtAt:
            cacheTime,

          usdToSdg:
            USD_TO_SDG,

          products
        },

        null,

        2
      )
    );
  }

  catch (error) {
    console.warn(
      "[PRICE] Cache save failed:",
      error.message
    );
  }

  console.log(
    `[PRICE] Built ${products.length} entries.`
  );

  return products;
}

// ======================================================
// تحميل الكاش
// ======================================================

function loadCache() {
  try {
    if (
      !fs.existsSync(
        CACHE_FILE
      )
    ) {
      return;
    }

    const data =
      JSON.parse(
        fs.readFileSync(
          CACHE_FILE,
          "utf8"
        )
      );

    if (
      Array.isArray(
        data.products
      ) &&
      Number.isFinite(
        data.builtAt
      )
    ) {
      priceCache =
        data.products;

      cacheTime =
        data.builtAt;

      console.log(
        `[PRICE] Loaded ${priceCache.length} cached products`
      );
    }
  }

  catch (error) {
    console.warn(
      "[PRICE] Cache load failed:",
      error.message
    );
  }
}

// ======================================================
// الحصول على الكتالوج المسعّر
// ======================================================

async function getPricedCatalog() {
  const fresh =
    priceCache &&
    priceCache.length > 0 &&
    Date.now() -
      cacheTime <
      CACHE_TTL;

  if (fresh) {
    return priceCache;
  }

  if (building) {
    return building;
  }

  building =
    buildCatalog()
      .catch(error => {
        console.error(
          "[PRICE] Build failed:",
          error.message
        );

        if (
          priceCache &&
          priceCache.length
        ) {
          return priceCache;
        }

        throw error;
      })
      .finally(() => {
        building =
          null;
      });

  return building;
}

// ======================================================
// ADMIN
// ======================================================

function requireAdmin(
  req,
  res,
  next
) {
  if (
    !process.env.ADMIN_KEY
  ) {
    return res.status(500).json(
      {
        ok: false,
        error:
          "ADMIN_KEY is not configured"
      }
    );
  }

  if (
    req.headers[
      "x-admin-key"
    ] !==
    process.env.ADMIN_KEY
  ) {
    return res.status(401).json(
      {
        ok: false,
        error:
          "Unauthorized"
      }
    );
  }

  next();
}

// ======================================================
// HEALTH
// ======================================================

app.get(
  "/health",
  (req, res) => {
    res.json(
      {
        ok: true,

        service:
          "ABESHA STORE",

        status:
          "running",

        pricing: {
          usdToSdg:
            USD_TO_SDG,

          cacheFresh:
            !!(
              priceCache &&
              priceCache.length &&
              Date.now() -
                cacheTime <
                CACHE_TTL
            ),

          cachedProducts:
            priceCache?.length ||
            0
        }
      }
    );
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
        await fazer(
          "/me"
        );

      res.json(data);
    }

    catch (error) {
      res.status(
        error.status || 500
      ).json(
        {
          ok: false,
          error:
            error.message,
          details:
            error.data ||
            null
        }
      );
    }
  }
);

// ======================================================
// TOPUPS
// ======================================================

app.get(
  "/api/fazer/topups",
  async (req, res) => {
    try {
      const items =
        await getCategories(
          "topups"
        );

      res.json(
        {
          ok: true,

          kind:
            "topup",

          items,

          meta: {
            total:
              items.length
          }
        }
      );
    }

    catch (error) {
      res.status(
        error.status || 500
      ).json(
        {
          ok: false,
          error:
            error.message,
          details:
            error.data ||
            null
        }
      );
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
        return res.status(
          400
        ).json(
          {
            ok: false,
            error:
              "category_id is required"
          }
        );
      }

      const data =
        await fazer(
          `/topups/offers?category_id=${encodeURIComponent(
            categoryId
          )}`
        );

      res.json(data);
    }

    catch (error) {
      res.status(
        error.status || 500
      ).json(
        {
          ok: false,
          error:
            error.message,
          details:
            error.data ||
            null
        }
      );
    }
  }
);

// ======================================================
// GIFT CARDS
// ======================================================

app.get(
  "/api/fazer/giftcards",
  async (req, res) => {
    try {
      const items =
        await getCategories(
          "giftcards"
        );

      res.json(
        {
          ok: true,

          kind:
            "gift_card",

          items,

          meta: {
            total:
              items.length
          }
        }
      );
    }

    catch (error) {
      res.status(
        error.status || 500
      ).json(
        {
          ok: false,
          error:
            error.message,
          details:
            error.data ||
            null
        }
      );
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
        return res.status(
          400
        ).json(
          {
            ok: false,
            error:
              "category_id is required"
          }
        );
      }

      const data =
        await fazer(
          `/giftcards/cards?category_id=${encodeURIComponent(
            categoryId
          )}`
        );

      res.json(data);
    }

    catch (error) {
      res.status(
        error.status || 500
      ).json(
        {
          ok: false,
          error:
            error.message,
          details:
            error.data ||
            null
        }
      );
    }
  }
);

// ======================================================
// GAME KEYS
// ======================================================

app.get(
  "/api/fazer/gamekeys",
  async (req, res) => {
    try {
      const items =
        await getCategories(
          "gamekeys"
        );

      res.json(
        {
          ok: true,

          kind:
            "game_key",

          items,

          meta: {
            total:
              items.length
          }
        }
      );
    }

    catch (error) {
      res.status(
        error.status || 500
      ).json(
        {
          ok: false,
          error:
            error.message,
          details:
            error.data ||
            null
        }
      );
    }
  }
);

// ======================================================
// Fazer Catalog
// ======================================================

app.get(
  "/api/fazer/catalog",
  async (req, res) => {
    const result =
      await Promise.allSettled(
        [
          getCategories(
            "topups"
          ),

          getCategories(
            "giftcards"
          ),

          getCategories(
            "gamekeys"
          )
        ]
      );

    const topups =
      result[0].status ===
      "fulfilled"
        ? result[0].value
        : [];

    const giftcards =
      result[1].status ===
      "fulfilled"
        ? result[1].value
        : [];

    const gamekeys =
      result[2].status ===
      "fulfilled"
        ? result[2].value
        : [];

    res.json(
      {
        ok: true,

        families: {
          topups: {
            ok:
              result[0].status ===
              "fulfilled",

            items:
              topups
          },

          giftcards: {
            ok:
              result[1].status ===
              "fulfilled",

            items:
              giftcards
          },

          gamekeys: {
            ok:
              result[2].status ===
              "fulfilled",

            items:
              gamekeys
          }
        },

        total:
          topups.length +
          giftcards.length +
          gamekeys.length
      }
    );
  }
);

// ======================================================
// PRODUCTS
// ======================================================

app.get(
  "/api/products",
  async (req, res) => {
    try {
      const products =
        await getPricedCatalog();

      res.json(
        {
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
                      tier.max
                    )
                      ? tier.max
                      : null,

                  markupPercent:
                    tier.markup *
                    100
                })
              ),

            rounding: {
              under10000:
                100,

              from10000:
                500,

              from100000:
                1000,

              from500000:
                5000
            }
          }
        }
      );
    }

    catch (error) {
      res.status(
        500
      ).json(
        {
          ok: false,
          error:
            error.message
        }
      );
    }
  }
);

// ======================================================
// تحديث الأسعار
// ======================================================

app.post(
  "/api/prices/refresh",
  requireAdmin,
  async (req, res) => {
    try {
      priceCache =
        null;

      cacheTime =
        0;

      const products =
        await getPricedCatalog();

      res.json(
        {
          ok: true,

          total:
            products.length,

          refreshedAt:
            new Date()
              .toISOString()
        }
      );
    }

    catch (error) {
      res.status(
        500
      ).json(
        {
          ok: false,
          error:
            error.message
        }
      );
    }
  }
);

// ======================================================
// PUBG ID Validation
// ======================================================

app.post(
  "/api/fazer/topups/validate-id",
  async (req, res) => {
    try {
      const data =
        await fazer(
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
                {
                  category_id:
                    req.body.category_id,

                  fields:
                    req.body.fields
                }
              )
          }
        );

      res.json(data);
    }

    catch (error) {
      res.status(
        error.status || 500
      ).json(
        {
          ok: false,
          error:
            error.message,
          details:
            error.data ||
            null
        }
      );
    }
  }
);

// ======================================================
// STEAM
// ======================================================

app.get(
  "/api/fazer/steam-topup/rates",
  async (req, res) => {
    try {
      res.json(
        await fazer(
          "/steam-topup/rates"
        )
      );
    }

    catch (error) {
      res.status(
        error.status || 500
      ).json(
        {
          ok: false,
          error:
            error.message,
          details:
            error.data ||
            null
        }
      );
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
        await fazer(
          `/steam-gifts/games?limit=${encodeURIComponent(
            limit
          )}`
        )
      );
    }

    catch (error) {
      res.status(
        error.status || 500
      ).json(
        {
          ok: false,
          error:
            error.message,
          details:
            error.data ||
            null
        }
      );
    }
  }
);

// ======================================================
// CATALOG القديم للتوافق
// ======================================================

app.get(
  "/api/catalog",
  async (req, res) => {
    const result =
      await Promise.allSettled(
        [
          getCategories(
            "topups"
          ),

          getCategories(
            "giftcards"
          ),

          getCategories(
            "gamekeys"
          )
        ]
      );

    const topups =
      result[0].status ===
      "fulfilled"
        ? result[0].value
        : [];

    const giftcards =
      result[1].status ===
      "fulfilled"
        ? result[1].value
        : [];

    const gamekeys =
      result[2].status ===
      "fulfilled"
        ? result[2].value
        : [];

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
            item.note ||
            "",

          fields:
            item.fields ||
            []
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
            item.note ||
            "",

          fields:
            item.fields ||
            []
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

    res.json(
      {
        ok: true,

        total:
          products.length,

        products
      }
    );
  }
);

// ======================================================
// Published Catalog
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

      res.json(
        {
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
            config.pricing ||
            {}
        }
      );
    }

    catch (error) {
      res.status(
        500
      ).json(
        {
          ok: false,
          error:
            error.message
        }
      );
    }
  }
);

// ======================================================
// ADMIN STATUS
// ======================================================

app.get(
  "/api/admin/status",
  (req, res) => {
    res.json(
      {
        ok: true,

        adminKeyConfigured:
          Boolean(
            process.env.ADMIN_KEY
          )
      }
    );
  }
);

// ======================================================
// ADMIN CATALOG
// ======================================================

app.get(
  "/api/admin/catalog",
  requireAdmin,
  async (req, res) => {
    try {
      const products =
        await getPricedCatalog();

      res.json(
        {
          ok: true,

          total:
            products.length,

          products,

          pricing: {
            usdToSdg:
              USD_TO_SDG,

            tiers:
              PRICING_TIERS
          }
        }
      );
    }

    catch (error) {
      res.status(
        500
      ).json(
        {
          ok: false,
          error:
            error.message
        }
      );
    }
  }
);

// ======================================================
// ORDERS
// ======================================================

function generateOrderNumber() {
  return (
    "AB-" +
    Math.floor(
      100000 +
      Math.random() *
        900000
    ) +
    "-" +
    Math.floor(
      100000 +
      Math.random() *
        900000
    )
  );
}

// ======================================================
// إنشاء طلب
// ======================================================

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
        return res.status(
          400
        ).json(
          {
            ok: false,
            error:
              "customer is required"
          }
        );
      }

      if (
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return res.status(
          400
        ).json(
          {
            ok: false,
            error:
              "items are required"
          }
        );
      }

      if (
        !paymentMethod
      ) {
        return res.status(
          400
        ).json(
          {
            ok: false,
            error:
              "paymentMethod is required"
          }
        );
      }

      const amount =
        Number(total);

      if (
        !Number.isFinite(
          amount
        ) ||
        amount <= 0
      ) {
        return res.status(
          400
        ).json(
          {
            ok: false,
            error:
              "Invalid total"
          }
        );
      }

      const number =
        generateOrderNumber();

      const now =
        new Date()
          .toISOString();

      const order = {
        orderNumber:
          number,

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
          now,

        updatedAt:
          now
      };

      orders.set(
        number,
        order
      );

      console.log(
        `[ORDER CREATED] ${number} - ${amount} SDG`
      );

      res.status(
        201
      ).json(
        {
          ok: true,

          order: {
            orderNumber:
              number,

            status:
              order.status,

            total:
              amount,

            paymentMethod:
              order.payment
                .method,

            createdAt:
              now
          }
        }
      );
    }

    catch (error) {
      console.error(
        "Create order error:",
        error
      );

      res.status(
        500
      ).json(
        {
          ok: false,
          error:
            "Failed to create order"
        }
      );
    }
  }
);

// ======================================================
// قراءة طلب
// ======================================================

app.get(
  "/api/orders/:orderNumber",
  (req, res) => {
    const order =
      orders.get(
        req.params
          .orderNumber
      );

    if (!order) {
      return res.status(
        404
      ).json(
        {
          ok: false,
          error:
            "Order not found"
        }
      );
    }

    res.json(
      {
        ok: true,
        order
      }
    );
  }
);

// ======================================================
// ADMIN ORDERS
// ======================================================

app.get(
  "/api/admin/orders",
  requireAdmin,
  (req, res) => {
    const list =
      Array.from(
        orders.values()
      ).sort(
        (a, b) =>
          new Date(
            b.createdAt
          ) -
          new Date(
            a.createdAt
          )
      );

    res.json(
      {
        ok: true,

        total:
          list.length,

        orders:
          list
      }
    );
  }
);

// ======================================================
// تأكيد الدفع
// ======================================================

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
      return res.status(
        404
      ).json(
        {
          ok: false,
          error:
            "Order not found"
        }
      );
    }

    if (
      order.status !==
      "PAYMENT_PENDING"
    ) {
      return res.status(
        409
      ).json(
        {
          ok: false,

          error:
            `Order cannot be confirmed from status ${order.status}`
        }
      );
    }

    const transactionId =
      String(
        req.body
          ?.transactionId ||
        ""
      ).trim();

    if (
      !transactionId
    ) {
      return res.status(
        400
      ).json(
        {
          ok: false,
          error:
            "transactionId is required"
        }
      );
    }

    order.payment
      .transactionId =
      transactionId;

    order.payment.status =
      "CONFIRMED";

    order.status =
      "PAYMENT_CONFIRMED";

    order.updatedAt =
      new Date()
        .toISOString();

    res.json(
      {
        ok: true,
        order
      }
    );
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
// بدء التشغيل
// ======================================================

loadCache();

app.listen(
  PORT,
  () => {
    console.log(
      `ABESHA STORE running on port ${PORT}`
    );

    console.log(
      `Pricing USD -> SDG: ${USD_TO_SDG}`
    );
  }
);
