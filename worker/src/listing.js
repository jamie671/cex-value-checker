// Owner-only eBay selling: connect the owner's eBay account (OAuth authorization-code grant), read their
// business policies, upload photos to eBay Picture Services and create fixed-price listings with the
// Trading API. Every route except the OAuth callback needs the X-App-Pass header (APP_PASS secret).
//
//   POST /ebay/account/connect      -> { url }  eBay consent page to open (state kept 10 min)
//   GET  /ebay/auth/callback        <- eBay redirects here; exchanges the code, then back to the app
//   GET  /ebay/account/status       -> { connected, username?, policies:{shipping,payment,return} }
//   POST /ebay/account/disconnect   -> forgets the tokens
//   POST /ebay/listing/photo        { image: base64 JPEG, name? } -> { url }
//   POST /ebay/listing/publish      { verify?, item } -> { ok, itemId?, url?, fees, warnings } | { ok:false, errors }
//
// Setup: EBAY_RUNAME secret (the RuName from the eBay developer portal whose "auth accepted URL" is
// <worker>/ebay/auth/callback); the eBay keyset (EBAY_APP_ID / EBAY_CERT_ID) is shared with price lookups.

import { DurableObject } from "cloudflare:workers";

const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly"
].join(" ");
const MARKETPLACE = "EBAY_AU";
const SITE_ID = "15";            // eBay Australia
const TRADING_VERSION = "1331";
const DEFAULT_APP_URL = "https://jamie671.github.io/cex-value-checker/";

// Tokens and pending sign-in states for the single owner.
export class OwnerStore extends DurableObject {
  async getTokens() { return (await this.ctx.storage.get("ebay_tokens")) || null; }
  async saveTokens(t) { await this.ctx.storage.put("ebay_tokens", t); }
  async clearTokens() { await this.ctx.storage.delete("ebay_tokens"); }
  async putState(state) {
    const states = ((await this.ctx.storage.get("oauth_states")) || []).filter(s => s.exp > Date.now()).slice(-5);
    states.push({ state, exp: Date.now() + 10 * 60 * 1000 });
    await this.ctx.storage.put("oauth_states", states);
  }
  async takeState(state) {
    const states = ((await this.ctx.storage.get("oauth_states")) || []).filter(s => s.exp > Date.now());
    const ok = states.some(s => s.state === state);
    await this.ctx.storage.put("oauth_states", states.filter(s => s.state !== state));
    return ok;
  }
}

