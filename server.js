const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const FAZER_API = "https://api.fzr.cards/api/v2";

app.use(express.json());

// واجهة المتجر
app.use(express.static(path.join(__dirname, "public")));

// اختبار أن السيرفر يعمل
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ABESHA STORE",
    status: "running"
  });
});

// اختبار الاتصال بحساب Fazer
app.get("/api/fazer/me", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const response = await fetch(`${FAZER_API}/me`, {
      headers: {
        "X-API-Key": process.env.FAZER_API_KEY,
        "Accept": "application/json"
      }
    });

    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// جلب كتالوج Fazer
app.get("/api/fazer/catalog", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const response = await fetch(`${FAZER_API}/catalog`, {
      headers: {
        "X-API-Key": process.env.FAZER_API_KEY,
        "Accept": "application/json"
      }
    });

    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// صفحة افتراضية في حالة عدم وجود index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
// جلب جميع فئات شحن الألعاب من Fazer مع متابعة الصفحات
app.get("/api/fazer/topups", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    let allItems = [];
    let cursor = null;

    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        limit: "50"
      });

      if (cursor) {
        params.set("cursor", cursor);
      }

      const response = await fetch(
        `${FAZER_API}/topups?${params.toString()}`,
        {
          headers: {
            "X-API-Key": process.env.FAZER_API_KEY,
            "Accept": "application/json"
          }
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json(data);
      }

      if (Array.isArray(data.items)) {
        allItems.push(...data.items);
      }

      const nextCursor = data.meta?.next_cursor;

      if (!nextCursor || data.meta?.has_more === false) {
        break;
      }

      cursor = nextCursor;
    }

    res.json({
      ok: true,
      kind: "topup",
      items: allItems,
      meta: {
        total: allItems.length,
        limit: allItems.length,
        next_cursor: null,
        has_more: false
      }
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
 app.get("/api/fazer/topups/offers", async (req, res) => { 
   try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const response = await fetch(
            `${FAZER_API}/topups/offers?category_id=${encodeURIComponent(req.query.category_id)}`,
      {
        headers: {
          "X-API-Key": process.env.FAZER_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// جلب فئات بطاقات الهدايا من Fazer
app.get("/api/fazer/giftcards", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    let allItems = [];
    let cursor = null;

    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        limit: "50"
      });

      if (cursor) {
        params.set("cursor", cursor);
      }

      const response = await fetch(
        `${FAZER_API}/giftcards?${params.toString()}`,
        {
          headers: {
            "X-API-Key": process.env.FAZER_API_KEY,
            "Accept": "application/json"
          }
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json(data);
      }

      if (Array.isArray(data.items)) {
        allItems.push(...data.items);
      }

      const nextCursor = data.meta?.next_cursor;

      if (!nextCursor || data.meta?.has_more === false) {
        break;
      }

      cursor = nextCursor;
    }

    res.json({
      ok: true,
      kind: "gift_card",
      items: allItems,
      meta: {
        total: allItems.length,
        limit: allItems.length,
        next_cursor: null,
        has_more: false
      }
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// جلب عروض بطاقات الهدايا داخل فئة محددة
app.get("/api/fazer/giftcards/cards", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const categoryId = req.query.category_id;

    if (!categoryId) {
      return res.status(400).json({
        ok: false,
        error: "category_id is required"
      });
    }

    const response = await fetch(
      `${FAZER_API}/giftcards/cards?category_id=${encodeURIComponent(categoryId)}`,
      {
        headers: {
          "X-API-Key": process.env.FAZER_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// طبقة المنتجات الموحدة لـ ABESHA STORE
app.get("/api/products", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const headers = {
      "X-API-Key": process.env.FAZER_API_KEY,
      "Accept": "application/json"
    };

    // جلب جميع فئات شحن الألعاب
    async function getTopupCategories() {
      const items = [];
      let cursor = null;

      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({
          limit: "50"
        });

        if (cursor) {
          params.set("cursor", cursor);
        }

        const response = await fetch(
          `${FAZER_API}/topups?${params.toString()}`,
          { headers }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data?.message || data?.error || "Failed to load topups"
          );
        }

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

    // جلب جميع فئات بطاقات الهدايا
    async function getGiftCardCategories() {
      const items = [];
      let cursor = null;

      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({
          limit: "50"
        });

        if (cursor) {
          params.set("cursor", cursor);
        }

        const response = await fetch(
          `${FAZER_API}/giftcards?${params.toString()}`,
          { headers }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data?.message || data?.error || "Failed to load gift cards"
          );
        }

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

    const [topups, giftcards] = await Promise.all([
      getTopupCategories(),
      getGiftCardCategories()
    ]);

    const products = [
      ...topups.map(item => ({
        id: item.category_id,
        name: item.name,
        type: "topup",
        note: item.note || "",
        fields: item.fields || []
      })),

      ...giftcards.map(item => ({
        id: item.category_id,
        name: item.name,
        type: "gift_card",
        note: item.note || "",
        fields: item.fields || []
      }))
    ];

    res.json({
      ok: true,
      total: products.length,
      products
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// التحقق من PUBG Player ID عبر Fazer
app.post("/api/fazer/topups/validate-id", async (req, res) => {
  try {
    const { category_id, fields } = req.body;

    const response = await fetch(
      `${FAZER_API}/topups/validate-id`,
      {
        method: "POST",
        headers: {
          "X-API-Key": process.env.FAZER_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          category_id,
          fields
        })
      }
    );

    const data = await response.json();

    res.status(response.status).json(data);

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// جلب فئات Game Keys من Fazer
app.get("/api/fazer/gamekeys", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    let allItems = [];
    let cursor = null;

    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        limit: "50"
      });

      if (cursor) {
        params.set("cursor", cursor);
      }

      const response = await fetch(
        `${FAZER_API}/gamekeys?${params.toString()}`,
        {
          headers: {
            "X-API-Key": process.env.FAZER_API_KEY,
            "Accept": "application/json"
          }
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json(data);
      }

      if (Array.isArray(data.items)) {
        allItems.push(...data.items);
      }

      const nextCursor = data.meta?.next_cursor;

      if (!nextCursor || data.meta?.has_more === false) {
        break;
      }

      cursor = nextCursor;
    }

    res.json({
      ok: true,
      kind: "game_key",
      items: allItems,
      meta: {
        total: allItems.length,
        limit: allItems.length,
        next_cursor: null,
        has_more: false
      }
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// أسعار Steam Wallet من Fazer
app.get("/api/fazer/steam-topup/rates", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const response = await fetch(
      `${FAZER_API}/steam-topup/rates`,
      {
        headers: {
          "X-API-Key": process.env.FAZER_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    res.status(response.status).json(data);

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// جلب كتالوج Steam Gifts من Fazer
app.get("/api/fazer/steam-gifts/games", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const limit = req.query.limit || "100";

    const response = await fetch(
      `${FAZER_API}/steam-gifts/games?limit=${encodeURIComponent(limit)}`,
      {
        headers: {
          "X-API-Key": process.env.FAZER_API_KEY,
          "Accept": "application/json"
        }
      }
    );

    const data = await response.json();

    res.status(response.status).json(data);

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// الكتالوج الموحد لـ ABESHA STORE
app.get("/api/catalog", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const headers = {
      "X-API-Key": process.env.FAZER_API_KEY,
      "Accept": "application/json"
    };

    async function getAllCategories(endpoint) {
      const items = [];
      let cursor = null;

      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({
          limit: "50"
        });

        if (cursor) {
          params.set("cursor", cursor);
        }

        const response = await fetch(
          `${FAZER_API}/${endpoint}?${params.toString()}`,
          { headers }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data?.message ||
            data?.error ||
            `Failed to load ${endpoint}`
          );
        }

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

    const [topups, giftcards, gamekeys] = await Promise.all([
      getAllCategories("topups"),
      getAllCategories("giftcards"),
      getAllCategories("gamekeys")
    ]);

    const products = [
      ...topups.map(item => ({
        id: item.category_id,
        name: item.name,
        type: "topup",
        note: item.note || "",
        fields: item.fields || []
      })),

      ...giftcards.map(item => ({
        id: item.category_id,
        name: item.name,
        type: "gift_card",
        note: item.note || "",
        fields: item.fields || []
      })),

      ...gamekeys.map(item => ({
        id: item.game_id || item.category_id,
        name: item.name,
        type: "game_key",
        platform: item.platform || "",
        region: item.region || "",
        region_restriction: item.region_restriction || false
      }))
    ];

    res.json({
      ok: true,
      total: products.length,
      products
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// المنتجات المنشورة في ABESHA STORE
app.get("/api/catalog/published", (req, res) => {
  try {
    const fs = require("fs");

    const configPath = path.join(__dirname, "catalog-config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    res.json({
      ok: true,
      total: Array.isArray(config.published)
        ? config.published.length
        : 0,
      published: Array.isArray(config.published)
        ? config.published
        : [],
      pricing: config.pricing || {}
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// اختبار إعدادات لوحة الإدارة
app.get("/api/admin/status", (req, res) => {
  res.json({
    ok: true,
    adminKeyConfigured: Boolean(process.env.ADMIN_KEY)
  });
});
// حماية مسارات الإدارة
function requireAdmin(req, res, next) {
  const adminKey = req.headers["x-admin-key"];

  if (!process.env.ADMIN_KEY) {
    return res.status(500).json({
      ok: false,
      error: "ADMIN_KEY is not configured"
    });
  }

  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  next();
}

// كتالوج الإدارة المحمي
app.get("/api/admin/catalog", requireAdmin, async (req, res) => {
  try {
    const response = await fetch(
      `http://127.0.0.1:${PORT}/api/catalog`
    );

    const data = await response.json();

    res.status(response.status).json(data);

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
// ===============================
// نظام الطلبات الهجين - المرحلة الأولى
// ===============================

const orders = new Map();

function generateOrderNumber() {
  const part1 = Math.floor(100000 + Math.random() * 900000);
  const part2 = Math.floor(100000 + Math.random() * 900000);

  return `AB-${part1}-${part2}`;
}

// إنشاء طلب جديد
app.post("/api/orders", (req, res) => {
  try {
    const {
      customer,
      items,
      paymentMethod,
      total
    } = req.body;

    if (!customer || typeof customer !== "object") {
      return res.status(400).json({
        ok: false,
        error: "customer is required"
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "items are required"
      });
    }

    if (!paymentMethod) {
      return res.status(400).json({
        ok: false,
        error: "paymentMethod is required"
      });
    }

    const amount = Number(total);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid total"
      });
    }

    const orderNumber = generateOrderNumber();

    const order = {
      orderNumber,

      customer: {
        name: String(customer.name || "").trim(),
        phone: String(customer.phone || "").trim(),
        email: String(customer.email || "").trim()
      },

      items: items.map(item => ({
        productId: String(item.productId || ""),
        name: String(item.name || ""),
        quantity: item.quantity || "",
        price: Number(item.price) || 0,
        fields: item.fields || {}
      })),

      payment: {
        method: String(paymentMethod),
        status: "PENDING",
        transactionId: null
      },

      total: amount,

      status: "PAYMENT_PENDING",

      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    orders.set(orderNumber, order);

    console.log(
      `[ORDER CREATED] ${orderNumber} - ${amount} SDG - ${paymentMethod}`
    );

    res.status(201).json({
      ok: true,
      order: {
        orderNumber: order.orderNumber,
        status: order.status,
        total: order.total,
        paymentMethod: order.payment.method,
        createdAt: order.createdAt
      }
    });

  } catch (error) {
    console.error("Create order error:", error);

    res.status(500).json({
      ok: false,
      error: "Failed to create order"
    });
  }
});

// الاستعلام عن طلب
app.get("/api/orders/:orderNumber", (req, res) => {
  const order = orders.get(req.params.orderNumber);

  if (!order) {
    return res.status(404).json({
      ok: false,
      error: "Order not found"
    });
  }

  res.json({
    ok: true,
    order
  });
});

// جلب الطلبات للوحة الإدارة
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const list = Array.from(orders.values())
    .sort((a, b) => {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

  res.json({
    ok: true,
    total: list.length,
    orders: list
  });
});

// تأكيد الدفع يدويًا - للاستخدام الإداري فقط
app.post(
  "/api/admin/orders/:orderNumber/confirm-payment",
  requireAdmin,
  (req, res) => {

    const order = orders.get(req.params.orderNumber);

    if (!order) {
      return res.status(404).json({
        ok: false,
        error: "Order not found"
      });
    }

    if (order.status !== "PAYMENT_PENDING") {
      return res.status(409).json({
        ok: false,
        error: `Order cannot be confirmed from status ${order.status}`
      });
    }

    const transactionId =
      String(req.body?.transactionId || "").trim();

    if (!transactionId) {
      return res.status(400).json({
        ok: false,
        error: "transactionId is required"
      });
    }

    order.payment.transactionId = transactionId;
    order.payment.status = "CONFIRMED";

    order.status = "PAYMENT_CONFIRMED";
    order.updatedAt = new Date().toISOString();

    orders.set(order.orderNumber, order);

    console.log(
      `[PAYMENT CONFIRMED] ${order.orderNumber} - ${transactionId}`
    );

    res.json({
      ok: true,
      order
    });
  }
);
app.listen(PORT, () => {
  console.log(`ABESHA STORE running on port ${PORT}`);
});
