"use strict";
const express = require("express"), session = require("express-session"), crypto = require("crypto"), path = require("path");
const E = process.env, PORT = +E.PORT || 3000, BASE = (E.BASE_URL || "http://localhost:" + PORT).replace(/\/$/, "");
const ADS = "https://googleads.googleapis.com/" + (E.GOOGLE_ADS_API_VERSION || "v25");
const REDIRECT = BASE + "/auth/callback", SCOPE = "https://www.googleapis.com/auth/adwords";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET"].filter(k => !E[k]);

const app = express();
app.use(express.json());
app.use(session({
  name: "gws.sid", secret: E.SESSION_SECRET || crypto.randomBytes(16).toString("hex"),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: BASE.startsWith("https://"), maxAge: 8 * 3600e3 }
}));
// Basic CSRF guard for state-changing requests: same origin only.
app.use((req, res, next) => {
  if (req.method === "POST" && req.headers.origin && req.headers.origin !== new URL(BASE).origin)
    return res.status(403).json({ error: "Blocked: unexpected origin." });
  next();
});

async function form(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || "HTTP " + r.status);
  return j;
}
async function accessToken(req) {
  const t = req.session.tokens;
  if (!t) throw new Error("Not connected.");
  if (Date.now() < t.expires - 60000) return t.access;
  if (!t.refresh) throw new Error("Google did not issue a refresh token. Disconnect and connect again.");
  const r = await form(TOKEN_URL, { client_id: E.GOOGLE_CLIENT_ID, client_secret: E.GOOGLE_CLIENT_SECRET, refresh_token: t.refresh, grant_type: "refresh_token" });
  t.access = r.access_token; t.expires = Date.now() + r.expires_in * 1000;
  return t.access;
}
async function ads(req, p, body) {
  // Developer tokens were retired in Sept 2026; send one only if the owner still set it (optional, ignored by Google).
  const headers = { Authorization: "Bearer " + await accessToken(req), "Content-Type": "application/json" };
  if (E.GOOGLE_ADS_DEVELOPER_TOKEN) headers["developer-token"] = E.GOOGLE_ADS_DEVELOPER_TOKEN;
  const r = await fetch(ADS + p, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (/CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION/.test(JSON.stringify(j.error || {})))
      throw new Error("This Google Cloud project only has test access. Apply for Explorer access on the Google Ads API Overview page in Google Cloud Console.");
    throw new Error((j.error && j.error.message) || "Google Ads returned HTTP " + r.status);
  }
  return j;
}
async function listAccounts(req) {
  const l = await ads(req, "/customers:listAccessibleCustomers");
  const ids = (l.resourceNames || []).map(n => n.split("/")[1]).slice(0, 20);
  return Promise.all(ids.map(async id => {
    try {
      const r = await ads(req, "/customers/" + id + "/googleAds:search", { query: "SELECT customer.id, customer.descriptive_name, customer.manager FROM customer LIMIT 1" });
      const c = (r.results && r.results[0] && r.results[0].customer) || {};
      return { id, name: c.descriptiveName || "(no name)", manager: !!c.manager };
    } catch (e) { return { id, name: "(details unavailable)", manager: false }; }
  }));
}

