const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const FAZER_API = 'https://api.fzr.cards/api/v2';
const DATA = __dirname;

const SETTINGS_FILE = path.join(DATA, 'store-settings.json');
const CACHE_FILE = path.join(DATA, 'pricing-cache.json');
const ORDERS_FILE = path.join(DATA, 'orders.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(DATA, 'public')));

// ======================================================
// ABESHA STORE — الإعدادات الافتراضية
// ======================================================

const DEFAULT_SETTINGS = {
  version: 2,

  catalogMode: 'all',

  publishedIds: [],

  hiddenIds: [],

  discounts: {},

  pricing: {
    usdToSdg: 8250,

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

// ======================================================
// أدوات الملفات
// ======================================================

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function saveJson(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    'utf8'
  );
}

// ======================================================
// تحميل إعدادات المتجر
// ======================================================

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      saveJson(
        SETTINGS_FILE,
        DEFAULT_SETTINGS
      );

      return clone(DEFAULT_SETTINGS);
    }

    const stored = JSON.parse(
      fs.readFileSync(
        SETTINGS_FILE,
        'utf8'
      )
    );

    const defaults = clone(
      DEFAULT_SETTINGS
    );

    const storedPricing =
      stored.pricing &&
      typeof stored.pricing === 'object'
        ? stored.pricing
        : {};

    const tiers =
      Array.isArray(storedPricing.tiers) &&
      storedPricing.tiers.length === 4
        ? storedPricing.tiers.map(
            (tier, index) => ({
              maxCost:
                tier.maxCost == null
                  ? null
                  : Number(tier.maxCost),

              markup:
                Number(tier.markup)
            })
          )
        : defaults.pricing.tiers;

    return {
      ...defaults,
      ...stored,

      publishedIds:
        Array.isArray(stored.publishedIds)
          ? stored.publishedIds
          : [],

      hiddenIds:
        Array.isArray(stored.hiddenIds)
          ? stored.hiddenIds
          : [],

      discounts:
        stored.discounts &&
        typeof stored.discounts === 'object'
          ? stored.discounts
          : {},

      pricing: {
        ...defaults.pricing,
        ...storedPricing,

        usdToSdg:
          Number(storedPricing.usdToSdg) > 0
            ? Number(storedPricing.usdToSdg)
            : defaults.pricing.usdToSdg,

        tiers:
          tiers.every(
            tier =>
              Number.isFinite(tier.markup)
          )
            ? tiers
            : defaults.pricing.tiers,

        rounding: {
          ...defaults.pricing.rounding,
          ...(storedPricing.rounding || {})
        }
      }
    };
  } catch (error) {
    console.warn(
      '[SETTINGS]',
      error.message
    );

    return clone(
      DEFAULT_SETTINGS
    );
  }
}

let settings = loadSettings();

function saveSettings() {
  saveJson(
    SETTINGS_FILE,
    settings
  );
}

// ======================================================
// نظام التسعير
// ======================================================

function pricing() {
  return settings.pricing;
}

function markup(costSdg) {
  const tier =
    pricing().tiers.find(
      item =>
        costSdg <=
        (
          item.maxCost == null
            ? Infinity
            : Number(item.maxCost)
        )
    );

  return tier
    ? Number(tier.markup)
    : 0.10;
}

function roundPrice(value) {
  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    return null;
  }

  const rounding =
    pricing().rounding;

  let step;

  if (value < 10000) {
    step =
      Number(rounding.under10000) ||
      100;
  } else if (value < 100000) {
    step =
      Number(
        rounding.from10000To100000
      ) || 500;
  } else if (value < 500000) {
    step =
      Number(
        rounding.from100000To500000
      ) || 1000;
  } else {
    step =
      Number(rounding.from500000) ||
      5000;
  }

  return (
    Math.ceil(value / step) *
    step
  );
}

function saleFromUsd(priceUsd) {
  const usd =
    Number(priceUsd);

  if (
    !Number.isFinite(usd) ||
    usd <= 0
  ) {
    return null;
  }

  const costSdg =
    usd *
    pricing().usdToSdg;

  const profitRate =
    markup(costSdg);

  return roundPrice(
    costSdg *
    (1 + profitRate)
  );
}

// ======================================================
// Fazer API
// ======================================================

function fazerHeaders(extra = {}) {
  return {
    'X-API-Key':
      process.env.FAZER_API_KEY,

    'Accept':
      'application/json',

    ...extra
  };
}

