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
app.listen(PORT, () => {
  console.log(`ABESHA STORE running on port ${PORT}`);
});