app.get("/api/status", async (req, res) => {
  if (missing.length) return res.json({ state: "setup", missing, message: "Setup needed: add " + missing.join(", ") + " to the .env file." });
  if (!req.session.tokens) return res.json({ state: "disconnected" });
  try {
    if (!req.session.accts) req.session.accts = await listAccounts(req);
    const list = req.session.accts.filter(a => !a.manager).map(({ id, name }) => ({ id, name }));
    if (!list.length) return res.json({ state: "error", message: "No advertiser accounts found for this login. Manager accounts alone cannot be used yet." });
    let sel = list.find(a => a.id === req.session.customerId);
    if (!sel && list.length === 1) { sel = list[0]; req.session.customerId = sel.id; }
    res.json(sel ? { state: "connected", account: sel, accounts: list } : { state: "choose", accounts: list });
  } catch (e) { res.json({ state: "error", message: e.message }); }
});
app.get("/auth/google", (req, res) => {
  if (missing.length) return res.redirect("/");
  const s = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = s;
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: E.GOOGLE_CLIENT_ID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state: s }));
});
app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect("/?gads=denied");
  if (!code || !state || state !== req.session.oauthState) return res.redirect("/?gads=state");
  delete req.session.oauthState;
  try {
    const t = await form(TOKEN_URL, { code, client_id: E.GOOGLE_CLIENT_ID, client_secret: E.GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT, grant_type: "authorization_code" });
    req.session.tokens = { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000 };
    delete req.session.accts; delete req.session.customerId;
    res.redirect("/?gads=ok");
  } catch (e) { console.error("OAuth exchange failed:", e.message); res.redirect("/?gads=failed"); }
});
app.post("/api/select-account", (req, res) => {
  const id = String((req.body || {}).id || "");
  if (!(req.session.accts || []).some(a => a.id === id && !a.manager)) return res.status(400).json({ error: "Unknown account." });
  req.session.customerId = id; res.json({ ok: true });
});
app.post("/auth/disconnect", async (req, res) => {
  const t = req.session.tokens;
  if (t) { try { await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t.refresh || t.access }) }); } catch (e) {} }
  req.session.destroy(() => res.json({ ok: true }));
});
function needAcct(req, res) {
  if (!req.session.tokens || !req.session.customerId) { res.json({ error: "Connect Google Ads and choose an account to see your campaigns." }); return null; }
  return req.session.customerId;
}
async function campaigns(req, cid) {
  const r = await ads(req, "/customers/" + cid + "/googleAds:search", { query: "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.id DESC LIMIT 100" });
  return (r.results || []).map(x => ({ id: String(x.campaign.id), name: x.campaign.name, status: x.campaign.status,
    budget: x.campaignBudget && x.campaignBudget.amountMicros ? (x.campaignBudget.amountMicros / 1e6).toFixed(2) : "?" }));
}
app.get("/api/campaigns", async (req, res) => {
  const cid = needAcct(req, res); if (!cid) return;
  try { res.json({ campaigns: await campaigns(req, cid) }); } catch (e) { res.json({ error: e.message }); }
});
// Start (ENABLED) or stop (PAUSED) an existing campaign, then re-read it from Google Ads to verify.
app.post("/api/campaigns/status", async (req, res) => {
  const cid = req.session.customerId, { id, status } = req.body || {};
  if (!cid || !/^\d+$/.test(String(id)) || !["ENABLED", "PAUSED"].includes(status)) return res.status(400).json({ message: "Invalid request." });
  try { if (!(await campaigns(req, cid)).some(c => c.id === String(id))) return res.status(404).json({ message: "Campaign not found in this account." }); }
  catch (e) { return res.json({ message: e.message }); }
  let err = null;
  try { await ads(req, "/customers/" + cid + "/campaigns:mutate", { operations: [{ updateMask: "status", update: { resourceName: "customers/" + cid + "/campaigns/" + id, status } }] }); }
  catch (e) { err = e.message; }
  try {
    const now = (await campaigns(req, cid)).find(c => c.id === String(id)), ok = now && now.status === status;
    res.json({ status: now && now.status, message: ok ? "Verified in Google Ads: " + (status === "ENABLED" ? "running." : "stopped.") : err ? "Google Ads reported an error: " + err : "Google Ads did not confirm the change. Refresh and check." });
  } catch (e) { res.json({ message: "Status uncertain: could not re-check Google Ads. Refresh before trying again." + (err ? " (" + err + ")" : "") }); }
});
const MONTHS = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
// Frequency = total Google searches for each keyword in the chosen months and suburbs (Keyword Planner historical metrics).
app.post("/api/keywords", async (req, res) => {
  const cid = req.session.customerId, { keywords, suburbs, from, to } = req.body || {};
  if (!req.session.tokens || !cid) return res.json({ error: "Connect Google Ads and choose an account first." });
  const d = /^\d{4}-\d{2}-\d{2}$/;
  if (!Array.isArray(keywords) || !keywords.length || !Array.isArray(suburbs) || !suburbs.length || !d.test(from || "") || !d.test(to || "")) return res.json({ error: "Invalid request." });
  try {
    const g = await ads(req, "/geoTargetConstants:suggest", { locale: "en", countryCode: "AU", locationNames: { names: suburbs.slice(0, 25) } });
    const geo = [], names = [], seen = new Set();
    (g.geoTargetConstantSuggestions || []).forEach(x => {
      const c = x.geoTargetConstant || {};
      if (/New South Wales/.test(c.canonicalName || "") && !seen.has(x.searchTerm)) { seen.add(x.searchTerm); geo.push(c.resourceName); names.push(c.name); }
    });
    const unresolved = suburbs.filter(x => !seen.has(x));
    if (!geo.length) return res.json({ error: "None of the selected suburbs matched a Google location." });
    const now = new Date(), last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const s = new Date(from + "T00:00:00"); let e = new Date(to + "T00:00:00");
    if (e > last) e = last;
    if (s > e) return res.json({ error: "Google only has complete months up to last month. Choose an earlier Date To." });
    const ym = x => ({ year: x.getFullYear(), month: MONTHS[x.getMonth()] }), f = x => x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0");
    const r = await ads(req, "/customers/" + cid + ":generateKeywordHistoricalMetrics", {
      keywords: keywords.slice(0, 700), language: "languageConstants/1000", geoTargetConstants: geo, keywordPlanNetwork: "GOOGLE_SEARCH",
      historicalMetricsOptions: { yearMonthRange: { start: ym(s), end: ym(e) } } });
    const frequencies = {};
    (r.results || []).forEach(x => { const v = (x.keywordMetrics && x.keywordMetrics.monthlySearchVolumes) || []; frequencies[x.text] = v.length ? v.reduce((a, m) => a + Number(m.monthlySearches || 0), 0) : null; });
    res.json({ frequencies, unresolved, scope: names.join(", "), from: f(s), to: f(e) });
  } catch (e) { res.json({ error: e.message }); }
});
app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log("Campaign builder running at " + BASE + (missing.length ? " (setup needed: " + missing.join(", ") + ")" : "")));