async function fazer(
  endpoint,
  options = {}
) {
  if (
    !process.env.FAZER_API_KEY
  ) {
    const error =
      new Error(
        'FAZER_API_KEY is not configured'
      );

    error.status = 500;

    throw error;
  }

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      options.timeoutMs || 30000
    );

  try {
    const response =
      await fetch(
        FAZER_API + endpoint,
        {
          ...options,

          headers:
            fazerHeaders(
              options.headers || {}
            ),

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

    if (!response.ok) {
      const error =
        new Error(
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
// قراءة Arrays من Fazer
// ======================================================

function arr(
  data,
  keys = [
    'items',
    'offers',
    'cards'
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

// ======================================================
// جلب كتالوج Fazer بالكامل
// ======================================================

async function categories(
  endpoint
) {
  const result = [];

  let cursor = null;

  for (
    let page = 0;
    page < 100;
    page++
  ) {
    const query =
      cursor
        ? `?cursor=${encodeURIComponent(cursor)}`
        : '';

    const data =
      await fazer(
        endpoint + query
      );

    result.push(
      ...arr(
        data,
        [
          'items',
          'categories',
          'games'
        ]
      )
    );

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
// استخراج سعر المورد بالدولار
// ======================================================

function priceUsd(offer) {
  const values = [
    offer?.price_usd,
    offer?.priceUSD,
    offer?.usd_price,
    offer?.cost_usd,
    offer?.costUSD,
    offer?.price
  ];

  for (
    const value of values
  ) {
    const number =
      Number(value);

    if (
      Number.isFinite(number) &&
      number > 0
    ) {
      return number;
    }
  }

  return null;
}

function label(offer) {
  return String(
    offer?.name ||
    offer?.title ||
    offer?.description ||
    offer?.product_name ||
    offer?.productName ||
    offer?.amount ||
    offer?.quantity ||
    offer?.denomination ||
    'عرض'
  ).trim();
}

function offerId(
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
// الخصومات
// ======================================================

function discountActive(
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

  if (
    discount.startsAt &&
    Date.parse(
      discount.startsAt
    ) > now
  ) {
    return false;
  }

  if (
    discount.endsAt &&
    Date.parse(
      discount.endsAt
    ) < now
  ) {
    return false;
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
    !discountActive(discount)
  ) {
    return {
      price: base,
      original: null,
      discount: null
    };
  }

  let result;

  if (
    discount.type === 'fixed'
  ) {
    result =
      base -
      Number(
        discount.value
      );
  } else {
    result =
      base *
      (
        1 -
        Number(
          discount.value
        ) / 100
      );
  }

  result =
    roundPrice(
      Math.max(
        100,
        result
      )
    );

  if (
    !result ||
    result >= base
  ) {
    return {
      price: base,
      original: null,
      discount: null
    };
  }

  return {
    price: result,
    original: base,
    discount
  };
}

// ======================================================
// ظهور المنتجات
// ======================================================

function visible(product) {
  const id =
    String(product.id);

  if (
    settings.hiddenIds.includes(
      id
    )
  ) {
    return false;
  }

  if (
    settings.catalogMode ===
    'curated'
  ) {
    return settings.publishedIds.includes(
      id
    );
  }

  return true;
}

// ======================================================
// المنتج الذي يخرج للعميل
// ======================================================

function publicProduct(
  product
) {
  const discount =
    settings.discounts[
      String(product.id)
    ];

  const calculated =
    applyDiscount(
      product.price_sdg,
      discount
    );

  return {
    ...product,

    price_sdg:
      calculated.price,

    original_price_sdg:
      calculated.original,

    discount:
      calculated.discount,

    price_usd:
      calculated.price
        ? calculated.price /
          pricing().usdToSdg
        : null,

    source_price_usd:
      undefined,

    cost_sdg:
      undefined,

    markup_percent:
      undefined,

    raw:
      undefined
  };
}

// ======================================================
// Cache
// ======================================================

let catalog = null;
let catalogAt = 0;
let building = null;

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
          'utf8'
        )
      );

    if (
      Array.isArray(
        data.products
      )
    ) {
      catalog =
        data.products;

      catalogAt =
        Number(
          data.builtAt
        ) || 0;
    }
  } catch (error) {
    console.warn(
      '[CACHE]',
      error.message
    );
  }
}

function saveCache() {
  try {
    saveJson(
      CACHE_FILE,
      {
        version: 4,

        builtAt:
          catalogAt,

        usdToSdg:
          pricing().usdToSdg,

        products:
          catalog
      }
    );
  } catch (error) {
    console.warn(
      '[CACHE SAVE]',
      error.message
    );
  }
}

function fresh() {
  return (
    Array.isArray(
      catalog
    ) &&
    catalog.length > 0 &&
    Date.now() -
      catalogAt <
      6 * 60 * 60 * 1000
  );
}

// ======================================================
// عروض العائلات
// ======================================================

async function familyOffers(
  type,
  list
) {
  const result = [];

  for (
    const category of list
  ) {
    const id =
      String(
        category.category_id ||
        category.game_id ||
        category.id ||
        ''
      );

    const name =
      String(
        category.name ||
        category.title ||
        id
      );

    try {
      let offers = [];

      if (
        type === 'topup'
      ) {
        offers =
          arr(
            await fazer(
              `/topups/offers?category_id=${encodeURIComponent(id)}`
            ),
            [
              'items',
              'offers'
            ]
          );
      }

      if (
        type === 'gift_card'
      ) {
        offers =
          arr(
            await fazer(
              `/giftcards/cards?category_id=${encodeURIComponent(id)}`
            ),
            [
              'items',
              'cards',
              'offers'
            ]
          );
      }

      if (
        type === 'game_key'
      ) {
        offers =
          arr(
            await fazer(
              `/gamekeys/keys?game_id=${encodeURIComponent(id)}`
            ),
            [
              'keys',
              'items',
              'offers'
            ]
          );
      }

      offers.forEach(
        (
          offer,
          index
        ) => {
          const usd =
            priceUsd(
              offer
            );

          const finalPrice =
            saleFromUsd(
              usd
            );

          result.push({
            id:
              `${id}__${type}__${offerId(
                offer,
                index
              )}`,

            category_id:
              id,

            name:
              label(offer) ===
              'عرض'
                ? name
                : `${name} — ${label(
                    offer
                  )}`,

            base_name:
              name,

            type,

            price_sdg:
              finalPrice,

            source_price_usd:
              usd,

            cost_sdg:
              usd
                ? Math.round(
                    usd *
                      pricing()
                        .usdToSdg
                  )
                : null,

            markup_percent:
              usd
                ? markup(
                    usd *
                      pricing()
                        .usdToSdg
                  ) * 100
                : null,

            fields:
              category.fields ||
              [],

            note:
              category.note ||
              '',

            platform:
              category.platform ||
              '',

            region:
              category.region ||
              '',

            stock:
              offer?.stock ??
              null,

            offer
          });
        }
      );
    } catch (error) {
      console.warn(
        type,
        id,
        error.message
      );
    }
  }

  return result;
}

// ======================================================
// بناء الكتالوج المسعّر
// ======================================================

async function buildCatalog() {
  const results =
    await Promise.allSettled(
      [
        categories(
          'topups'
        ),

        categories(
          'giftcards'
        ),

        categories(
          'gamekeys'
        )
      ]
    );

  const topups =
    results[0].status ===
    'fulfilled'
      ? results[0].value
      : [];

  const giftcards =
    results[1].status ===
    'fulfilled'
      ? results[1].value
      : [];

  const gamekeys =
    results[2].status ===
    'fulfilled'
      ? results[2].value
      : [];

  const [
    topupProducts,
    giftcardProducts,
    gamekeyProducts
  ] =
    await Promise.all([
      familyOffers(
        'topup',
        topups
      ),

      familyOffers(
        'gift_card',
        giftcards
      ),

      familyOffers(
        'game_key',
        gamekeys
      )
    ]);

  catalog = [
    ...topupProducts,
    ...giftcardProducts,
    ...gamekeyProducts
  ];

  catalogAt =
    Date.now();

  saveCache();

  return catalog;
}

async function getCatalog() {
  if (
    fresh()
  ) {
    return catalog;
  }

  if (
    building
  ) {
    return building;
  }

  building =
    buildCatalog()
      .catch(
        error => {
          if (
            catalog &&
            catalog.length
          ) {
            return catalog;
          }

          throw error;
        }
      )
      .finally(
        () => {
          building =
            null;
        }
      );

  return building;
}

loadCache();

// ======================================================
// Health
// ======================================================

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,

      service:
        'ABESHA STORE',

      status:
        'running',

      pricing: {
        usdToSdg:
          pricing()
            .usdToSdg,

        cacheFresh:
          fresh(),

        cachedProducts:
          catalog?.length ||
          0
      }
    });
  }
);

// ======================================================
// المنتجات العامة
// ======================================================

app.get(
  '/api/products',
  async (
    req,
    res
  ) => {
    try {
      const all =
        await getCatalog();

      const products =
        all
          .filter(
            visible
          )
          .filter(
            product =>
              Number(
                product.price_sdg
              ) > 0
          )
          .map(
            publicProduct
          );

      res.json({
        ok: true,

        total:
          products.length,

        products,

        pricing:
          pricing()
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

// ======================================================
// تحديث الأسعار
// ======================================================

app.post(
  '/api/prices/refresh',
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      catalog = null;
      catalogAt = 0;

      const products =
        await getCatalog();

      res.json({
        ok: true,

        total:
          products.length,

        refreshedAt:
          new Date()
            .toISOString()
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

// ======================================================
// Fazer — /me
// ======================================================

app.get(
  '/api/fazer/me',
  async (
    req,
    res
  ) => {
    try {
      res.json(
        await fazer(
          '/me'
        )
      );
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
        ok: false,
        error:
          error.message,

        details:
          error.data ||
          null
      });
    }
  }
);

// ======================================================
// Fazer — Catalog
// ======================================================

app.get(
  '/api/fazer/catalog',
  async (
    req,
    res
  ) => {
    try {
      const results =
        await Promise.allSettled(
          [
            categories(
              'topups'
            ),

            categories(
              'giftcards'
            ),

            categories(
              'gamekeys'
            )
          ]
        );

      const topups =
        results[0].status ===
        'fulfilled'
          ? results[0].value
          : [];

      const giftcards =
        results[1].status ===
        'fulfilled'
          ? results[1].value
          : [];

      const gamekeys =
        results[2].status ===
        'fulfilled'
          ? results[2].value
          : [];

      res.json({
        ok: true,

        families: {
          topups: {
            ok:
              results[0].status ===
              'fulfilled',

            items:
              topups
          },

          giftcards: {
            ok:
              results[1].status ===
              'fulfilled',

            items:
              giftcards
          },

          gamekeys: {
            ok:
              results[2].status ===
              'fulfilled',

            items:
              gamekeys
          }
        },

        total:
          topups.length +
          giftcards.length +
          gamekeys.length
      });
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ======================================================
// Fazer — Topups
// ======================================================

app.get(
  '/api/fazer/topups',
  async (
    req,
    res
  ) => {
    try {
      const items =
        await categories(
          'topups'
        );

      res.json({
        ok: true,
        kind:
          'topup',
        items
      });
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  '/api/fazer/topups/offers',
  async (
    req,
    res
  ) => {
    try {
      if (
        !req.query.category_id
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              'category_id is required'
          });
      }

      res.json(
        await fazer(
          `/topups/offers?category_id=${encodeURIComponent(
            req.query.category_id
          )}`
        )
      );
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
        ok: false,
        error:
          error.message,

        details:
          error.data ||
          null
      });
    }
  }
);

// ======================================================
// Fazer — Validate ID
// ======================================================

app.post(
  '/api/fazer/topups/validate-id',
  async (
    req,
    res
  ) => {
    try {
      res.json(
        await fazer(
          '/topups/validate-id',
          {
            method:
              'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({
                category_id:
                  req.body
                    .category_id,

                fields:
                  req.body
                    .fields
              })
          }
        )
      );
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
        ok: false,
        error:
          error.message,

        details:
          error.data ||
          null
      });
    }
  }
);

// ======================================================
// Fazer — Gift Cards
// ======================================================

app.get(
  '/api/fazer/giftcards',
  async (
    req,
    res
  ) => {
    try {
      const items =
        await categories(
          'giftcards'
        );

      res.json({
        ok: true,
        kind:
          'gift_card',
        items
      });
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  '/api/fazer/giftcards/cards',
  async (
    req,
    res
  ) => {
    try {
      if (
        !req.query.category_id
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              'category_id is required'
          });
      }

      res.json(
        await fazer(
          `/giftcards/cards?category_id=${encodeURIComponent(
            req.query.category_id
          )}`
        )
      );
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ======================================================
// Fazer — Game Keys
// ======================================================

app.get(
  '/api/fazer/gamekeys',
  async (
    req,
    res
  ) => {
    try {
      const items =
        await categories(
          'gamekeys'
        );

      res.json({
        ok: true,
        kind:
          'game_key',
        items
      });
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

// ======================================================
// Fazer — Steam
// ======================================================

app.get(
  '/api/fazer/steam-topup/rates',
  async (
    req,
    res
  ) => {
    try {
      res.json(
        await fazer(
          '/steam-topup/rates'
        )
      );
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

app.get(
  '/api/fazer/steam-gifts/games',
  async (
    req,
    res
  ) => {
    try {
      const limit =
        req.query.limit ||
        100;

      res.json(
        await fazer(
          `/steam-gifts/games?limit=${encodeURIComponent(
            limit
          )}`
        )
      );
    } catch (error) {
      res.status(
        error.status ||
        500
      ).json({
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

function requireAdmin(
  req,
  res,
  next
) {
  const key =
    req.headers[
      'x-admin-key'
    ];

  if (
    !process.env.ADMIN_KEY
  ) {
    return res
      .status(500)
      .json({
        ok: false,
        error:
          'ADMIN_KEY is not configured'
      });
  }

  if (
    key !==
    process.env.ADMIN_KEY
  ) {
    return res
      .status(401)
      .json({
        ok: false,
        error:
          'Unauthorized'
      });
  }

  next();
}

app.get(
  '/api/admin/status',
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

// ======================================================
// إعدادات الإدارة
// ======================================================

app.get(
  '/api/admin/settings',
  requireAdmin,
  (req, res) => {
    res.json({
      ok: true,

      settings,

      pricing:
        pricing()
    });
  }
);

// ======================================================
// تغيير سعر الصرف ونسب الربح من الواجهة
// ======================================================

app.put(
  '/api/admin/pricing',
  requireAdmin,
  (req, res) => {
    const body =
      req.body || {};

    const usd =
      Number(
        body.usdToSdg
      );

    if (
      !Number.isFinite(usd) ||
      usd <= 0
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            'usdToSdg must be a positive number'
        });
    }

    const old =
      pricing();

    const tiers =
      Array.isArray(
        body.tiers
      ) &&
      body.tiers.length === 4
        ? body.tiers
        : old.tiers;

    const normalized =
      tiers.map(
        (
          tier,
          index
        ) => ({
          maxCost:
            index === 3
              ? null
              : Number(
                  tier.maxCost
                ),

          markup:
            Number(
              tier.markup
            )
        })
      );

    if (
      normalized.some(
        tier =>
          !Number.isFinite(
            tier.markup
          ) ||
          tier.markup < 0 ||
          tier.markup > 1
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            'Invalid markup tiers'
        });
    }

    settings.pricing = {
      usdToSdg:
        usd,

      tiers:
        normalized,

      rounding: {
        ...old.rounding,

        ...(body.rounding ||
          {})
      }
    };

    saveSettings();

    // إجبار إعادة التسعير
    catalog = null;
    catalogAt = 0;

    res.json({
      ok: true,

      pricing:
        pricing(),

      message:
        'Pricing updated; catalog will be repriced automatically.'
    });
  }
);

// ======================================================
// إعادة بناء الكتالوج بعد تغيير السعر
// ======================================================

app.post(
  '/api/admin/pricing/refresh',
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      catalog = null;
      catalogAt = 0;

      const products =
        await getCatalog();

      res.json({
        ok: true,

        total:
          products.length,

        pricing:
          pricing()
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

// ======================================================
// كتالوج الإدارة
// ======================================================

app.get(
  '/api/admin/catalog',
  requireAdmin,
  async (
    req,
    res
  ) => {
    try {
      const all =
        await getCatalog();

      res.json({
        ok: true,

        total:
          all.length,

        products:
          all.map(
            product => ({
              ...product,

              published:
                visible(
                  product
                ),

              discount:
                settings.discounts[
                  String(
                    product.id
                  )
                ] || null
            })
          ),

        settings,

        pricing:
          pricing()
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

// ======================================================
// وضع الكتالوج
// ======================================================

app.post(
  '/api/admin/catalog/mode',
  requireAdmin,
  (
    req,
    res
  ) => {
    const mode =
      String(
        req.body.mode ||
        ''
      );

    if (
      ![
        'all',
        'curated'
      ].includes(mode)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            'mode must be all or curated'
        });
    }

    settings.catalogMode =
      mode;

    saveSettings();

    res.json({
      ok: true,

      catalogMode:
        mode
    });
  }
);

// ======================================================
// نشر منتج
// ======================================================

app.post(
  '/api/admin/catalog/publish',
  requireAdmin,
  (
    req,
    res
  ) => {
    const id =
      String(
        req.body.productId ||
        ''
      );

    if (!id) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            'productId is required'
        });
    }

    settings.hiddenIds =
      settings.hiddenIds.filter(
        item =>
          item !== id
      );

    if (
      !settings.publishedIds.includes(
        id
      )
    ) {
      settings.publishedIds.push(
        id
      );
    }

    saveSettings();

    res.json({
      ok: true,

      productId:
        id,

      published:
        true
    });
  }
);

// ======================================================
// إخفاء منتج
// ======================================================

app.post(
  '/api/admin/catalog/unpublish',
  requireAdmin,
  (
    req,
    res
  ) => {
    const id =
      String(
        req.body.productId ||
        ''
      );

    if (!id) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            'productId is required'
        });
    }

    settings.publishedIds =
      settings.publishedIds.filter(
        item =>
          item !== id
      );

    if (
      !settings.hiddenIds.includes(
        id
      )
    ) {
      settings.hiddenIds.push(
        id
      );
    }

    saveSettings();

    res.json({
      ok: true,

      productId:
        id,

      published:
        false
    });
  }
);

// ======================================================
// الخصومات
// ======================================================

app.post(
  '/api/admin/catalog/discount',
  requireAdmin,
  (
    req,
    res
  ) => {
    const id =
      String(
        req.body.productId ||
        ''
      );

    const discount =
      req.body.discount ||
      {};

    const type =
      discount.type ===
      'fixed'
        ? 'fixed'
        : 'percent';

    const value =
      Number(
        discount.value
      );

    if (
      !id ||
      !Number.isFinite(
        value
      ) ||
      value <= 0 ||
      (
        type === 'percent' &&
        value >= 100
      )
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            'Invalid discount'
        });
    }

    settings.discounts[id] = {
      type,

      value,

      label:
        String(
          discount.label ||
          'عرض خاص'
        ).slice(
          0,
          100
        ),

      active:
        discount.active !==
        false,

      startsAt:
        discount.startsAt ||
        null,

      endsAt:
        discount.endsAt ||
        null
    };

    saveSettings();

    res.json({
      ok: true,

      productId:
        id,

      discount:
        settings.discounts[id]
    });
  }
);

app.delete(
  '/api/admin/catalog/discount/:id',
  requireAdmin,
  (
    req,
    res
  ) => {
    delete settings
      .discounts[
        String(
          req.params.id
        )
      ];

    saveSettings();

    res.json({
      ok: true
    });
  }
);

// ======================================================
// الطلبات
// ======================================================

const ORDERS =
  new Map();

try {
  if (
    fs.existsSync(
      ORDERS_FILE
    )
  ) {
    const storedOrders =
      JSON.parse(
        fs.readFileSync(
          ORDERS_FILE,
          'utf8'
        )
      );

    if (
      Array.isArray(
        storedOrders
      )
    ) {
      for (
        const order of
        storedOrders
      ) {
        if (
          order?.orderNumber
        ) {
          ORDERS.set(
            order.orderNumber,
            order
          );
        }
      }
    }
  }
} catch (error) {
  console.warn(
    '[ORDERS]',
    error.message
  );
}

function saveOrders() {
  saveJson(
    ORDERS_FILE,
    [
      ...ORDERS.values()
    ]
  );
}

function customerKey(
  customer = {}
) {
  const value =
    String(
      customer.phone ||
      customer.email ||
      ''
    )
      .trim()
      .toLowerCase();

  if (!value) {
    return null;
  }

  return crypto
    .createHash(
      'sha256'
    )
    .update(value)
    .digest('hex')
    .slice(0, 24);
}

function orderNumber() {
  return (
    `AB-${Date.now().toString(36).toUpperCase()}-` +
    `${crypto.randomBytes(2).toString('hex').toUpperCase()}`
  );
}

// ======================================================
// إنشاء الطلب
// ======================================================

app.post(
  '/api/orders',
  async (
    req,
    res
  ) => {
    try {
      const body =
        req.body || {};

      if (
        !body.customer ||
        !Array.isArray(
          body.items
        ) ||
        !body.items.length ||
        !body.paymentMethod
      ) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              'customer, items and paymentMethod are required'
          });
      }

      const all =
        await getCatalog();

      const productMap =
        new Map(
          all.map(
            product => [
              String(
                product.id
              ),
              product
            ]
          )
        );

      const items = [];

      for (
        const requestedItem
        of body.items
      ) {
        const product =
          productMap.get(
            String(
              requestedItem.productId
            )
          );

        const quantity =
          Math.max(
            1,
            Math.floor(
              Number(
                requestedItem.quantity
              ) || 1
            )
          );

        if (
          !product ||
          !visible(product) ||
          Number(
            product.price_sdg
          ) <= 0
        ) {
          continue;
        }

        const publicVersion =
          publicProduct(
            product
          );

        items.push({
          productId:
            publicVersion.id,

          name:
            publicVersion.name,

          quantity,

          price:
            Number(
              publicVersion.price_sdg
            ),

          fields:
            requestedItem.fields ||
            {}
        });
      }

      if (!items.length) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              'No valid products'
          });
      }

      // السعر النهائي يحسب هنا من الكتالوج
      const total =
        items.reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.price *
              item.quantity,
          0
        );

      const number =
        orderNumber();

      const now =
        new Date()
          .toISOString();

      const order = {
        orderNumber:
          number,

        customer: {
          name:
            String(
              body.customer.name ||
              ''
            ).trim(),

          phone:
            String(
              body.customer.phone ||
              ''
            ).trim(),

          email:
            String(
              body.customer.email ||
              ''
            ).trim()
        },

        customerKey:
          customerKey(
            body.customer
          ),

        items,

        payment: {
          method:
            String(
              body.paymentMethod
            ),

          status:
            'PENDING',

          transactionId:
            null
        },

        total,

        status:
          'PAYMENT_PENDING',

        createdAt:
          now,

        updatedAt:
          now
      };

      ORDERS.set(
        number,
        order
      );

      saveOrders();

      res
        .status(201)
        .json({
          ok: true,

          order: {
            orderNumber:
              number,

            status:
              order.status,

            total,

            createdAt:
              now
          }
        });
    } catch (error) {
      console.error(
        '[CREATE ORDER]',
        error
      );

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
// طلب واحد
// ======================================================

app.get(
  '/api/orders/:number',
  (
    req,
    res
  ) => {
    const order =
      ORDERS.get(
        req.params.number
      );

    if (!order) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            'Order not found'
        });
    }

    res.json({
      ok: true,
      order
    });
  }
);

// ======================================================
// سجل العميل
// ======================================================

app.get(
  '/api/customer/orders',
  (
    req,
    res
  ) => {
    const key =
      customerKey({
        phone:
          req.query.phone,

        email:
          req.query.email
      });

    if (!key) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            'phone or email is required'
        });
    }

    const orders =
      [
        ...ORDERS.values()
      ]
        .filter(
          order =>
            order.customerKey ===
            key
        )
        .sort(
          (
            a,
            b
          ) =>
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
        orders.length,

      orders
    });
  }
);

// ======================================================
// إعادة الطلب
// ======================================================

app.post(
  '/api/customer/reorder',
  async (
    req,
    res
  ) => {
    try {
      const order =
        ORDERS.get(
          String(
            req.body?.orderNumber ||
            ''
          )
        );

      if (!order) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              'Order not found'
          });
      }

      const all =
        await getCatalog();

      const map =
        new Map(
          all.map(
            product => [
              String(
                product.id
              ),
              product
            ]
          )
        );

      const items = [];

      for (
        const oldItem
        of order.items
      ) {
        const product =
          map.get(
            String(
              oldItem.productId
            )
          );

        if (
          !product ||
          !visible(product) ||
          Number(
            product.price_sdg
          ) <= 0
        ) {
          continue;
        }

        const publicVersion =
          publicProduct(
            product
          );

        items.push({
          productId:
            publicVersion.id,

          name:
            publicVersion.name,

          quantity:
            Math.max(
              1,
              Number(
                oldItem.quantity
              ) || 1
            ),

          price:
            publicVersion.price_sdg,

          fields:
            oldItem.fields ||
            {}
        });
      }

      const total =
        items.reduce(
          (
            sum,
            item
          ) =>
            sum +
            item.price *
              item.quantity,
          0
        );

      res.json({
        ok: true,

        sourceOrderNumber:
          order.orderNumber,

        items,

        total
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

// ======================================================
// إدارة الطلبات
// ======================================================

app.get(
  '/api/admin/orders',
  requireAdmin,
  (
    req,
    res
  ) => {
    const orders =
      [
        ...ORDERS.values()
      ].sort(
        (
          a,
          b
        ) =>
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
        orders.length,

      orders
    });
  }
);

// ======================================================
// تأكيد الدفع
// ======================================================

app.post(
  '/api/admin/orders/:number/confirm-payment',
  requireAdmin,
  (
    req,
    res
  ) => {
    const order =
      ORDERS.get(
        req.params.number
      );

    if (!order) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            'Order not found'
        });
    }

    const transactionId =
      String(
        req.body?.transactionId ||
        ''
      ).trim();

    if (!transactionId) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            'transactionId is required'
        });
    }

    order.payment.transactionId =
      transactionId;

    order.payment.status =
      'CONFIRMED';

    order.status =
      'PAYMENT_CONFIRMED';

    order.updatedAt =
      new Date()
        .toISOString();

    ORDERS.set(
      order.orderNumber,
      order
    );

    saveOrders();

    res.json({
      ok: true,
      order
    });
  }
);

