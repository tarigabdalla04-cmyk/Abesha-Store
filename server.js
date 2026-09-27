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
// جلب فئات شحن الألعاب من Fazer
app.get("/api/fazer/topups", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const response = await fetch(
      `${FAZER_API}/topups?limit=50`,
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
// جلب عروض فئة معينة من Fazer
app.get("/api/fazer/topups/offers", async (req, res) => {
  try {
    if (!process.env.FAZER_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "FAZER_API_KEY is not configured"
      });
    }

    const { category_id } = req.query;

    if (!category_id) {
      return res.status(400).json({
        ok: false,
        error: "category_id is required"
      });
    }

    const response = await fetch(
      `${FAZER_API}/topups/offers?category_id=${encodeURIComponent(category_id)}`,
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
