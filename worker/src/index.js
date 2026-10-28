// cex-ebay-proxy: tiny Cloudflare Worker that holds the eBay credentials and returns
// clean price stats for a barcode (GTIN/ISBN/UPC) or a keyword search on eBay Australia.
//
//   GET /ebay/search?gtin=9780747532699
//   GET /ebay/search?q=Inception%20blu-ray&cat=movies
//   cat = books | movies | music | games | boardgames | any      limit = 1..50 (default 40)
//   sort = price (default, cheapest first) | match (eBay best match)
//   exclude = comma list of words; listings whose title contains any are dropped (e.g. guitar,bundle)
//
// Response: { query, basis: "au_used"|"all", localCount?, count, returned, low, p25, median, p75, avg, currency,
//             items:[{title,price,shipping,total,condition,location,url,image}], cached }
// basis "au_used" = Australian-located used listings (preferred); "all" = fallback to everything delivered to AU.

const MARKETPLACE = "EBAY_AU";
const COUNTRY = "AU";
// boardgames = eBay "Games" (233): covers contemporary (180349) and vintage (19100) board games
const CATEGORY_IDS = { books: "267", movies: "11232", music: "11233", games: "139973", boardgames: "233" };
const ALLOWED_ORIGINS = [/^https:\/\/jamie671\.github\.io$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const CACHE_TTL = 3600;

let tokenCache = { token: null, expiry: 0 };

// Rate-limit key: IPv4 as is, IPv6 by its /64 (with '::' expanded first, so "2001:db8::1" and "2001:db8::2" match).
function ipKey(ip) {
  if (!ip.includes(":")) return ip;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  const [head, tail] = ip.toLowerCase().split("::");
  const a = head ? head.split(":") : [];
  const b = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function corsHeaders(origin) {
  const ok = origin && ALLOWED_ORIGINS.some(rx => rx.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin : "https://jamie671.github.io",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "Retry-After",
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
  if (!res.ok) throw new Error(`eBay token error ${res.status}: ${(await res.text()).slice(0, 300)}`);
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

// Minimum listings before we trust the "Australian sellers, used condition" pool on its own
const MIN_LOCAL = 5;

async function searchEbay(env, args) {
  // 1st choice: listings located in Australia, used condition. Overseas sellers add postage to AU and
  // new/sealed copies sit higher, both of which inflate what a charity-shop find will actually fetch.
  const local = await searchEbayOnce(env, { ...args, localUsed: true });
  if (local.returned >= MIN_LOCAL) return { ...local, basis: "au_used" };
  const all = await searchEbayOnce(env, { ...args, localUsed: false });
  return { ...all, basis: "all", localCount: local.returned };
}

async function searchEbayOnce(env, { gtin, q, cat, limit, exclude, localUsed, sort }) {
  const token = await getToken(env);
  const params = new URLSearchParams();
  if (gtin) params.set("gtin", gtin);
  else params.set("q", q);
  if (cat && CATEGORY_IDS[cat]) params.set("category_ids", CATEGORY_IDS[cat]);
  const filters = [`deliveryCountry:${COUNTRY}`, "buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION}"];
  if (localUsed) filters.push(`itemLocationCountry:${COUNTRY}`, "conditions:{USED}");
  params.set("filter", filters.join(","));
  // sort "price" (default) = cheapest first; "match" = eBay's best match, which keeps loose parts and
  // single cards (the cheapest board game listings) from dominating the sample
  if (sort !== "match") params.set("sort", "price");
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
      location: it.itemLocation?.country || "",
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
    if (!env.EBAY_APP_ID || !env.EBAY_CERT_ID) {
      console.error("EBAY_APP_ID / EBAY_CERT_ID secrets are not set");
      return json({ error: "Service unavailable" }, 503, cors);
    }
    // Per-IP cap on eBay lookups (SEARCH_LIMIT ratelimit binding in wrangler.jsonc). It protects the eBay app's
    // daily Browse API quota, so a missing binding is a setup mistake: refuse rather than run uncapped.
    if (!env.SEARCH_LIMIT) {
      console.error("SEARCH_LIMIT rate-limit binding is missing");
      return json({ error: "Service unavailable" }, 503, cors);
    }

    const gtin = (url.searchParams.get("gtin") || "").replace(/\D/g, "");
    const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
    const cat = (url.searchParams.get("cat") || "").toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "40", 10) || 40));
    const sort = url.searchParams.get("sort") === "match" ? "match" : "price";
    const exclude = (url.searchParams.get("exclude") || "").split(",").map(w => w.trim()).filter(w => w.length >= 3).slice(0, 40);
    if (!gtin && q.length < 2) return json({ error: "Provide gtin or q" }, 400, cors);
    if (gtin && !(gtin.length >= 8 && gtin.length <= 14)) return json({ error: "gtin must be 8-14 digits" }, 400, cors);

    // Edge cache: same lookup within an hour is free and instant
    const cacheKey = new Request(`https://cache.local/v3/ebay/search?gtin=${gtin}&q=${encodeURIComponent(q.toLowerCase())}&cat=${cat}&limit=${limit}&ex=${encodeURIComponent(exclude.join(","))}&sort=${sort}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      return json({ ...body, cached: true }, 200, cors);
    }
    // Only uncached lookups (the ones that call eBay) count against the limit.
    const { success } = await env.SEARCH_LIMIT.limit({ key: ipKey(request.headers.get("CF-Connecting-IP") || "unknown") });
    if (!success) return json({ error: "Too many requests" }, 429, { ...cors, "Retry-After": "15" });
    try {
      const result = await searchEbay(env, { gtin, q, cat, limit, exclude, sort });
      const resp = json({ ...result, cached: false }, 200, { ...cors, "Cache-Control": `public, max-age=${CACHE_TTL}` });
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL}` } })));
      return resp;
    } catch (err) {
      // Upstream detail stays in the Worker logs; callers get a generic message.
      console.error("eBay lookup failed:", err && err.message ? err.message : err);
      return json({ error: "eBay lookup failed" }, 502, cors);
    }
  }
};