// ======================================================
// توافق مع المسارات القديمة
// ======================================================

app.get(
  '/api/catalog',
  async (
    req,
    res
  ) => {
    try {
      const products =
        await getCatalog();

      res.json({
        ok: true,

        total:
          products.length,

        products:
          products.map(
            product => ({
              id:
                product.id,

              name:
                product.name,

              type:
                product.type,

              note:
                product.note,

              fields:
                product.fields,

              price_sdg:
                product.price_sdg
            })
          )
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
  '/api/catalog/published',
  async (
    req,
    res
  ) => {
    try {
      const products =
        (
          await getCatalog()
        )
          .filter(
            visible
          )
          .map(
            publicProduct
          );

      res.json({
        ok: true,

        total:
          products.length,

        published:
          products,

        pricing:
          pricing()
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

// ======================================================
// لوحة الإدارة
// ======================================================

app.get(
  '/admin',
  (
    req,
    res
  ) => {
    res.type('html').send(`
<!doctype html>
<html lang="ar" dir="rtl">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
ABESHA STORE — الإدارة
</title>

<style>

body{
  font-family:Arial,sans-serif;
  background:#071426;
  color:#fff;
  padding:18px;
  max-width:1000px;
  margin:auto;
}

input,
button{
  padding:10px;
  margin:5px;
  border-radius:8px;
  border:1px solid #31577f;
  background:#0b1f3a;
  color:#fff;
}

button{
  cursor:pointer;
}

.box{
  border:1px solid #1d416e;
  border-radius:12px;
  padding:15px;
  margin:12px 0;
}

.grid{
  display:grid;
  grid-template-columns:
    repeat(
      auto-fit,
      minmax(180px,1fr)
    );
}

</style>

</head>

<body>

<h1>
ABESHA STORE — لوحة الإدارة
</h1>

<div class="box">

<input
  id="key"
  type="password"
  placeholder="ADMIN_KEY"
>

<button
  onclick="load()"
>
تحميل
</button>

</div>

<div class="box">

<h3>
إعدادات التسعير
</h3>

<div class="grid">

<label>
سعر الدولار SDG

<input
  id="usd"
  type="number"
>

</label>

<label>
حتى 20,000 %

<input
  id="t1"
  type="number"
  step="0.1"
>

</label>

<label>
حتى 100,000 %

<input
  id="t2"
  type="number"
  step="0.1"
>

</label>

<label>
حتى 300,000 %

<input
  id="t3"
  type="number"
  step="0.1"
>

</label>

<label>
أكثر من 300,000 %

<input
  id="t4"
  type="number"
  step="0.1"
>

</label>

</div>

<button
  onclick="save()"
>
حفظ وإعادة التسعير
</button>

<p id="m"></p>

</div>

<div class="box">

<b>
إجمالي الكتالوج:
</b>

<span id="count">
—
</span>

</div>

<script>

let key = '';

function headers(){

  return {
    'Content-Type':
      'application/json',

    'x-admin-key':
      key
  };

}

async function api(
  url,
  options={}
){

  const response =
    await fetch(
      url,
      {
        ...options,

        headers:{
          ...headers(),
          ...(options.headers || {})
        }
      }
    );

  const data =
    await response
      .json()
      .catch(
        () => ({})
      );

  if(
    !response.ok
  ){

    throw new Error(
      data.error ||
      'حدث خطأ'
    );

  }

  return data;

}

async function load(){

  key =
    document
      .getElementById(
        'key'
      )
      .value
      .trim();

  if(!key){

    document
      .getElementById(
        'm'
      )
      .textContent =
        'أدخل ADMIN_KEY';

    return;

  }

  try{

    const data =
      await api(
        '/api/admin/settings'
      );

    const p =
      data.pricing;

    document
      .getElementById(
        'usd'
      )
      .value =
        p.usdToSdg;

    document
      .getElementById(
        't1'
      )
      .value =
        p.tiers[0].markup *
        100;

    document
      .getElementById(
        't2'
      )
      .value =
        p.tiers[1].markup *
        100;

    document
      .getElementById(
        't3'
      )
      .value =
        p.tiers[2].markup *
        100;

    document
      .getElementById(
        't4'
      )
      .value =
        p.tiers[3].markup *
        100;

    const catalog =
      await api(
        '/api/admin/catalog'
      );

    document
      .getElementById(
        'count'
      )
      .textContent =
        catalog.total;

    document
      .getElementById(
        'm'
      )
      .textContent =
        'تم تحميل الإعدادات والكتالوج';

  }catch(error){

    document
      .getElementById(
        'm'
      )
      .textContent =
        error.message;

  }

}

async function save(){

  try{

    const body = {

      usdToSdg:
        Number(
          document
            .getElementById(
              'usd'
            )
            .value
        ),

      tiers:[
        {
          maxCost:
            20000,

          markup:
            Number(
              document
                .getElementById(
                  't1'
                )
                .value
            ) / 100
        },

        {
          maxCost:
            100000,

          markup:
            Number(
              document
                .getElementById(
                  't2'
                )
                .value
            ) / 100
        },

        {
          maxCost:
            300000,

          markup:
            Number(
              document
                .getElementById(
                  't3'
                )
                .value
            ) / 100
        },

        {
          maxCost:
            null,

          markup:
            Number(
              document
                .getElementById(
                  't4'
                )
                .value
            ) / 100
        }
      ]

    };

    const data =
      await api(
        '/api/admin/pricing',
        {
          method:
            'PUT',

          body:
            JSON.stringify(
              body
            )
        }
      );

    document
      .getElementById(
        'm'
      )
      .textContent =
        'تم الحفظ وإعادة التسعير. سعر الدولار الآن: ' +
        data.pricing.usdToSdg;

  }catch(error){

    document
      .getElementById(
        'm'
      )
      .textContent =
        error.message;

  }

}

</script>

</body>

</html>
`);
  }
);

// ======================================================
// الصفحة الرئيسية
// ======================================================

app.get(
  '/',
  (
    req,
    res
  ) => {
    res.sendFile(
      path.join(
        DATA,
        'public',
        'index.html'
      )
    );
  }
);

// ======================================================
// تشغيل السيرفر
// ======================================================

app.listen(
  PORT,
  () => {

    console.log(
      `ABESHA STORE running on port ${PORT}`
    );

    console.log(
      `Pricing USD → SDG: ${
        pricing().usdToSdg
      }`
    );

  }
);
