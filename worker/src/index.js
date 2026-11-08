// cex-ebay-proxy: tiny Cloudflare Worker that holds the eBay credentials and returns
// clean price stats for a barcode (GTIN/ISBN/UPC) or a keyword search on eBay Australia.
//
//   GET /ebay/search?gtin=9780747532699
//   GET /ebay/search?q=Inception%20blu-ray&cat=movies
//   GET /ebay/category?q=Sled%20Storm%20PS2             -> eBay AU category suggestions for a listing title
//   GET /ebay/aspects?cat=139973                          -> item specifics + allowed conditions for a category
//   cat = books | movies | music | games | boardgames | any      limit = 1..50 (default 40)
//   sort = price (default, cheapest first) | match (eBay best match)
//   exclude = comma list of words; listings whose title contains any are dropped (e.g. guitar,bundle)
//
// Response: { query, basis: "au_used"|"all", localCount?, count, returned, low, p25, median, p75, avg, currency,
//             items:[{title,price,shipping,total,condition,location,url,image,cat}], cached }
// cat = the listing's leaf category ID (used to pick a category when drafting a listing)
// basis "au_used" = Australian-located used listings (preferred); "all" = fallback to everything delivered to AU.
//
//   POST /claude/v1/messages   -> Claude Messages API, using the ANTHROPIC_API_KEY secret held here
// The app's Anthropic SDK uses ${worker}/claude as its base URL. Only requests carrying the owner's device
// passcode (X-App-Pass header, APP_PASS secret) are forwarded; models, parameters and beta headers are
// allow-listed, and there is a per-minute limit (CLAUDE_LIMIT) and a daily cap (UsageCounter, CLAUDE_DAILY_CAP).
//
//   /ebay/account/*, /ebay/listing/*, /ebay/auth/callback -> owner-only eBay selling (see listing.js)

import { DurableObject } from "cloudflare:workers";
import { handleListing, OwnerStore } from "./listing.js";
export { OwnerStore };

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

function corsHeaders(origin, request) {
  const ok = origin && ALLOWED_ORIGINS.some(rx => rx.test(origin));
  // The Anthropic SDK sends its own headers (anthropic-version, anthropic-beta, x-stainless-*), so a preflight
  // is answered with the headers it asks for. Only allowed origins get a usable answer.
  const asked = (request && request.headers.get("Access-Control-Request-Headers")) || "";
  return {
    "Access-Control-Allow-Origin": ok ? origin : "https://jamie671.github.io",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": ok && asked ? asked.slice(0, 2000) : "Content-Type",
    "Access-Control-Expose-Headers": "Retry-After, retry-after-ms, x-should-retry, request-id",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin, Access-Control-Request-Headers"
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
      cat: it.leafCategoryIds?.[0] || it.categories?.[0]?.categoryId || null,
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

// ---- Listing helpers (Taxonomy + Metadata APIs, application token) ----
const TAXONOMY_TTL = 86400;
let treeIdCache = null;
async function ebayGet(env, url) {
  const token = await getToken(env);
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE, "Accept": "application/json" } });
  if (res.status === 204) return {};
  if (!res.ok) throw new Error(`eBay ${new URL(url).pathname} error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function categoryTreeId(env) {
  if (treeIdCache) return treeIdCache;
  const d = await ebayGet(env, `https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE}`);
  treeIdCache = d.categoryTreeId || "15";
  return treeIdCache;
}
async function categorySuggestions(env, q) {
  const tree = await categoryTreeId(env);
  const d = await ebayGet(env, `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${tree}/get_category_suggestions?q=${encodeURIComponent(q)}`);
  const suggestions = (d.categorySuggestions || []).slice(0, 8).map(s => ({
    id: s.category?.categoryId,
    name: s.category?.categoryName,
    path: (s.categoryTreeNodeAncestors || []).map(a => a.categoryName).reverse().join(" > ")
  })).filter(s => s.id);
  return { q, suggestions };
}
async function categoryAspects(env, catId) {
  const tree = await categoryTreeId(env);
  const [asp, cond] = await Promise.all([
    ebayGet(env, `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${tree}/get_item_aspects_for_category?category_id=${catId}`),
    ebayGet(env, `https://api.ebay.com/sell/metadata/v1/marketplace/${MARKETPLACE}/get_item_condition_policies?filter=${encodeURIComponent(`categoryIds:{${catId}}`)}`).catch(err => {
      console.error("condition policies failed:", err && err.message ? err.message : err);
      return {};
    })
  ]);
  // Required first, then eBay's recommended ones; optional extras are left out to keep the form short
  const aspects = (asp.aspects || []).map(a => ({
    name: a.localizedAspectName,
    required: !!a.aspectConstraint?.aspectRequired,
    usage: a.aspectConstraint?.aspectUsage || "OPTIONAL",
    mode: a.aspectConstraint?.aspectMode || "FREE_TEXT",
    multi: a.aspectConstraint?.itemToAspectCardinality === "MULTI",
    values: (a.aspectValues || []).slice(0, 60).map(v => v.localizedValue)
  })).filter(a => a.name && (a.required || a.usage === "RECOMMENDED")).slice(0, 25);
  const policy = (cond.itemConditionPolicies || [])[0] || {};
  const conditions = (policy.itemConditions || []).map(c => ({ id: c.conditionId, name: c.conditionDescription }));
  return { categoryId: catId, aspects, conditions, conditionRequired: !!policy.itemConditionRequired };
}

