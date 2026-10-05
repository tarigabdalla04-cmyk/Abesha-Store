const express = require('express');
const fetch = require('node-fetch');
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

// مسار فحص الصحة المخصص لـ Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// تخزين الكتالوج في الذاكرة (Cache)
let catalogCache = [];
let lastFetchTime = 0;
const CACHE_DURATION = 15 * 60 * 1000; // 15 دقيقة

// دالة لجلب كافة المنتجات (جميع الصفحات) من Fazer
async function fetchAllFazerProducts() {
  const apiKey = process.env.FAZER_API_KEY;
  if (!apiKey) return [];

  let allProducts = [];
  let page = 1;
  let hasMore = true;

  try {
    while (hasMore && page <= 10) { // جلب حتى 10 صفحات (10,000+ منتج)
      const response = await fetch(`https://api.fazer.net/v1/products?page=${page}&limit=1000`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!response.ok) break;
      
      const data = await response.json();
      const items = data.products || data.data || (Array.isArray(data) ? data : []);
      
      if (items.length === 0) {
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

// مسار الحصول على المنتجات والتصنيفات للمتجر
app.get('/api/products', async (req, res) => {
  try {
    const now = Date.now();
    if (catalogCache.length === 0 || (now - lastFetchTime) > CACHE_DURATION) {
      console.log('[PRICE CACHE] Building complete catalog...');
      const rawProducts = await fetchAllFazerProducts();
      
      // معالجة وتسوية المنتجات والتصنيفات
      catalogCache = rawProducts.map(item => {
        let cat = (item.category || item.category_name || 'عام').trim();
        // توحيد مسميات الفئات مثل Steam
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
    res.json({ success: true, count: catalogCache.length, products: catalogCache });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// مسار تسجيل دخول الإدارة (إصلاح خطأ الاستجابة)
app.post('/api/admin/login', (req, res) => {
  const { key } = req.body;
  const adminKey = process.env.ADMIN_KEY;

  if (!adminKey) {
    return res.status(500).json({ success: false, message: 'مفتاح الإدارة غير مضبوط في السيرفر.' });
  }

  if (key === adminKey) {
    return res.json({ success: true, message: 'تم تسجيل الدخول بنجاح' });
  } else {
    return res.status(401).json({ success: false, message: 'مفتاح الإدارة غير صحيح' });
  }
});

app.listen(PORT, () => {
  console.log(`ABESHA STORE running on port ${PORT}`);
});
