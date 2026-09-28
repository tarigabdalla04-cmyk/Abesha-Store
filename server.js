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
        : []
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
app.listen(PORT, () => {
  console.log(`ABESHA STORE running on port ${PORT}`);
});
