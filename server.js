const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// الاتصال بقاعدة البيانات
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect()
  .then(() => console.log('[DB] PostgreSQL ready'))
  .catch(err => console.error('[DB] Connection error:', err.message));

// مسار فحص الصحة - يجب أن يستجيب فوراً بدون أي تأخير
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ذاكرة تخزين مؤقتة للكتالوج
let catalogCache = [];
let lastFetchTime = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 دقيقة

// دالة جلب كل المنتجات من Fazer مع الترقيم الصفحي (Pagination)
async function fetchAllFazerProducts() {
  const apiKey = process.env.FAZER_API_KEY;
  if (!apiKey) return [];

  let allProducts = [];
  let page = 1;
  let hasMore = true;

  try {
    while (hasMore && page <= 15) {
      const response = await fetch(`https://api.fazer.net/v1/products?page=${page}&limit=1000`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!response.ok) break;

      const data = await response.json();
      const items = data.products || data.data || (Array.isArray(data) ? data : []);

      if (!items || items.length === 0) {
        hasMore = false;
      } else {
        allProducts = allProducts.concat(items);
        page++;
        if (items.length < 1000) hasMore = false;
      }
    }
  } catch (err) {
    console.error('[FAZER API ERROR]', err.message);
  }
  return allProducts;
}

// مسار جلب المنتجات للمتجر وللوحة الإدارة
app.get('/api/products', async (req, res) => {
  try {
    const now = Date.now();
    if (catalogCache.length === 0 || (now - lastFetchTime) > CACHE_DURATION) {
      console.log('[PRICE CACHE] Building complete catalog...');
      const rawProducts = await fetchAllFazerProducts();

      catalogCache = rawProducts.map(item => {
        let cat = (item.category || item.category_name || 'عام').trim();
        if (cat.toLowerCase().includes('steam')) cat = 'Steam';

        return {
          id: item.id || item.product_id,
          name: item.name || item.title,
          category: cat,
          price: item.price,
          image: item.image || item.icon || ''
        };
      });
      lastFetchTime = now;
    }
    res.json({ ok: true, success: true, count: catalogCache.length, products: catalogCache });
  } catch (err) {
    res.status(500).json({ ok: false, success: false, error: err.message });
  }
});

// مسار تسجيل دخول الإدارة المصلح
app.post('/api/admin/login', (req, res) => {
  const keyInput = req.body.adminKey || req.body.key;
  const envAdminKey = process.env.ADMIN_KEY;

  if (!envAdminKey) {
    return res.status(500).json({ ok: false, error: 'مفتاح الإدارة غير مضبوط في السيرفر.' });
  }

  if (keyInput === envAdminKey) {
    return res.json({ ok: true, message: 'تم تسجيل الدخول بنجاح' });
  } else {
    return res.status(401).json({ ok: false, error: 'مفتاح الإدارة غير صحيح' });
  }
});

app.listen(PORT, () => {
  console.log(`ABESHA STORE running on port ${PORT}`);
});
