"use strict";
// Edit a live Search campaign from the Campaign builder: read its full setup, work out what the builder changed,
// show that list for confirmation (checked by Google with validateOnly), then apply it in one atomic request.
const { AGE } = require("./campaign");
const AGE_KEY = Object.fromEntries(Object.entries(AGE).map(([k, v]) => [v, k]));
const micros = v => String(Math.round(Number(v) * 1e6));
const money = m => m ? (Number(m) / 1e6).toFixed(2) : "";
const lc = s => String(s || "").trim().toLowerCase();

module.exports = function (app, { ads, resolveGeo, campaign, readOptions, E }) {
  async function readFull(req, cid, id) {
    const q = async s => { let out = [], tok; do { const r = await ads(req, "/customers/" + cid + "/googleAds:search", tok ? { query: s, pageToken: tok } : { query: s }); out = out.concat(r.results || []); tok = r.nextPageToken; } while (tok); return out; };
    const r = (await q("SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.start_date_time, campaign.end_date_time, campaign.target_spend.cpc_bid_ceiling_micros, campaign.campaign_budget, campaign_budget.amount_micros FROM campaign WHERE campaign.id = " + id))[0];
    if (!r) return null;
    const c = r.campaign;
    const locs = (await q("SELECT campaign_criterion.resource_name, campaign_criterion.location.geo_target_constant FROM campaign_criterion WHERE campaign.id = " + id + " AND campaign_criterion.type = 'LOCATION' AND campaign_criterion.negative = FALSE AND campaign_criterion.status != 'REMOVED'"))
      .map(x => ({ resourceName: x.campaignCriterion.resourceName, geo: (x.campaignCriterion.location || {}).geoTargetConstant }));
    const geoIds = locs.map(l => "'" + l.geo + "'").filter(x => x !== "'undefined'");
    const names = {};
    if (geoIds.length) (await q("SELECT geo_target_constant.resource_name, geo_target_constant.name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (" + geoIds.join(",") + ")")).forEach(x => { names[x.geoTargetConstant.resourceName] = x.geoTargetConstant.name; });
    locs.forEach(l => { l.name = names[l.geo] || l.geo; });
    const negatives = (await q("SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text FROM campaign_criterion WHERE campaign.id = " + id + " AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED'"))
      .map(x => ({ resourceName: x.campaignCriterion.resourceName, text: (x.campaignCriterion.keyword || {}).text }));
    const groups = (await q("SELECT ad_group.id, ad_group.resource_name, ad_group.name, ad_group.status, ad_group.cpc_bid_micros FROM ad_group WHERE campaign.id = " + id + " AND ad_group.status != 'REMOVED'"))
      .map(x => ({ id: String(x.adGroup.id), resourceName: x.adGroup.resourceName, name: x.adGroup.name, status: x.adGroup.status, cpc: money(x.adGroup.cpcBidMicros), keywords: [], ads: [], demo: [] }));
    const byId = Object.fromEntries(groups.map(g => [g.id, g]));
    (await q("SELECT ad_group.id, ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE campaign.id = " + id + " AND ad_group_ad.status = 'ENABLED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'")).forEach(x => {
      const g = byId[String(x.adGroup.id)], ad = x.adGroupAd.ad || {}, rsa = ad.responsiveSearchAd || {};
      if (g) g.ads.push({ resourceName: x.adGroupAd.resourceName, url: (ad.finalUrls || [])[0] || "", headlines: (rsa.headlines || []).map(h => h.text), descriptions: (rsa.descriptions || []).map(d => d.text) });
    });
    (await q("SELECT ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE campaign.id = " + id + " AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED'")).forEach(x => {
      const g = byId[String(x.adGroup.id)], k = x.adGroupCriterion.keyword || {};
      if (g) g.keywords.push({ resourceName: x.adGroupCriterion.resourceName, t: lc(k.text), m: k.matchType });
    });
    (await q("SELECT ad_group.id, ad_group_criterion.resource_name, ad_group_criterion.type, ad_group_criterion.gender.type, ad_group_criterion.age_range.type FROM ad_group_criterion WHERE campaign.id = " + id + " AND ad_group_criterion.negative = TRUE AND ad_group_criterion.type IN ('GENDER', 'AGE_RANGE') AND ad_group_criterion.status != 'REMOVED'")).forEach(x => {
      const g = byId[String(x.adGroup.id)], cr = x.adGroupCriterion;
      if (g) g.demo.push({ resourceName: cr.resourceName, key: cr.type === "GENDER" ? "G:" + (cr.gender || {}).type : "A:" + (cr.ageRange || {}).type });
    });
    const enabled = groups.filter(g => g.status === "ENABLED"), demo = new Set(((enabled[0] || groups[0] || {}).demo || []).map(d => d.key));
    const bid = c.biddingStrategyType;
    return {
      id: String(c.id), name: c.name, status: c.status, type: c.advertisingChannelType, bidding: bid,
      budget: money((r.campaignBudget || {}).amountMicros), budgetResource: c.campaignBudget,
      start: (c.startDateTime || "").slice(0, 10), end: c.endDateTime && !c.endDateTime.startsWith("2037-12-30") ? c.endDateTime.slice(0, 10) : "",
      builderBidding: bid === "MANUAL_CPC" ? "MANUAL" : "CLICKS",
      cpc: bid === "MANUAL_CPC" ? ((enabled[0] || {}).cpc || "") : money((c.targetSpend || {}).cpcBidCeilingMicros),
      options: await readOptions(req, cid, id),
      locations: locs, negatives, groups,
      male: !demo.has("G:MALE") && demo.has("G:FEMALE") ? true : false, female: !demo.has("G:FEMALE") && demo.has("G:MALE") ? true : false,
      bands: Object.keys(AGE).filter(k => !demo.has("A:" + AGE[k]))
    };
  }

  // Compares the builder's wanted setup (same shape as create) with the live campaign. Returns Google Ads operations and plain-English changes.
  async function plan(req, cid, cur, b) {
    const C = "customers/" + cid, CAM = C + "/campaigns/" + cur.id, ops = [], changes = [];
    const upd = { resourceName: CAM }, mask = [];
    if (b.name !== cur.name) { upd.name = b.name; mask.push("name"); changes.push("Name: " + cur.name + " → " + b.name); }
    if (Number(b.budget).toFixed(2) !== cur.budget) {
      ops.push({ campaignBudgetOperation: { update: { resourceName: cur.budgetResource, amountMicros: micros(b.budget) }, updateMask: "amount_micros" } });
      changes.push("Daily budget: A$" + cur.budget + " → A$" + Number(b.budget).toFixed(2));
    }
    if ((b.start || "") !== cur.start && b.start) { upd.startDateTime = b.start + " 00:00:00"; mask.push("start_date_time"); changes.push("Start date: " + (cur.start || "none") + " → " + b.start); }
    if ((b.end || "") !== cur.end) { upd.endDateTime = b.end ? b.end + " 23:59:59" : "2037-12-30 23:59:59"; mask.push("end_date_time"); changes.push("End date: " + (cur.end || "none") + " → " + (b.end || "none")); }
    const o = b.opts, co = cur.options;
    if (o.roas) {
      if (!co.roas || Math.round(+o.roasPct) !== co.roasPct) { upd.maximizeConversionValue = { targetRoas: +o.roasPct / 100 }; mask.push("maximize_conversion_value.target_roas"); changes.push("Bidding: Target ROAS " + Math.round(+o.roasPct) + "%"); }
    } else if (b.bidding === "MANUAL") {
      if (cur.bidding !== "MANUAL_CPC") { upd.manualCpc = { enhancedCpcEnabled: false }; mask.push("manual_cpc.enhanced_cpc_enabled"); changes.push("Bidding: " + cur.bidding + " → Manual CPC"); }
    } else if (cur.bidding !== "TARGET_SPEND" || (b.cpc ? Number(b.cpc).toFixed(2) : "") !== cur.cpc) {
      const cpc = b.cpc ? Number(b.cpc).toFixed(2) : "";
      upd.targetSpend = cpc ? { cpcBidCeilingMicros: micros(cpc) } : {}; mask.push("target_spend.cpc_bid_ceiling_micros");
      changes.push(cur.bidding !== "TARGET_SPEND" ? "Bidding: " + cur.bidding + " → Maximise clicks" + (cpc ? " (max CPC A$" + cpc + ")" : "") : "Max cost per click: " + (cur.cpc ? "A$" + cur.cpc : "none") + " → " + (cpc ? "A$" + cpc : "none"));
    }
    if (co.can.aiMax && o.aiMax !== co.aiMax) { upd.aiMaxSetting = { enableAiMax: o.aiMax }; mask.push("ai_max_setting.enable_ai_max"); changes.push("AI Max: " + (o.aiMax ? "Yes" : "No")); }
    if (co.can.networks && o.searchPartners !== co.searchPartners) { upd.networkSettings = Object.assign(upd.networkSettings || {}, { targetSearchNetwork: o.searchPartners }); mask.push("network_settings.target_search_network"); changes.push("Search Network: " + (o.searchPartners ? "Yes" : "No")); }
    if (co.can.networks && o.display !== co.display) { upd.networkSettings = Object.assign(upd.networkSettings || {}, { targetContentNetwork: o.display }); mask.push("network_settings.target_content_network"); changes.push("Display Network: " + (o.display ? "Yes" : "No")); }
    if (mask.length) ops.unshift({ campaignOperation: { update: upd, updateMask: mask.join(",") } });

    // Locations
    const curLoc = new Map(cur.locations.map(l => [lc(l.name), l])), want = new Set(b.suburbs.map(lc));
    const addSubs = b.suburbs.filter(s => !curLoc.has(lc(s)));
    if (addSubs.length) {
      const geo = await resolveGeo(req, addSubs), miss = addSubs.filter(s => !geo[s]);
      if (miss.length) throw Object.assign(new Error("These suburbs could not be matched to a Google location: " + miss.join(", ") + "."), { user: true });
      addSubs.forEach(s => ops.push({ campaignCriterionOperation: { create: { campaign: CAM, location: { geoTargetConstant: geo[s] } } } }));
      changes.push("Add suburbs: " + addSubs.join(", "));
    }
    const rmLoc = cur.locations.filter(l => !want.has(lc(l.name)));
    rmLoc.forEach(l => ops.push({ campaignCriterionOperation: { remove: l.resourceName } }));
    if (rmLoc.length) changes.push("Remove suburbs: " + rmLoc.map(l => l.name).join(", "));

    // Negative keywords
    const curNeg = new Map(cur.negatives.map(n => [lc(n.text), n])), wantNeg = new Set(b.negatives.map(lc));
    const addNeg = b.negatives.filter(n => !curNeg.has(lc(n))), rmNeg = cur.negatives.filter(n => !wantNeg.has(lc(n.text)));
    addNeg.forEach(t => ops.push({ campaignCriterionOperation: { create: { campaign: CAM, negative: true, keyword: { text: t.trim(), matchType: "PHRASE" } } } }));
    rmNeg.forEach(n => ops.push({ campaignCriterionOperation: { remove: n.resourceName } }));
    if (addNeg.length) changes.push("Add negative keywords: " + addNeg.join(", "));
    if (rmNeg.length) changes.push("Remove negative keywords: " + rmNeg.map(n => n.text).join(", "));

    // Audience: excluded genders and age ranges, applied to every ad group.
    const wantDemo = new Set();
    if (b.female && !b.male) wantDemo.add("G:MALE");
    if (b.male && !b.female) wantDemo.add("G:FEMALE");
    if (b.bands.length && b.bands.length < 6) Object.keys(AGE).filter(k => !b.bands.includes(k)).forEach(k => wantDemo.add("A:" + AGE[k]));
    const demoOp = (AG, key) => ({ adGroupCriterionOperation: { create: key.startsWith("G:") ? { adGroup: AG, negative: true, gender: { type: key.slice(2) } } : { adGroup: AG, negative: true, ageRange: { type: key.slice(2) } } } });
    const demoLabel = k => k.startsWith("G:") ? (k === "G:MALE" ? "male" : "female") : AGE_KEY[k.slice(2)];

    // Ad groups: one per product, matched by name.
    const curG = new Map(cur.groups.map(g => [lc(g.name), g])), wantG = new Set(b.adGroups.map(g => lc(g.name)));
    let tmp = 10, demoChanged = false;
    b.adGroups.forEach(g => {
      const ex = curG.get(lc(g.name)), kwWant = new Map(g.keywords.map(k => [k.t + "|" + k.m, k]));
      if (!ex) {
        const AG = C + "/adGroups/-" + (tmp++), ag = { resourceName: AG, name: g.name, campaign: CAM, status: "ENABLED", type: "SEARCH_STANDARD" };
        if (b.bidding === "MANUAL" && !o.roas) ag.cpcBidMicros = micros(b.cpc);
        ops.push({ adGroupOperation: { create: ag } });
        g.keywords.forEach(k => ops.push({ adGroupCriterionOperation: { create: { adGroup: AG, status: "ENABLED", keyword: { text: k.t, matchType: k.m } } } }));
        wantDemo.forEach(k => ops.push(demoOp(AG, k)));
        ops.push({ adGroupAdOperation: { create: { adGroup: AG, status: "ENABLED", ad: { finalUrls: [g.url], responsiveSearchAd: { headlines: g.headlines.map(text => ({ text })), descriptions: g.descriptions.map(text => ({ text })) } } } } });
        changes.push("Add product (ad group) " + g.name + " with " + g.keywords.length + " keyword(s) and an ad");
        return;
      }
      if (ex.status !== "ENABLED") { ops.push({ adGroupOperation: { update: { resourceName: ex.resourceName, status: "ENABLED" }, updateMask: "status" } }); changes.push("Turn on ad group " + ex.name); }
      if (b.bidding === "MANUAL" && !o.roas && b.cpc && Number(b.cpc).toFixed(2) !== ex.cpc) ops.push({ adGroupOperation: { update: { resourceName: ex.resourceName, cpcBidMicros: micros(b.cpc) }, updateMask: "cpc_bid_micros" } });
      const kwCur = new Map(ex.keywords.map(k => [k.t + "|" + k.m, k]));
      const addK = g.keywords.filter(k => !kwCur.has(k.t + "|" + k.m)), rmK = ex.keywords.filter(k => !kwWant.has(k.t + "|" + k.m));
      addK.forEach(k => ops.push({ adGroupCriterionOperation: { create: { adGroup: ex.resourceName, status: "ENABLED", keyword: { text: k.t, matchType: k.m } } } }));
      rmK.forEach(k => ops.push({ adGroupCriterionOperation: { remove: k.resourceName } }));
      if (addK.length || rmK.length) changes.push(ex.name + ": " + [addK.length ? "add " + addK.length + " keyword(s)" : "", rmK.length ? "remove " + rmK.length + " keyword(s) (" + rmK.slice(0, 5).map(k => k.t).join(", ") + (rmK.length > 5 ? "…" : "") + ")" : ""].filter(Boolean).join(", "));
      // Ad text can't be edited in place, so a changed ad is added as a new ad and the old one is paused.
      const ad = ex.ads[0], same = ad && ad.url === g.url && JSON.stringify(ad.headlines) === JSON.stringify(g.headlines) && JSON.stringify(ad.descriptions) === JSON.stringify(g.descriptions);
      if (!same) {
        ops.push({ adGroupAdOperation: { create: { adGroup: ex.resourceName, status: "ENABLED", ad: { finalUrls: [g.url], responsiveSearchAd: { headlines: g.headlines.map(text => ({ text })), descriptions: g.descriptions.map(text => ({ text })) } } } } });
        ex.ads.forEach(a => ops.push({ adGroupAdOperation: { update: { resourceName: a.resourceName, status: "PAUSED" }, updateMask: "status" } }));
        changes.push(ex.name + ": new ad text" + (ad ? " (old ad paused)" : ""));
      }
      const curDemo = new Map(ex.demo.map(d => [d.key, d]));
      wantDemo.forEach(k => { if (!curDemo.has(k)) { ops.push(demoOp(ex.resourceName, k)); demoChanged = true; } });
      ex.demo.forEach(d => { if (!wantDemo.has(d.key)) { ops.push({ adGroupCriterionOperation: { remove: d.resourceName } }); demoChanged = true; } });
    });
    if (demoChanged) changes.push("Audience: exclude " + (wantDemo.size ? [...wantDemo].map(demoLabel).join(", ") : "nobody (all genders and ages)"));
    const rmG = cur.groups.filter(g => g.status === "ENABLED" && !wantG.has(lc(g.name)));
    rmG.forEach(g => ops.push({ adGroupOperation: { update: { resourceName: g.resourceName, status: "PAUSED" }, updateMask: "status" } }));
    if (rmG.length) changes.push("Pause ad groups (products removed): " + rmG.map(g => g.name).join(", "));
    return { ops, changes };
  }

  app.get("/api/campaigns/:id/full", async (req, res) => {
    const cid = req.session.customerId, id = req.params.id;
    if (!req.session.tokens || !cid) return res.status(400).json({ error: "Connect Google Ads and choose an account first." });
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: "Invalid campaign ID." });
    try {
      const f = await readFull(req, cid, id);
      if (!f) return res.json({ error: "Campaign not found in this account." });
      if (f.status !== "ENABLED") return res.json({ error: "Only live campaigns can be edited in the builder." });
      if (f.type !== "SEARCH") return res.json({ error: "Only Search campaigns can be edited in the builder (this one is " + String(f.type).toLowerCase().replace(/_/g, " ") + ")." });
      res.json(f);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // mode "preview": check the changes with Google (nothing saved) and list them. mode "apply": save them, then re-read and confirm nothing is left to change.
  app.post("/api/campaigns/:id/update", async (req, res) => {
    const cid = req.session.customerId, id = req.params.id, mode = (req.body || {}).mode;
    if (!req.session.tokens || !cid) return res.json({ message: "Connect Google Ads and choose an account first." });
    if (!/^\d+$/.test(id) || !["preview", "apply"].includes(mode)) return res.json({ message: "Invalid request." });
    try {
      const b = campaign.validate(Object.assign({}, req.body.campaign), E.MAX_DAILY_BUDGET, { anyName: true });
      const cur = await readFull(req, cid, id);
      if (!cur || cur.status !== "ENABLED") return res.json({ message: "Only live campaigns can be changed here." });
      const p = await plan(req, cid, cur, b);
      if (!p.ops.length) return res.json({ ok: true, changes: [], message: "Nothing has changed." });
      if (p.ops.length > 5000) return res.json({ message: "Too many changes at once (" + p.ops.length + "). Make fewer changes and try again." });
      await ads(req, "/customers/" + cid + "/googleAds:mutate", { mutateOperations: p.ops, partialFailure: false, validateOnly: mode === "preview" });
      if (mode === "preview") return res.json({ ok: true, changes: p.changes });
      const left = (await plan(req, cid, await readFull(req, cid, id), b)).changes;
      console.log(JSON.stringify({ t: new Date().toISOString(), event: "campaign_update", customer: cid, campaign: id, changes: p.changes, unverified: left }));
      res.json(left.length ? { message: "Google Ads accepted the update, but these still differ: " + left.join("; ") + ". Check the campaign in Google Ads." } : { ok: true, changes: p.changes });
    } catch (e) {
      if (e.user) return res.json({ message: e.message });
      console.error("campaign_update failed:", e.message, e.full ? JSON.stringify(e.full) : "");
      res.json({ message: "Not changed. Google Ads said: " + e.message });
    }
  });
};