const store = (env) => env.OWNER_STORE.get(env.OWNER_STORE.idFromName("owner"));
const apiBase = (env) => env.EBAY_API_BASE || "https://api.ebay.com";
const apizBase = (env) => env.EBAY_APIZ_BASE || "https://apiz.ebay.com";
const authBase = (env) => env.EBAY_AUTH_BASE || "https://auth.ebay.com";
const appUrl = (env) => env.APP_URL || DEFAULT_APP_URL;

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
}
async function samePass(given, expected) {
  const enc = new TextEncoder();
  const a = enc.encode(given || ""), b = enc.encode(expected || "");
  if (!b.length || a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
function randomHex(bytes) { return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join(""); }

class NotConnected extends Error {}

// ---- OAuth ----
async function tokenRequest(env, form) {
  const res = await fetch(`${apiBase(env)}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${btoa(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`)}` },
    body: new URLSearchParams(form).toString()
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`eBay token error ${res.status}: ${d.error || ""} ${d.error_description || ""}`.trim()); e.ebayError = d.error; throw e; }
  return d;
}
// A valid user access token, refreshed with the 18-month refresh token when it has expired
async function userToken(env) {
  const s = store(env);
  const t = await s.getTokens();
  if (!t || !t.refresh) throw new NotConnected("eBay account not connected");
  if (t.access && t.accessExp > Date.now() + 60000) return t.access;
  try {
    const d = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: t.refresh, scope: SCOPES });
    const next = { ...t, access: d.access_token, accessExp: Date.now() + (d.expires_in || 7200) * 1000 };
    await s.saveTokens(next);
    return next.access;
  } catch (e) {
    if (e.ebayError === "invalid_grant") { await s.clearTokens(); throw new NotConnected("The eBay connection has expired. Connect again"); }
    throw e;
  }
}
async function ebayJson(env, token, url) {
  const res = await fetch(url, { headers: { "Authorization": `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`eBay ${new URL(url).pathname} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ---- Trading API (XML) ----
const xmlEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const cdata = (s) => `<![CDATA[${String(s ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const xmlUnesc = (s) => String(s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml); return m ? xmlUnesc(m[1]).trim() : null; };
const tagsRaw = (xml, name) => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map(m => m[1]);

function tradingErrors(xml) {
  return tagsRaw(xml, "Errors").map(e => ({
    code: tag(e, "ErrorCode"), severity: tag(e, "SeverityCode") || "Error",
    message: tag(e, "LongMessage") || tag(e, "ShortMessage") || "eBay error"
  }));
}
async function trading(env, token, callName, body, contentType = "text/xml; charset=utf-8") {
  const res = await fetch(`${apiBase(env)}/ws/api.dll`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": TRADING_VERSION,
      "X-EBAY-API-IAF-TOKEN": token
    },
    body
  });
  const xml = await res.text();
  if (!res.ok && !/<Ack>/.test(xml)) throw new Error(`eBay ${callName} HTTP ${res.status}: ${xml.slice(0, 300)}`);
  const ack = tag(xml, "Ack") || "Failure";
  const all = tradingErrors(xml);
  return { xml, ack, ok: ack === "Success" || ack === "Warning", errors: all.filter(e => e.severity !== "Warning"), warnings: all.filter(e => e.severity === "Warning") };
}

// UploadSiteHostedPictures takes the image as a multipart attachment next to the XML request
async function uploadPicture(env, token, jpegBytes, name) {
  const boundary = "----cexvalue" + randomHex(12);
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <PictureName>${xmlEsc((name || "photo").slice(0, 80))}</PictureName>
  <PictureSet>Supersize</PictureSet>
  <ExtensionInDays>30</ExtensionInDays>
</UploadSiteHostedPicturesRequest>`;
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml; charset=utf-8\r\n\r\n${xml}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\nContent-Transfer-Encoding: binary\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + jpegBytes.length + tail.length);
  body.set(head, 0); body.set(jpegBytes, head.length); body.set(tail, head.length + jpegBytes.length);
  const r = await trading(env, token, "UploadSiteHostedPictures", body, `multipart/form-data; boundary=${boundary}`);
  const url = tag(r.xml, "FullURL");
  if (!r.ok || !url) return { ok: false, errors: r.errors.length ? r.errors : [{ message: "eBay didn't return a picture URL" }] };
  return { ok: true, url };
}

function itemXml(it) {
  const specifics = Object.entries(it.specifics || {})
    .map(([name, vals]) => [String(name).slice(0, 65), (Array.isArray(vals) ? vals : [vals]).map(v => String(v ?? "").trim().slice(0, 65)).filter(Boolean).slice(0, 30)])
    .filter(([name, vals]) => name && vals.length)
    .map(([name, vals]) => `<NameValueList><Name>${xmlEsc(name)}</Name>${vals.map(v => `<Value>${xmlEsc(v)}</Value>`).join("")}</NameValueList>`).join("");
  const pol = it.policies || {};
  return `<Item>
    <Title>${xmlEsc(String(it.title).slice(0, 80))}</Title>
    <Description>${cdata(it.descriptionHtml || "")}</Description>
    <PrimaryCategory><CategoryID>${xmlEsc(it.categoryId)}</CategoryID></PrimaryCategory>
    <CategoryMappingAllowed>true</CategoryMappingAllowed>
    <StartPrice currencyID="AUD">${Number(it.price).toFixed(2)}</StartPrice>
    <ConditionID>${xmlEsc(it.conditionId)}</ConditionID>
    ${it.conditionNote && it.conditionId !== "1000" ? `<ConditionDescription>${xmlEsc(String(it.conditionNote).slice(0, 1000))}</ConditionDescription>` : ""}
    <Country>AU</Country>
    <Currency>AUD</Currency>
    <Site>Australia</Site>
    <PostalCode>${xmlEsc(it.postalCode)}</PostalCode>
    ${it.location ? `<Location>${xmlEsc(it.location)}</Location>` : ""}
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Quantity>1</Quantity>
    ${it.sku ? `<SKU>${xmlEsc(String(it.sku).slice(0, 50))}</SKU>` : ""}
    <PictureDetails>${(it.pictures || []).slice(0, 24).map(u => `<PictureURL>${xmlEsc(u)}</PictureURL>`).join("")}</PictureDetails>
    ${specifics ? `<ItemSpecifics>${specifics}</ItemSpecifics>` : ""}
    <SellerProfiles>
      <SellerShippingProfile><ShippingProfileID>${xmlEsc(pol.shipping)}</ShippingProfileID></SellerShippingProfile>
      <SellerReturnProfile><ReturnProfileID>${xmlEsc(pol.return)}</ReturnProfileID></SellerReturnProfile>
      <SellerPaymentProfile><PaymentProfileID>${xmlEsc(pol.payment)}</PaymentProfileID></SellerPaymentProfile>
    </SellerProfiles>
  </Item>`;
}
function feesFrom(xml) {
  const block = tagsRaw(xml, "Fees")[0] || "";
  return [...block.matchAll(/<Fee>\s*<Name>([\s\S]*?)<\/Name>\s*<Fee[^>]*>([\s\S]*?)<\/Fee>/g)]
    .map(m => ({ name: xmlUnesc(m[1]).trim(), amount: parseFloat(m[2]) || 0 })).filter(f => f.amount > 0);
}
function checkItem(it) {
  const missing = [];
  if (!it || typeof it !== "object") return ["item"];
  if (!String(it.title || "").trim()) missing.push("title");
  if (!/^\d+$/.test(String(it.categoryId || ""))) missing.push("category");
  if (!(Number(it.price) > 0)) missing.push("price");
  if (!/^\d+$/.test(String(it.conditionId || ""))) missing.push("condition");
  if (!/^\d{4}$/.test(String(it.postalCode || ""))) missing.push("postcode (in eBay settings)");
  const pol = it.policies || {};
  if (!pol.shipping || !pol.return || !pol.payment) missing.push("postage, returns and payment policies (in eBay settings)");
  if (!Array.isArray(it.pictures) || !it.pictures.length) missing.push("photos");
  if ((it.pictures || []).some(u => !/^https:\/\//.test(String(u)))) missing.push("photo links");
  return missing;
}

// ---- Routes ----
export async function handleListing(request, env, ctx, cors, url) {
  const path = url.pathname;
  const configured = env.EBAY_APP_ID && env.EBAY_CERT_ID && env.EBAY_RUNAME && env.APP_PASS && env.OWNER_STORE;

  // eBay sends the browser here after the owner approves (or declines). Protected by the one-time state.
  if (path === "/ebay/auth/callback") {
    const back = (q) => Response.redirect(`${appUrl(env)}?${q}`, 302);
    if (!configured) return back("ebay=error&reason=worker-not-set-up");
    const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
    if (!code) return back("ebay=declined");
    if (!(await store(env).takeState(state))) return back("ebay=error&reason=expired");
    try {
      const d = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: env.EBAY_RUNAME });
      await store(env).saveTokens({ access: d.access_token, accessExp: Date.now() + (d.expires_in || 7200) * 1000,
        refresh: d.refresh_token, refreshExp: Date.now() + (d.refresh_token_expires_in || 0) * 1000, connectedAt: Date.now() });
      return back("ebay=connected");
    } catch (e) {
      console.error("eBay code exchange failed:", e.message);
      return back("ebay=error&reason=exchange");
    }
  }

  if (!configured) {
    console.error("eBay selling needs EBAY_APP_ID, EBAY_CERT_ID, EBAY_RUNAME, APP_PASS and the OWNER_STORE binding");
    return json({ error: "eBay listing isn't set up on the Worker yet (EBAY_RUNAME missing)" }, 503, cors);
  }
  if (!(await samePass(request.headers.get("X-App-Pass"), env.APP_PASS))) return json({ error: "This device isn't unlocked" }, 401, cors);

  try {
    if (path === "/ebay/account/connect" && request.method === "POST") {
      const state = randomHex(16);
      await store(env).putState(state);
      const q = new URLSearchParams({ client_id: env.EBAY_APP_ID, redirect_uri: env.EBAY_RUNAME, response_type: "code", scope: SCOPES, state, prompt: "login" });
      return json({ url: `${authBase(env)}/oauth2/authorize?${q}` }, 200, cors);
    }
    if (path === "/ebay/account/disconnect" && request.method === "POST") {
      await store(env).clearTokens();
      return json({ connected: false }, 200, cors);
    }
    if (path === "/ebay/account/status") {
      let token;
      try { token = await userToken(env); } catch (e) { if (e instanceof NotConnected) return json({ connected: false, reason: e.message }, 200, cors); throw e; }
      const q = `?marketplace_id=${MARKETPLACE}`;
      const [ful, ret, pay, who] = await Promise.all([
        ebayJson(env, token, `${apiBase(env)}/sell/account/v1/fulfillment_policy${q}`).catch(e => ({ error: e.message })),
        ebayJson(env, token, `${apiBase(env)}/sell/account/v1/return_policy${q}`).catch(e => ({ error: e.message })),
        ebayJson(env, token, `${apiBase(env)}/sell/account/v1/payment_policy${q}`).catch(e => ({ error: e.message })),
        ebayJson(env, token, `${apizBase(env)}/commerce/identity/v1/user/`).catch(() => ({}))
      ]);
      const policyError = [ful, ret, pay].find(p => p.error);
      if (policyError) console.error("eBay policies:", policyError.error);
      const domesticCost = (p) => {
        const opt = (p.shippingOptions || []).find(o => o.optionType === "DOMESTIC") || (p.shippingOptions || [])[0];
        const svc = opt && (opt.shippingServices || [])[0];
        if (!svc) return null;
        if (svc.freeShipping) return 0;
        const v = parseFloat(svc.shippingCost && svc.shippingCost.value);
        return Number.isFinite(v) ? v : null;
      };
      return json({
        connected: true,
        username: who.username || null,
        policiesError: policyError ? "Couldn't read your eBay business policies. Check you're opted in to business policies in eBay's Account settings" : null,
        policies: {
          shipping: (ful.fulfillmentPolicies || []).map(p => ({ id: p.fulfillmentPolicyId, name: p.name, cost: domesticCost(p) })),
          return: (ret.returnPolicies || []).map(p => ({ id: p.returnPolicyId, name: p.name })),
          payment: (pay.paymentPolicies || []).map(p => ({ id: p.paymentPolicyId, name: p.name }))
        }
      }, 200, cors);
    }
    if (path === "/ebay/listing/photo" && request.method === "POST") {
      if (parseInt(request.headers.get("Content-Length") || "0", 10) > 15 * 1024 * 1024) return json({ error: "Photo too large" }, 413, cors);
      const body = await request.json().catch(() => null);
      if (!body || typeof body.image !== "string") return json({ error: "Send { image: base64 JPEG }" }, 400, cors);
      let bytes;
      try { bytes = Uint8Array.from(atob(body.image), c => c.charCodeAt(0)); } catch (e) { return json({ error: "Image isn't valid base64" }, 400, cors); }
      if (bytes.length < 100 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return json({ error: "Image must be a JPEG" }, 400, cors);
      const r = await uploadPicture(env, await userToken(env), bytes, body.name);
      return json(r, r.ok ? 200 : 422, cors);
    }
    if (path === "/ebay/listing/publish" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const it = body && body.item;
      const missing = checkItem(it);
      if (missing.length) return json({ ok: false, errors: [{ message: `Missing: ${missing.join(", ")}` }] }, 400, cors);
      const call = body.verify ? "VerifyAddFixedPriceItem" : "AddFixedPriceItem";
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_AU</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${itemXml(it)}
</${call}Request>`;
      const r = await trading(env, await userToken(env), call, xml);
      const itemId = tag(r.xml, "ItemID");
      if (!r.ok) return json({ ok: false, errors: r.errors, warnings: r.warnings }, 422, cors);
      return json({ ok: true, verified: !!body.verify, itemId: body.verify ? null : itemId,
        url: !body.verify && itemId ? `https://www.ebay.com.au/itm/${itemId}` : null,
        fees: feesFrom(r.xml), warnings: r.warnings }, 200, cors);
    }
    return json({ error: "Not found" }, 404, cors);
  } catch (e) {
    if (e instanceof NotConnected) return json({ error: e.message, notConnected: true }, 409, cors);
    console.error("eBay listing route failed:", e && e.message ? e.message : e);
    return json({ error: "eBay request failed. Try again in a moment" }, 502, cors);
  }
}