async function cachedJson(ctx, cacheKey, ttl, cors, produce) {
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, cors);
  const result = await produce();
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` } })));
  return json({ ...result, cached: false }, 200, { ...cors, "Cache-Control": `public, max-age=${ttl}` });
}

// ---- Claude proxy (owner-only) ----
const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const CLAUDE_BODY_KEYS = new Set(["model", "max_tokens", "messages", "output_config", "fallbacks", "system", "thinking"]);
const CLAUDE_BETAS = new Set(["server-side-fallback-2026-07-01"]);
const CLAUDE_MAX_BYTES = 25 * 1024 * 1024;

// One counter object for the whole app: requests per day (Australian eastern standard time, UTC+10).
export class UsageCounter extends DurableObject {
  async hit(cap) {
    const day = new Date(Date.now() + 10 * 3600 * 1000).toISOString().slice(0, 10);
    const cur = (await this.ctx.storage.get("usage")) || { day, n: 0 };
    const n = cur.day === day ? cur.n : 0;
    if (n >= cap) return { ok: false, n, day };
    await this.ctx.storage.put("usage", { day, n: n + 1 });
    return { ok: true, n: n + 1, day };
  }
}

async function samePass(given, expected) {
  const enc = new TextEncoder();
  const a = enc.encode(given || ""), b = enc.encode(expected || "");
  if (!b.length || a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

// Errors in the Messages API's own shape, so the SDK in the app raises its usual error classes
function claudeError(status, type, message, cors, extra) {
  return json({ type: "error", error: { type, message } }, status, { ...cors, ...extra });
}

async function claudeProxy(request, env, ctx, cors) {
  if (request.method !== "POST") return claudeError(405, "invalid_request_error", "Use POST", cors);
  if (!env.ANTHROPIC_API_KEY || !env.APP_PASS || !env.CLAUDE_LIMIT || !env.CLAUDE_USAGE) {
    console.error("Claude proxy is not configured (ANTHROPIC_API_KEY / APP_PASS secrets, CLAUDE_LIMIT, CLAUDE_USAGE)");
    return claudeError(503, "api_error", "Claude isn't set up on the Worker yet", cors, { "x-should-retry": "false" });
  }
  if (!(await samePass(request.headers.get("X-App-Pass"), env.APP_PASS)))
    return claudeError(401, "authentication_error", "This device isn't unlocked for Claude", cors);

  const len = parseInt(request.headers.get("Content-Length") || "0", 10);
  if (len > CLAUDE_MAX_BYTES) return claudeError(413, "request_too_large", "Request too large", cors);
  let body;
  try { body = await request.json(); } catch (e) { return claudeError(400, "invalid_request_error", "Body must be JSON", cors); }
  const extraKeys = Object.keys(body || {}).filter(k => !CLAUDE_BODY_KEYS.has(k));
  if (extraKeys.length) return claudeError(400, "invalid_request_error", `Not allowed through this proxy: ${extraKeys.join(", ")}`, cors);
  if (!CLAUDE_MODELS.includes(body.model)) return claudeError(400, "invalid_request_error", "Model not allowed", cors);
  if (!(body.max_tokens > 0 && body.max_tokens <= 16000)) return claudeError(400, "invalid_request_error", "max_tokens must be 1-16000", cors);
  const betas = (request.headers.get("anthropic-beta") || "").split(",").map(b => b.trim()).filter(Boolean);
  if (betas.some(b => !CLAUDE_BETAS.has(b))) return claudeError(400, "invalid_request_error", "Beta not allowed", cors);

  const { success } = await env.CLAUDE_LIMIT.limit({ key: "owner" });
  if (!success) return claudeError(429, "rate_limit_error", "Too many Claude requests this minute. Wait a moment", cors, { "Retry-After": "20" });
  const cap = parseInt(env.CLAUDE_DAILY_CAP || "200", 10) || 200;
  const usage = await env.CLAUDE_USAGE.get(env.CLAUDE_USAGE.idFromName("owner")).hit(cap);
  if (!usage.ok) return claudeError(429, "rate_limit_error", `Daily Claude limit of ${cap} reads reached. It resets at midnight (AEST)`, cors, { "x-should-retry": "false" });

  const headers = {
    "content-type": "application/json",
    "anthropic-version": request.headers.get("anthropic-version") || "2026-10-21",
    "authorization": `Bearer ${env.ANTHROPIC_API_KEY}`
  };
  if (betas.length) headers["anthropic-beta"] = betas.join(",");
  let upstream;
  try {
    upstream = await fetch(`${env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (err) {
    console.error("Claude upstream unreachable:", err && err.message ? err.message : err);
    return claudeError(502, "api_error", "Couldn't reach Claude", cors);
  }
  if (!upstream.ok) console.error(`Claude upstream ${upstream.status} (request-id ${upstream.headers.get("request-id") || "-"})`);
  // A 401/403 from Anthropic is about the Worker's key, not the device: don't let the app think its passcode is wrong
  if (upstream.status === 401 || upstream.status === 403)
    return claudeError(502, "api_error", "The Worker's Claude API key was rejected. Update the ANTHROPIC_API_KEY secret", cors, { "x-should-retry": "false" });
  const out = new Headers(cors);
  for (const h of ["content-type", "request-id", "retry-after", "retry-after-ms", "x-should-retry"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, service: "cex-ebay-proxy" }, 200, cors);
    if (url.pathname === "/claude/v1/messages") return claudeProxy(request, env, ctx, cors);
    if (/^\/ebay\/(account|listing)\//.test(url.pathname) || url.pathname === "/ebay/auth/callback") return handleListing(request, env, ctx, cors, url);
    const ROUTES = ["/ebay/search", "/ebay/category", "/ebay/aspects"];
    if (!ROUTES.includes(url.pathname)) return json({ error: "Not found" }, 404, cors);
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

    const limited = async () => {
      const { success } = await env.SEARCH_LIMIT.limit({ key: ipKey(request.headers.get("CF-Connecting-IP") || "unknown") });
      return success;
    };
    // Listing helpers: cached for a day (categories and item specifics rarely change); only uncached calls count.
    if (url.pathname === "/ebay/category" || url.pathname === "/ebay/aspects") {
      const isCat = url.pathname === "/ebay/category";
      const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
      const catId = (url.searchParams.get("cat") || "").replace(/\D/g, "").slice(0, 12);
      if (isCat && q.length < 2) return json({ error: "Provide q" }, 400, cors);
      if (!isCat && !catId) return json({ error: "Provide cat (numeric category ID)" }, 400, cors);
      const key = new Request(`https://cache.local/v1${url.pathname}?${isCat ? `q=${encodeURIComponent(q.toLowerCase())}` : `cat=${catId}`}`);
      if (!(await caches.default.match(key)) && !(await limited())) return json({ error: "Too many requests" }, 429, { ...cors, "Retry-After": "15" });
      try {
        return await cachedJson(ctx, key, TAXONOMY_TTL, cors, () => isCat ? categorySuggestions(env, q) : categoryAspects(env, catId));
      } catch (err) {
        console.error("eBay taxonomy lookup failed:", err && err.message ? err.message : err);
        return json({ error: "eBay lookup failed" }, 502, cors);
      }
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
    const cacheKey = new Request(`https://cache.local/v4/ebay/search?gtin=${gtin}&q=${encodeURIComponent(q.toLowerCase())}&cat=${cat}&limit=${limit}&ex=${encodeURIComponent(exclude.join(","))}&sort=${sort}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      return json({ ...body, cached: true }, 200, cors);
    }
    // Only uncached lookups (the ones that call eBay) count against the limit.
    if (!(await limited())) return json({ error: "Too many requests" }, 429, { ...cors, "Retry-After": "15" });
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
