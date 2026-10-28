"use strict";
const express = require("express"), session = require("express-session"), crypto = require("crypto"), path = require("path");
const E = process.env, PORT = +E.PORT || 3000, BASE = (E.BASE_URL || "http://localhost:" + PORT).replace(/\/$/, "");
const ADS = "https://googleads.googleapis.com/" + (E.GOOGLE_ADS_API_VERSION || "v25");
const REDIRECT = BASE + "/auth/callback", SCOPE = "https://www.googleapis.com/auth/adwords";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET"].filter(k => !E[k]);

// Sessions (including the Google tokens) are saved to .sessions.json so a server restart doesn't sign you out. Keep that file private.
const fs = require("fs"), SESS_FILE = path.join(__dirname, ".sessions.json");
class FileStore extends session.Store {
  constructor() { super(); try { this.s = JSON.parse(fs.readFileSync(SESS_FILE, "utf8")); } catch (e) { this.s = {}; } }
  save() { fs.writeFile(SESS_FILE, JSON.stringify(this.s), { mode: 0o600 }, () => {}); }
  get(sid, cb) { const x = this.s[sid]; cb(null, x && (!x.cookie || !x.cookie.expires || new Date(x.cookie.expires) > new Date()) ? x : null); }
  set(sid, sess, cb) { this.s[sid] = sess; this.save(); cb && cb(null); }
  destroy(sid, cb) { delete this.s[sid]; this.save(); cb && cb(null); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}
const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(session({
  store: new FileStore(),
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
    // Google Ads puts the useful part (which field, which operation) in error.details[].errors[], not in the top-level message. Surface it.
    const detail = [];
    ((j.error && j.error.details) || []).forEach(d => (d.errors || []).forEach(x => {
      const loc = x.location && x.location.fieldPathElements ? x.location.fieldPathElements.map(f => f.fieldName + (f.index != null ? "[" + f.index + "]" : "")).join(".") : "";
      detail.push((x.errorCode ? Object.values(x.errorCode)[0] : "error") + (loc ? " at " + loc : "") + ": " + (x.message || ""));
    }));
    const err = new Error(detail.length ? detail.slice(0, 5).join(" | ") : ((j.error && j.error.message) || "Google Ads returned HTTP " + r.status));
    err.full = j.error;
    throw err;
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
const RECOMMENDED_NEGATIVES = ["diy", "jobs", "course"];
// KPI targets for a local lead-generation campaign (typical ranges for home-improvement search ads). Edit to suit the business.
const KPI = { minDailyBudget: 20, suggestedBudget: 30, targetCpl: 50, maxCpl: 80, minConvRate: 5, minCtr: 5, minImprShare: 60, maxCpc: 6, lowCtrKeyword: 2 };
const n2 = v => (Math.round(v * 100) / 100).toFixed(2);
// Pulls campaign + ad group + keyword + ad data and 30-day metrics, scores the campaign against the KPI targets, and suggests editable fixes.
async function campaignDetail(req, cid, id) {
  const q = s => ads(req, "/customers/" + cid + "/googleAds:search", { query: s });
  const campR = (await q("SELECT campaign.id, campaign.name, campaign.status, campaign.start_date_time, campaign.end_date_time, campaign.bidding_strategy_type, campaign.advertising_channel_type, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.network_settings.target_partner_search_network, campaign.geo_target_type_setting.positive_geo_target_type, campaign.target_spend.cpc_bid_ceiling_micros, campaign.maximize_conversions.target_cpa_micros, campaign.campaign_budget, campaign_budget.amount_micros FROM campaign WHERE campaign.id = " + id)).results || [];
  if (!campR.length) throw new Error("Campaign not found in this account.");
  const c = campR[0].campaign, bud = campR[0].campaignBudget || {};
  const isSearch = c.advertisingChannelType === "SEARCH", isPmax = c.advertisingChannelType === "PERFORMANCE_MAX";
  // The remaining lookups don't depend on each other, so they run at the same time.
  const kwWhere = " WHERE campaign.id = " + id + " AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'";
  const rows = p => p.then(r => r.results || []);
  const [metR, convR, locR, agR, adR, kwR, kwmR, negR, options] = await Promise.all([
    rows(q("SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions" + (isSearch ? ", metrics.search_impression_share, metrics.search_budget_lost_impression_share" : "") + " FROM campaign WHERE campaign.id = " + id + " AND segments.date DURING LAST_30_DAYS")),
    rows(q("SELECT conversion_action.id FROM conversion_action WHERE conversion_action.status = 'ENABLED'")),
    rows(q("SELECT campaign_criterion.criterion_id FROM campaign_criterion WHERE campaign.id = " + id + " AND campaign_criterion.type = 'LOCATION' AND campaign_criterion.negative = FALSE AND campaign_criterion.status != 'REMOVED'")),
    rows(q("SELECT ad_group.id, ad_group.status FROM ad_group WHERE campaign.id = " + id + " AND ad_group.status != 'REMOVED'")),
    rows(q("SELECT ad_group.id, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE campaign.id = " + id + " AND ad_group_ad.status != 'REMOVED'")),
    // Keyword metrics are only available FROM keyword_view, so list every keyword too (ones with no traffic don't appear there).
    rows(q("SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion" + kwWhere)),
    rows(q("SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.impressions, metrics.clicks, metrics.cost_micros FROM keyword_view" + kwWhere + " AND segments.date DURING LAST_30_DAYS")),
    rows(q("SELECT campaign_criterion.keyword.text FROM campaign_criterion WHERE campaign.id = " + id + " AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED'")),
    readOptions(req, cid, id)
  ]);
  const mAgg = { impressions: 0, clicks: 0, costMicros: 0, conversions: 0, imprShare: null, budgetLost: null };
  metR.forEach(x => {
    const m = x.metrics || {}; mAgg.impressions += Number(m.impressions || 0); mAgg.clicks += Number(m.clicks || 0); mAgg.costMicros += Number(m.costMicros || 0); mAgg.conversions += Number(m.conversions || 0);
    if (m.searchImpressionShare != null) mAgg.imprShare = Number(m.searchImpressionShare) * 100;
    if (m.searchBudgetLostImpressionShare != null) mAgg.budgetLost = Number(m.searchBudgetLostImpressionShare) * 100;
  });
  const convActions = convR.length, locCount = locR.length, adGroups = agR.map(x => x.adGroup);
  const adCounts = {};
  adR.forEach(x => {
    const rsa = ((x.adGroupAd || {}).ad || {}).responsiveSearchAd || {};
    adCounts[(x.adGroup || {}).id] = { headlines: (rsa.headlines || []).length, descriptions: (rsa.descriptions || []).length };
  });
  const kwAgg = {};
  const kwAdd = x => {
    const crit = x.adGroupCriterion || {}, key = (x.adGroup || {}).id + "~" + crit.criterionId;
    if (!kwAgg[key]) kwAgg[key] = { adGroupId: (x.adGroup || {}).id, criterionId: crit.criterionId, text: (crit.keyword || {}).text, matchType: (crit.keyword || {}).matchType, impressions: 0, clicks: 0, costMicros: 0 };
    return kwAgg[key];
  };
  kwR.forEach(kwAdd);
  kwmR.forEach(x => {
    const k = kwAdd(x), m = x.metrics || {};
    k.impressions += Number(m.impressions || 0); k.clicks += Number(m.clicks || 0); k.costMicros += Number(m.costMicros || 0);
  });
  const keywords = Object.values(kwAgg);
  const kwItem = k => ({ text: k.text, resourceName: "customers/" + cid + "/adGroupCriteria/" + k.adGroupId + "~" + k.criterionId });
  const wasteful = keywords.filter(k => k.impressions >= 50 && k.clicks === 0).sort((a, b) => b.impressions - a.impressions);
  const lowCtr = keywords.filter(k => k.impressions >= 100 && k.clicks > 0 && k.clicks / k.impressions * 100 < KPI.lowCtrKeyword).sort((a, b) => b.costMicros - a.costMicros);
  const negatives = negR.map(x => ((x.campaignCriterion || {}).keyword || {}).text).filter(Boolean);
  const missingNegatives = RECOMMENDED_NEGATIVES.filter(t => !negatives.includes(t));
  const thinAds = adGroups.filter(ag => { const cc = adCounts[ag.id]; return !cc || cc.headlines < 8 || cc.descriptions < 3; });

  const budget = bud.amountMicros ? Number(bud.amountMicros) / 1e6 : null;
  const costAud = mAgg.costMicros / 1e6, dailyAvgCost = costAud / 30;
  const ctr = mAgg.impressions ? mAgg.clicks / mAgg.impressions * 100 : 0, avgCpc = mAgg.clicks ? costAud / mAgg.clicks : 0;
  const convRate = mAgg.clicks ? mAgg.conversions / mAgg.clicks * 100 : 0, cpl = mAgg.conversions ? costAud / mAgg.conversions : null;
  const nearBudget = budget && dailyAvgCost >= budget * 0.85;
  const bidding = c.biddingStrategyType || "";
  const cpcCap = c.targetSpend && c.targetSpend.cpcBidCeilingMicros ? Number(c.targetSpend.cpcBidCeilingMicros) / 1e6 : null;
  const tcpa = c.maximizeConversions && c.maximizeConversions.targetCpaMicros ? Number(c.maximizeConversions.targetCpaMicros) / 1e6 : null;
  const ns = c.networkSettings || {}, extraNetworks = isSearch && (ns.targetSearchNetwork || ns.targetContentNetwork || ns.targetPartnerSearchNetwork);
  const geoType = (c.geoTargetTypeSetting || {}).positiveGeoTargetType;
  const hasData = mAgg.impressions > 0;

  // KPI scorecard. status: ok / warn / none (not enough data).
  const kpi = (name, value, target, ok) => ({ name, value, target, status: value == null ? "none" : ok ? "ok" : "warn" });
  const kpis = [
    kpi("Enquiries (conversions)", convActions ? (hasData ? String(Math.round(mAgg.conversions * 10) / 10) : null) : "Not tracked", "Growing week on week", convActions > 0 && mAgg.conversions > 0),
    kpi("Cost per enquiry", cpl != null ? "A$" + n2(cpl) : null, "A$" + KPI.targetCpl + " (max A$" + KPI.maxCpl + ")", cpl != null && cpl <= KPI.maxCpl),
    kpi("Enquiry rate", mAgg.clicks ? n2(convRate) + "%" : null, KPI.minConvRate + "% or more", convRate >= KPI.minConvRate),
    kpi("Click-through rate", hasData ? n2(ctr) + "%" : null, KPI.minCtr + "% or more", ctr >= KPI.minCtr),
    kpi("Search impression share", mAgg.imprShare != null ? n2(mAgg.imprShare) + "%" : null, KPI.minImprShare + "% or more", mAgg.imprShare >= KPI.minImprShare),
    kpi("Average cost per click", mAgg.clicks ? "A$" + n2(avgCpc) : null, "A$2 to A$" + KPI.maxCpc, avgCpc <= KPI.maxCpc),
    kpi("Daily budget", budget != null ? "A$" + n2(budget) : null, "A$" + KPI.minDailyBudget + " or more", budget >= KPI.minDailyBudget)
  ];

  const suggestions = [];
  const budgetLow = budget != null && budget < KPI.minDailyBudget, budgetLimited = mAgg.budgetLost != null && mAgg.budgetLost > 20;
  if (budget != null && (budgetLow || budgetLimited || nearBudget)) suggestions.push({ id: "budget", severity: "warn",
    text: budgetLow ? "The daily budget of A$" + n2(budget) + " is too small to get steady enquiries (often less than one or two clicks a day). Around A$" + KPI.suggestedBudget + " a day gives Google enough room to show your ads across your suburbs and collect enough data to judge the campaign within 2 to 3 weeks."
      : budgetLimited ? "The campaign missed " + n2(mAgg.budgetLost) + "% of searches it was eligible for because the budget ran out. Raising the budget is the most direct way to reach more customers."
      : "Average daily spend (A$" + n2(dailyAvgCost) + ") is tracking close to the daily budget (A$" + n2(budget) + "). Raising the budget should let the campaign win more of the auctions it is already competitive in.",
    fixLabel: "New daily budget (A$)",
    autofix: { type: "budget", resourceName: c.campaignBudget, value: n2(budgetLow ? KPI.suggestedBudget : budget * 1.2) } });
  if (!convActions) suggestions.push({ id: "convtracking", severity: "warn",
    text: "No conversion tracking is switched on in this Google Ads account, so enquiries (calls, quote forms) can't be counted and the KPIs that matter most can't be measured. Set up call and form-submit conversions in Google Ads (Goals > Conversions) before spending more.",
    fixLabel: null, autofix: null });
  if (convActions && /^(MAXIMIZE_CONVERSIONS|TARGET_SPEND|MANUAL_CPC)$/.test(bidding) && !tcpa) suggestions.push({ id: "tcpa", severity: "info",
    text: (bidding === "MAXIMIZE_CONVERSIONS" ? "This campaign already bids for enquiries but has no target cost per enquiry, so it may spend more per lead than a job is worth." : "This campaign bids for clicks, not enquiries. Switching to Maximise conversions with a target cost per enquiry tells Google to find people likely to call or request a quote.") + " A$" + KPI.targetCpl + " is a sensible starting target; set it from your average job value.",
    fixLabel: "Target cost per enquiry (A$)",
    autofix: { type: "tcpa", value: n2(KPI.targetCpl) } });
  if (bidding === "TARGET_SPEND" && (cpcCap == null || cpcCap > KPI.maxCpc)) suggestions.push({ id: "cpccap", severity: "info",
    text: (cpcCap == null ? "There is no maximum cost per click, so" : "The maximum cost per click is A$" + n2(cpcCap) + ", so") + " single clicks can get expensive. Capping it around A$" + KPI.maxCpc + " keeps more clicks inside the budget. (Skipped if you also switch to a target cost per enquiry.)",
    fixLabel: "Maximum cost per click (A$)",
    autofix: { type: "cpccap", value: n2(KPI.maxCpc) } });
  if (extraNetworks) suggestions.push({ id: "networks", severity: "warn",
    text: "Ads also show on " + [ns.targetSearchNetwork || ns.targetPartnerSearchNetwork ? "Search partner sites" : "", ns.targetContentNetwork ? "the Display network" : ""].filter(Boolean).join(" and ") + ". For a local service these usually bring cheaper but far less interested clicks, which drags down click-through and enquiry rates. Showing on Google Search only keeps the budget on people actively looking.",
    fixLabel: "Change", autofix: { type: "networks", value: "Show on Google Search only", fixed: true } });
  if (geoType && geoType !== "PRESENCE") suggestions.push({ id: "geotype", severity: "warn",
    text: "Location targeting also reaches people who are only interested in your suburbs, not in them, so ads can show to people far outside your service area. Targeting people in or regularly in your locations stops paying for clicks you can't serve.",
    fixLabel: "Change", autofix: { type: "geotype", value: "People in or regularly in your locations", fixed: true } });
  if (!isPmax && missingNegatives.length) suggestions.push({ id: "negatives", severity: "info",
    text: "A few broad, low-intent terms aren't excluded yet: " + missingNegatives.join(", ") + ". Blocking them keeps spend focused on people actually looking to buy, which usually lifts conversion rate.",
    fixLabel: "Negative keywords to add",
    autofix: { type: "negatives", value: missingNegatives.join(", ") } });
  if (wasteful.length) suggestions.push({ id: "wastekw", severity: "warn",
    text: wasteful.length + " keyword(s) have 50+ impressions and zero clicks in the last 30 days, for example “" + wasteful[0].text + "”. Pausing these frees budget for keywords that are actually converting.",
    fixLabel: "Keyword(s) to pause",
    autofix: { type: "pauseKeywords", value: wasteful.slice(0, 10).map(k => k.text).join(", "), items: wasteful.slice(0, 10).map(kwItem) } });
  if (lowCtr.length) suggestions.push({ id: "lowctr", severity: "warn",
    text: lowCtr.length + " keyword(s) have a click-through rate under " + KPI.lowCtrKeyword + "% (100+ impressions), for example “" + lowCtr[0].text + "”. They pull the campaign's CTR down and usually cost more per enquiry. Pausing them lifts CTR towards the " + KPI.minCtr + "% target.",
    fixLabel: "Keyword(s) to pause",
    autofix: { type: "pauseKeywords", value: lowCtr.slice(0, 10).map(k => k.text).join(", "), items: lowCtr.slice(0, 10).map(kwItem) } });
  if (mAgg.clicks >= 50 && convActions && convRate < KPI.minConvRate) suggestions.push({ id: "convrate", severity: "info",
    text: "Only " + n2(convRate) + "% of clicks became enquiries (target " + KPI.minConvRate + "%+). People are clicking but not calling or filling in the form, so the landing page or offer needs attention: a clear phone number, a short quote form and a reason to act now (free measure and quote, current sale).",
    fixLabel: null, autofix: null });
  if (isSearch && thinAds.length) suggestions.push({ id: "adstrength", severity: "info",
    text: thinAds.length + " ad group(s) have fewer than 8 headlines or 3 descriptions. More headline variety (benefits, offers, calls to action) generally improves Ad Strength and lets Google show the best-performing combination to each searcher.",
    fixLabel: null, autofix: null });
  if (isSearch && keywords.length < 8) suggestions.push({ id: "reach", severity: "info",
    text: "With only " + keywords.length + " keyword(s), this campaign is likely missing long-tail, suburb-specific searches (for example a specific suburb plus product name). Broadening keyword coverage is one of the fastest ways to reach more of the local market.",
    fixLabel: null, autofix: null });
  if (!c.endDateTime) suggestions.push({ id: "enddate", severity: "info",
    text: "This campaign has no end date, so it keeps running until paused manually. Worth double-checking that is intended.", fixLabel: null, autofix: null });
  else if (new Date(c.endDateTime) < new Date() && c.status === "ENABLED") suggestions.push({ id: "ended", severity: "warn",
    text: "This campaign is switched on but its end date (" + c.endDateTime.slice(0, 10) + ") has passed, so it is not showing any ads. Change or remove the end date in Google Ads if you want it running.", fixLabel: null, autofix: null });
  if (!suggestions.length) suggestions.push({ id: "healthy", severity: "ok",
    text: "No issues found in this check. Budget, bidding, targeting and keyword performance all meet the KPI targets.", fixLabel: null, autofix: null });

  return {
    id: String(c.id), name: c.name, status: c.status, startDate: c.startDateTime ? c.startDateTime.slice(0, 10) : null, endDate: c.endDateTime ? c.endDateTime.slice(0, 10) : null,
    bidding: bidding || "?", budget: budget != null ? budget.toFixed(2) : "?", type: c.advertisingChannelType || "?",
    locations: locCount, adGroups: adGroups.length, keywords: keywords.length, negatives: negatives.length,
    metrics: { impressions: mAgg.impressions, clicks: mAgg.clicks, cost: costAud.toFixed(2), ctr: ctr.toFixed(2) + "%", avgCpc: avgCpc.toFixed(2), conversions: Math.round(mAgg.conversions * 10) / 10 },
    kpis, suggestions, options
  };
}
// Campaign options (AI Max, Search Network, Display Network, Target ROAS) as shown and edited on the Analysis page.
async function readOptions(req, cid, id) {
  const q = s => ads(req, "/customers/" + cid + "/googleAds:search", { query: s });
  const r = ((await q("SELECT campaign.id, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.network_settings.target_search_network, campaign.network_settings.target_content_network, campaign.maximize_conversion_value.target_roas, campaign.target_roas.target_roas FROM campaign WHERE campaign.id = " + id)).results || [])[0];
  if (!r) return null;
  const c = r.campaign, ns = c.networkSettings || {}, type = c.advertisingChannelType, bid = c.biddingStrategyType || "";
  let aiMax = false;
  // AI Max only exists on Search campaigns; read it separately so an older account or API version can't break the analysis.
  if (type === "SEARCH") try { aiMax = !!((((await q("SELECT campaign.ai_max_setting.enable_ai_max FROM campaign WHERE campaign.id = " + id)).results || [])[0] || {}).campaign.aiMaxSetting || {}).enableAiMax; } catch (e) {}
  const roasVal = bid === "TARGET_ROAS" ? (c.targetRoas || {}).targetRoas : bid === "MAXIMIZE_CONVERSION_VALUE" ? (c.maximizeConversionValue || {}).targetRoas : null;
  return {
    live: c.status === "ENABLED", type, bidding: bid,
    aiMax, searchPartners: !!ns.targetSearchNetwork, display: !!ns.targetContentNetwork,
    roas: !!roasVal, roasPct: roasVal ? Math.round(Number(roasVal) * 100) : null,
    can: { aiMax: type === "SEARCH", networks: type === "SEARCH", roas: ["SEARCH", "PERFORMANCE_MAX", "DISPLAY", "SHOPPING"].includes(type) }
  };
}
app.post("/api/campaigns/:id/options", async (req, res) => {
  const cid = req.session.customerId, id = req.params.id, b = req.body || {};
  if (!req.session.tokens || !cid) return res.status(400).json({ message: "Connect Google Ads and choose an account first." });
  if (!/^\d+$/.test(id)) return res.status(400).json({ message: "Invalid campaign ID." });
  try {
    const cur = await readOptions(req, cid, id);
    if (!cur) return res.json({ message: "Campaign not found in this account." });
    if (!cur.live) return res.json({ message: "This campaign is not live, so its options can only be changed while it is running." });
    const upd = { resourceName: "customers/" + cid + "/campaigns/" + id }, mask = [], changed = [];
    const flag = (k, ok) => typeof b[k] === "boolean" && b[k] !== cur[k] && ok;
    if (flag("aiMax", cur.can.aiMax)) { upd.aiMaxSetting = { enableAiMax: b.aiMax }; mask.push("ai_max_setting.enable_ai_max"); changed.push("aiMax"); }
    if (flag("searchPartners", cur.can.networks) || flag("display", cur.can.networks)) {
      upd.networkSettings = {};
      if (typeof b.searchPartners === "boolean" && b.searchPartners !== cur.searchPartners) { upd.networkSettings.targetSearchNetwork = b.searchPartners; mask.push("network_settings.target_search_network"); changed.push("searchPartners"); }
      if (typeof b.display === "boolean" && b.display !== cur.display) { upd.networkSettings.targetContentNetwork = b.display; mask.push("network_settings.target_content_network"); changed.push("display"); }
    }
    if (cur.can.roas && typeof b.roas === "boolean") {
      const pct = Number(b.roasPct);
      if (b.roas && !(pct >= 10 && pct <= 10000)) return res.json({ message: "Target ROAS must be between 10% and 10000%." });
      if (b.roas && (!cur.roas || pct !== cur.roasPct)) { upd.maximizeConversionValue = { targetRoas: pct / 100 }; mask.push("maximize_conversion_value.target_roas"); changed.push("roas"); }
      // Turning Target ROAS off moves the campaign to Maximise conversions with no target.
      else if (!b.roas && cur.roas) { upd.maximizeConversions = {}; mask.push("maximize_conversions.target_cpa_micros"); changed.push("roas"); }
    }
    if (!mask.length) return res.json({ ok: true, changed: [], message: "Nothing changed." });
    const validateOnly = b.validateOnly === true;
    await ads(req, "/customers/" + cid + "/googleAds:mutate", { mutateOperations: [{ campaignOperation: { update: upd, updateMask: mask.join(",") } }], partialFailure: false, validateOnly });
    if (validateOnly) return res.json({ ok: true, validated: true, changed });
    const now = await readOptions(req, cid, id);
    const bad = changed.filter(k => k === "roas" ? now.roas !== b.roas || (b.roas && now.roasPct !== Math.round(Number(b.roasPct))) : now[k] !== b[k]);
    console.log(JSON.stringify({ t: new Date().toISOString(), event: "campaign_options", customer: cid, campaign: id, changed, unverified: bad }));
    res.json(bad.length ? { message: "Google Ads accepted the change but " + bad.join(", ") + " did not read back as expected. Check it in Google Ads.", options: now } : { ok: true, changed, options: now });
  } catch (e) {
    console.error("campaign_options failed:", e.message, e.full ? JSON.stringify(e.full) : "");
    res.json({ message: "Not changed. Google Ads said: " + e.message });
  }
});
app.get("/api/campaigns/:id/detail", async (req, res) => {
  const cid = req.session.customerId;
  if (!req.session.tokens || !cid) return res.status(400).json({ error: "Connect Google Ads and choose an account first." });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid campaign ID." });
  try { res.json(await campaignDetail(req, cid, req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Applies only the suggestions the user ticked, with whatever value they edited in the box, as one atomic mutate, then re-reads the campaign to confirm.
app.post("/api/campaigns/:id/apply", async (req, res) => {
  const cid = req.session.customerId, id = req.params.id;
  if (!req.session.tokens || !cid) return res.status(400).json({ message: "Connect Google Ads and choose an account first." });
  if (!/^\d+$/.test(id)) return res.status(400).json({ message: "Invalid campaign ID." });
  const fixes = Array.isArray((req.body || {}).fixes) ? req.body.fixes : [];
  if (!fixes.length) return res.json({ message: "Nothing selected." });
  try {
    const before = await campaignDetail(req, cid, id);
    if (before.options && !before.options.live) return res.json({ message: "This campaign is paused, so suggestions can only be applied while it is live." });
    const sugg = sid => before.suggestions.find(s => s.id === sid && s.autofix);
    const money = (v, min, max) => { const a = Number(v); return isFinite(a) && a >= min && a <= max ? String(Math.round(a * 1e6)) : null; };
    const campRes = "customers/" + cid + "/campaigns/" + id, campUpd = { resourceName: campRes }, campMask = [];
    const maxBudget = Number(E.MAX_DAILY_BUDGET) > 0 ? Number(E.MAX_DAILY_BUDGET) : 10000;
    const ops = [], applied = [], skipped = [];
    const wantsTcpa = fixes.some(f => f.type === "tcpa");
    fixes.forEach(f => {
      if (f.type === "budget" && sugg("budget")) {
        const amt = money(f.amount, 1, maxBudget);
        if (!amt) return skipped.push("Daily budget must be between A$1 and A$" + maxBudget + ".");
        ops.push({ campaignBudgetOperation: { update: { resourceName: sugg("budget").autofix.resourceName, amountMicros: amt }, updateMask: "amount_micros" } });
        applied.push("budget");
      } else if (f.type === "tcpa" && sugg("tcpa")) {
        const amt = money(f.value, 1, 1000);
        if (!amt) return skipped.push("Target cost per enquiry must be between A$1 and A$1000.");
        campUpd.maximizeConversions = { targetCpaMicros: amt }; campMask.push("maximize_conversions.target_cpa_micros");
        applied.push("tcpa");
      } else if (f.type === "cpccap" && sugg("cpccap")) {
        if (wantsTcpa) return skipped.push("Maximum cost per click was skipped because the campaign is switching to a target cost per enquiry.");
        const amt = money(f.value, 0.1, 100);
        if (!amt) return skipped.push("Maximum cost per click must be between A$0.10 and A$100.");
        campUpd.targetSpend = { cpcBidCeilingMicros: amt }; campMask.push("target_spend.cpc_bid_ceiling_micros");
        applied.push("cpccap");
      } else if (f.type === "networks" && sugg("networks")) {
        campUpd.networkSettings = { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false };
        campMask.push("network_settings.target_google_search", "network_settings.target_search_network", "network_settings.target_content_network", "network_settings.target_partner_search_network");
        applied.push("networks");
      } else if (f.type === "geotype" && sugg("geotype")) {
        campUpd.geoTargetTypeSetting = { positiveGeoTargetType: "PRESENCE" }; campMask.push("geo_target_type_setting.positive_geo_target_type");
        applied.push("geotype");
      } else if (f.type === "negatives") {
        const terms = (Array.isArray(f.terms) ? f.terms : []).map(t => String(t).trim()).filter(t => t && t.length <= 80 && !/["\[\]]/.test(t)).slice(0, 20);
        if (!terms.length) return;
        terms.forEach(t => ops.push({ campaignCriterionOperation: { create: { campaign: campRes, negative: true, keyword: { text: t, matchType: "PHRASE" } } } }));
        applied.push("negatives");
      } else if (f.type === "pauseKeywords" && sugg(f.id)) {
        const wanted = (Array.isArray(f.texts) ? f.texts : []).map(t => String(t).trim().toLowerCase()).filter(Boolean);
        const matches = (sugg(f.id).autofix.items || []).filter(it => wanted.includes(it.text.toLowerCase()));
        if (!matches.length) return;
        matches.forEach(it => ops.push({ adGroupCriterionOperation: { update: { resourceName: it.resourceName, status: "PAUSED" }, updateMask: "status" } }));
        applied.push(f.id);
      }
    });
    // All campaign-level settings go in one campaign update so Google Ads sees a single change to the campaign.
    if (campMask.length) ops.unshift({ campaignOperation: { update: campUpd, updateMask: campMask.join(",") } });
    if (!ops.length) return res.json({ message: skipped.length ? skipped.join(" ") : "Nothing in the selection could be applied." });
    // validateOnly asks Google Ads to check the changes without making them.
    const validateOnly = (req.body || {}).validateOnly === true;
    await ads(req, "/customers/" + cid + "/googleAds:mutate", { mutateOperations: ops, partialFailure: false, validateOnly });
    if (validateOnly) return res.json({ ok: true, validated: true, applied, skipped });
    const after = await campaignDetail(req, cid, id);
    console.log(JSON.stringify({ t: new Date().toISOString(), event: "campaign_apply", customer: cid, campaign: id, applied }));
    res.json({ ok: true, applied, skipped, detail: after });
  } catch (e) {
    console.error("campaign_apply failed:", e.message, e.full ? JSON.stringify(e.full) : "");
    res.json({ message: "Could not apply the changes. Google Ads said: " + e.message });
  }
});
// Money settings and spend-related performance for side-by-side comparison, covering each campaign's whole life:
// from its start date until today, whether it is live or stopped. Daily rates use only the days it actually ran.
const ymd = d => d.toISOString().slice(0, 10);
async function moneyData(req, cid, ids) {
  const q = s => ads(req, "/customers/" + cid + "/googleAds:search", { query: s });
  const inIds = "campaign.id IN (" + ids.join(",") + ")";
  const camps = ((await q("SELECT campaign.id, campaign.name, campaign.status, campaign.start_date_time, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.target_spend.cpc_bid_ceiling_micros, campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE " + inIds)).results || []);
  const today = new Date(), starts = camps.map(r => (r.campaign.startDateTime || "").slice(0, 10)).filter(Boolean).sort();
  const from = starts[0] || ymd(new Date(today.getTime() - 365 * 864e5));
  const days = {};
  // A long history can run past one page of results, so follow the page tokens.
  const all = async s => { let out = [], tok; do { const r = await ads(req, "/customers/" + cid + "/googleAds:search", tok ? { query: s, pageToken: tok } : { query: s }); out = out.concat(r.results || []); tok = r.nextPageToken; } while (tok); return out; };
  ((await all("SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE " + inIds + " AND segments.date BETWEEN '" + from + "' AND '" + ymd(today) + "'"))).forEach(x => {
    const m = x.metrics || {}, id = String(x.campaign.id);
    if (!Number(m.impressions)) return;
    (days[id] = days[id] || []).push({ date: x.segments.date, impr: Number(m.impressions), clicks: Number(m.clicks || 0), cost: Number(m.costMicros || 0) / 1e6, conv: Number(m.conversions || 0),
      is: m.searchImpressionShare != null ? Number(m.searchImpressionShare) : null, lostB: m.searchBudgetLostImpressionShare != null ? Number(m.searchBudgetLostImpressionShare) : null, lostR: m.searchRankLostImpressionShare != null ? Number(m.searchRankLostImpressionShare) : null });
  });
  const micros = v => v ? Number(v) / 1e6 : null;
  return ids.map(id => camps.find(r => String(r.campaign.id) === id)).filter(Boolean).map(r => {
    const c = r.campaign, b = r.campaignBudget || {}, id = String(c.id);
    const rows = days[id] || [], start = (c.startDateTime || "").slice(0, 10) || from, nDays = rows.length;
    const period = "Since " + start + " (start) to today: " + nDays + " day(s) with ads showing";
    const sum = k => rows.reduce((s, d) => s + d[k], 0);
    // Impression shares are weighted by eligible impressions (impressions / share) so busy days count more.
    let elig = 0, lostB = 0, lostR = 0, isDays = 0;
    rows.forEach(d => { if (d.is > 0) { const e = d.impr / d.is; elig += e; lostB += e * (d.lostB || 0); lostR += e * (d.lostR || 0); isDays++; } });
    const impr = sum("impr"), clicks = sum("clicks"), cost = sum("cost"), conv = sum("conv");
    return {
      id, name: c.name, status: c.status, type: c.advertisingChannelType, bidding: c.biddingStrategyType,
      budget: micros(b.amountMicros), budgetResource: c.campaignBudget, budgetShared: !!b.explicitlyShared,
      cpcCap: c.targetSpend ? micros(c.targetSpend.cpcBidCeilingMicros) : null,
      targetCpa: c.biddingStrategyType === "TARGET_CPA" ? micros((c.targetCpa || {}).targetCpaMicros) : c.maximizeConversions ? micros(c.maximizeConversions.targetCpaMicros) : null,
      live: c.status === "ENABLED",
      editable: { budget: !b.explicitlyShared, cpcCap: c.biddingStrategyType === "TARGET_SPEND", targetCpa: ["MAXIMIZE_CONVERSIONS", "TARGET_CPA"].includes(c.biddingStrategyType) },
      start, period: rows.length ? period : "Since " + start + " (start) to today: no ads shown yet", days: nDays,
      perf: { impr, clicks, cost, conv, is: isDays ? impr / elig : null, lostBudget: isDays ? lostB / elig : null, lostRank: isDays ? lostR / elig : null }
    };
  });
}
app.get("/api/campaigns/compare", async (req, res) => {
  const cid = req.session.customerId;
  if (!req.session.tokens || !cid) return res.status(400).json({ error: "Connect Google Ads and choose an account first." });
  const ids = String(req.query.ids || "").split(",").map(x => x.trim()).filter(x => /^\d+$/.test(x)).slice(0, 10);
  if (ids.length < 2) return res.status(400).json({ error: "Select at least two campaigns to compare." });
  try { res.json({ campaigns: await moneyData(req, cid, ids) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Updates one campaign's money settings (daily budget, max CPC, target CPA) in one request, then re-reads them to verify.
app.post("/api/campaigns/:id/money", async (req, res) => {
  const cid = req.session.customerId, id = req.params.id, body = req.body || {};
  if (!req.session.tokens || !cid) return res.status(400).json({ message: "Connect Google Ads and choose an account first." });
  if (!/^\d+$/.test(id)) return res.status(400).json({ message: "Invalid campaign ID." });
  try {
    const cur = (await moneyData(req, cid, [id]))[0];
    if (!cur) return res.json({ message: "Campaign not found in this account." });
    if (!cur.live) return res.json({ message: cur.name + " is not live, so its amounts can only be changed while it is running." });
    const maxBudget = Number(E.MAX_DAILY_BUDGET) > 0 ? Number(E.MAX_DAILY_BUDGET) : 10000;
    const amt = (v, min, max, label) => { const a = Number(v); if (!isFinite(a) || a < min || a > max) throw Object.assign(new Error(label + " must be between A$" + min + " and A$" + max + "."), { user: true }); return String(Math.round(a * 1e6)); };
    const differs = (v, now) => v != null && v !== "" && (now == null || Math.abs(Number(v) - now) >= 0.005);
    const ops = [], changed = [], campUpd = { resourceName: "customers/" + cid + "/campaigns/" + id }, mask = [];
    if (differs(body.budget, cur.budget)) {
      if (!cur.editable.budget) return res.json({ message: cur.name + ": the budget is shared with other campaigns, so change it in Google Ads." });
      ops.push({ campaignBudgetOperation: { update: { resourceName: cur.budgetResource, amountMicros: amt(body.budget, 1, maxBudget, "Daily budget") }, updateMask: "amount_micros" } });
      changed.push("budget");
    }
    if (differs(body.cpcCap, cur.cpcCap) && cur.editable.cpcCap) { campUpd.targetSpend = { cpcBidCeilingMicros: amt(body.cpcCap, 0.1, 100, "Maximum cost per click") }; mask.push("target_spend.cpc_bid_ceiling_micros"); changed.push("cpcCap"); }
    if (differs(body.targetCpa, cur.targetCpa) && cur.editable.targetCpa) {
      const v = amt(body.targetCpa, 1, 1000, "Target CPA");
      if (cur.bidding === "TARGET_CPA") { campUpd.targetCpa = { targetCpaMicros: v }; mask.push("target_cpa.target_cpa_micros"); }
      else { campUpd.maximizeConversions = { targetCpaMicros: v }; mask.push("maximize_conversions.target_cpa_micros"); }
      changed.push("targetCpa");
    }
    if (mask.length) ops.unshift({ campaignOperation: { update: campUpd, updateMask: mask.join(",") } });
    if (!ops.length) return res.json({ ok: true, changed: [], message: "Nothing changed." });
    const validateOnly = body.validateOnly === true;
    await ads(req, "/customers/" + cid + "/googleAds:mutate", { mutateOperations: ops, partialFailure: false, validateOnly });
    if (validateOnly) return res.json({ ok: true, validated: true, changed });
    const now = (await moneyData(req, cid, [id]))[0];
    const want = { budget: body.budget, cpcCap: body.cpcCap, targetCpa: body.targetCpa };
    const unverified = changed.filter(k => Math.abs(Number(now[k]) - Number(want[k])) >= 0.005);
    console.log(JSON.stringify({ t: new Date().toISOString(), event: "campaign_money", customer: cid, campaign: id, changed, unverified }));
    res.json(unverified.length ? { message: "Google Ads accepted the change but " + unverified.join(", ") + " did not read back as expected. Check it in Google Ads.", now } : { ok: true, changed, now });
  } catch (e) {
    if (e.user) return res.json({ message: e.message });
    console.error("campaign_money failed:", e.message, e.full ? JSON.stringify(e.full) : "");
    res.json({ message: "Not changed. Google Ads said: " + e.message });
  }
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
const campaign = require("./campaign");
const creating = new Set();
// Google's geoTargetConstants:suggest accepts at most 25 location names per call, so batch and merge.
async function resolveGeo(req, names) {
  const map = {};
  for (let i = 0; i < names.length; i += 25) {
    const batch = names.slice(i, i + 25);
    const g = await ads(req, "/geoTargetConstants:suggest", { locale: "en", countryCode: "AU", locationNames: { names: batch } });
    (g.geoTargetConstantSuggestions || []).forEach(x => { const c = x.geoTargetConstant || {}; if (/New South Wales/.test(c.canonicalName || "") && c.resourceName && !map[x.searchTerm]) map[x.searchTerm] = c.resourceName; });
  }
  return map;
}
async function findByName(req, cid, name) {
  const q = "SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.name = '" + name.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "' AND campaign.status != 'REMOVED' LIMIT 1";
  return ((await ads(req, "/customers/" + cid + "/googleAds:search", { query: q })).results || [])[0] || null;
}
// Creates the campaign, ad groups, keywords and ads in ONE atomic Google Ads request, paused, then re-reads it to verify.
app.post("/api/campaigns/create", async (req, res) => {
  const cid = req.session.customerId;
  if (!req.session.tokens || !cid) return res.json({ message: "Connect Google Ads and choose an account first." });
  if (creating.has(req.sessionID)) return res.json({ message: "A creation request is already running." });
  creating.add(req.sessionID);
  let b = req.body || {};
  try {
    b = campaign.validate(b, E.MAX_DAILY_BUDGET);
    const dup = await findByName(req, cid, b.name);
    if (dup) return res.json({ message: "A campaign named “" + b.name + "” already exists in this account (ID " + dup.campaign.id + "). Nothing was created." });
    const geo = await resolveGeo(req, b.suburbs), missing = b.suburbs.filter(s => !geo[s]);
    if (missing.length) return res.json({ message: "These suburbs could not be matched to a Google location, so nothing was created: " + missing.join(", ") + "." });
    const ops = campaign.buildOps(b, cid, geo);
    if (ops.length > 5000) return res.json({ message: "Too many items (" + ops.length + "). Select fewer suburbs or products. Nothing was created." });
    if (b.validateOnly === true) {
      await ads(req, "/customers/" + cid + "/googleAds:mutate", { mutateOperations: ops, partialFailure: false, validateOnly: true });
      return res.json({ ok: true, validated: true, operations: ops.length });
    }
    await ads(req, "/customers/" + cid + "/googleAds:mutate", { mutateOperations: ops, partialFailure: false });
    const c = await findByName(req, cid, b.name);
    if (!c) return res.json({ message: "Google Ads accepted the request but the campaign could not be found afterwards. Check Google Ads before trying again." });
    const id = c.campaign.id, agr = await ads(req, "/customers/" + cid + "/googleAds:search", { query: "SELECT ad_group.id FROM ad_group WHERE campaign.id = " + id + " AND ad_group.status != 'REMOVED'" });
    const kwr = await ads(req, "/customers/" + cid + "/googleAds:search", { query: "SELECT ad_group_criterion.criterion_id FROM ad_group_criterion WHERE campaign.id = " + id + " AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'" });
    const out = { campaignId: id, status: c.campaign.status, adGroups: (agr.results || []).length, keywords: (kwr.results || []).length };
    out.ok = out.status === "PAUSED" && out.adGroups === b.adGroups.length;
    if (!out.ok) out.message = "Campaign " + id + " exists but verification found " + out.adGroups + " ad groups (expected " + b.adGroups.length + ") and status " + out.status + ". Check it in Google Ads.";
    console.log(JSON.stringify({ t: new Date().toISOString(), event: "campaign_create", customer: cid, name: b.name, ok: out.ok, adGroups: out.adGroups, keywords: out.keywords }));
    res.json(out);
  } catch (e) {
    if (e.user) return res.json({ message: e.message });
    let found = null; try { found = await findByName(req, cid, String(b.name || "")); } catch (x) {}
    console.error("campaign_create failed:", e.message, e.full ? JSON.stringify(e.full) : "");
    res.json({ message: found ? "Google Ads reported an error, but a campaign with this name exists (ID " + found.campaign.id + "). Check it in Google Ads before trying again. " + e.message : "Nothing was created. Google Ads said: " + e.message });
  } finally { creating.delete(req.sessionID); }
});
require("./edit")(app, { ads, resolveGeo, campaign, readOptions, E });
app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log("Campaign builder running at " + BASE + (missing.length ? " (setup needed: " + missing.join(", ") + ")" : "")));
