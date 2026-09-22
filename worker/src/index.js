// cex-ebay-proxy: tiny Cloudflare Worker that holds the eBay credentials and returns
// clean price stats for a barcode (GTIN/ISBN/UPC) or a keyword search on eBay Australia.
//
//   GET /ebay/search?gtin=9780747532699
//   GET /ebay/search?q=Inception%20blu-ray&cat=movies
//   cat = books | movies | music | games | any      limit = 1..50 (default 40)
//   exclude = comma list of words; listings whose title contains any are dropped (e.g. guitar,bundle)
//
// Response: { query, count, returned, low, p25, median, p75, avg, currency, items:[{title,price,shipping,total,condition,url,image}], cached }

const MARKETPLACE = "EBAY_AU";
const COUNTRY = "AU";
const CATEGORY_IDS = { books: "267", movies: "11232", music: "11233", games: "139973" };
const ALLOWED_ORIGINS = [/^https:\/\/jamie671\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const CACHE_TTL = 3600;

let tokenCache = { token: null, expiry: 0 };

function corsHeaders(origin) {
  const ok = origin && ALLOWED_ORIGINS.some(rx => rx.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin : "https://jamie671.github.io",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });
}

async function getToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expiry - 120000) return tokenCache.token;
  const basic = btoa(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`);
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${basic}` },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope")
  });
  if (!res.ok) throw new Error(`eBay token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  tokenCache = { token: d.access_token, expiry: Date.now() + (d.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function median(arr) { return percentile(arr, 50); }
function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  const v = lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
  return Math.round(v * 100) / 100;
}

async function searchEbay(env, { gtin, q, cat, limit, exclude }) {
  const token = await getToken(env);
  const params = new URLSearchParams();
  if (gtin) params.set("gtin", gtin);
  else params.set("q", q);
  if (cat && CATEGORY_IDS[cat]) params.set("category_ids", CATEGORY_IDS[cat]);
  params.set("filter", `deliveryCountry:${COUNTRY},buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION}`);
  params.set("sort", "price");
  params.set("limit", String(limit));
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
      "X-EBAY-C-ENDUSERCTX": `contextualLocation=country%3D${COUNTRY}%2Czip%3D2000`,
      "Accept": "application/json"
    }
  });
  if (!res.ok) throw new Error(`eBay search error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const items = [];
  const excl = (exclude || []).map(w => w.toLowerCase());
  for (const it of (data.itemSummaries || [])) {
    const t = (it.title || "").toLowerCase();
    if (excl.length && excl.some(w => t.includes(w))) continue; // e.g. drop guitar/camera bundles for disc-only items
    const price = num(it.price?.value);
    if (price == null) continue;
    const shipOpt = (it.shippingOptions || [])[0] || {};
    let shipping = num(shipOpt.shippingCost?.value);
    const shippingKnown = shipping != null;
    if (!shippingKnown) shipping = 0;
    items.push({
      title: it.title,
      price,
      shipping,
      shippingKnown,
      total: Math.round((price + shipping) * 100) / 100,
      condition: it.condition || "",
      buying: (it.buyingOptions || []).join("|"),
      url: it.itemWebUrl,
      image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
      currency: it.price?.currency || "AUD"
    });
  }
  // Fixed-price listings are what a buyer can pay right now; auctions can start at $0.99 and distort "low".
  const fixed = items.filter(i => /FIXED_PRICE|BEST_OFFER/.test(i.buying));
  const basis = fixed.length >= 3 ? fixed : items;
  const totals = basis.map(i => i.total);
  return {
    query: gtin ? { gtin } : { q, cat: cat || "any", exclude: exclude || [] },
    count: data.total || items.length,
    returned: items.length,
    low: totals.length ? Math.min(...totals) : null,
    median: median(totals),
    p25: percentile(totals, 25),
    p75: percentile(totals, 75),
    avg: totals.length ? Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100 : null,
    currency: items[0]?.currency || "AUD",
    items: basis.slice(0, 50)
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "cex-ebay-proxy" }, 200, cors);
    if (url.pathname !== "/ebay/search") return json({ error: "Not found" }, 404, cors);
    if (!env.EBAY_APP_ID || !env.EBAY_CERT_ID) return json({ error: "Worker missing eBay secrets" }, 500, cors);

    const gtin = (url.searchParams.get("gtin") || "").replace(/\D/g, "");
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    const cat = (url.searchParams.get("cat") || "").toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "40", 10) || 40));
    const exclude = (url.searchParams.get("exclude") || "").split(",").map(w => w.trim()).filter(w => w.length >= 3).slice(0, 15);
    if (!gtin && q.length < 2) return json({ error: "Provide gtin or q" }, 400, cors);
    if (gtin && !(gtin.length >= 8 && gtin.length <= 14)) return json({ error: "gtin must be 8-14 digits" }, 400, cors);

    // Edge cache: same lookup within an hour is free and instant
    const cacheKey = new Request(`https://cache.local/v2/ebay/search?gtin=${gtin}&q=${encodeURIComponent(q.toLowerCase())}&cat=${cat}&limit=${limit}&ex=${encodeURIComponent(exclude.join(","))}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      return json({ ...body, cached: true }, 200, cors);
    }
    try {
      const result = await searchEbay(env, { gtin, q, cat, limit, exclude });
      const resp = json({ ...result, cached: false }, 200, { ...cors, "Cache-Control": `public, max-age=${CACHE_TTL}` });
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL}` } })));
      return resp;
    } catch (err) {
      return json({ error: String(err.message || err) }, 502, cors);
    }
  }
};
