"use strict";
// Validation and Google Ads operation builder for creating a Search campaign with one ad group per product.
const AGE = { "18-24": "AGE_RANGE_18_24", "25-34": "AGE_RANGE_25_34", "35-44": "AGE_RANGE_35_44", "45-54": "AGE_RANGE_45_54", "55-64": "AGE_RANGE_55_64", "65+": "AGE_RANGE_65_UP" };
const money = /^\d+(\.\d{1,2})?$/, DATE = /^\d{4}-\d{2}-\d{2}$/, SITE = /^https:\/\/greaterwesternshades\.com\.au(\/\S*)?$/;
const bad = m => { const e = new Error(m); e.user = true; return e; };
const micros = v => String(Math.round(Number(v) * 1e6));
const str = (x, max) => typeof x === "string" && x.trim().length > 0 && x.length <= max;

function validate(b, maxBudget) {
  if (!b || typeof b !== "object") throw bad("Invalid request.");
  if (!/^GWS-\d{8}(-.+)?$/.test(String(b.name || "")) || b.name.length > 255) throw bad("Campaign name is not in the required format.");
  if (!money.test(b.budget || "") || +b.budget <= 0) throw bad("Daily budget is invalid.");
  if (!money.test(b.ceiling || "") || +b.budget > +b.ceiling) throw bad("Daily budget is above the approved ceiling.");
  if (maxBudget && +b.budget > +maxBudget) throw bad("Daily budget is above the limit set on the server (MAX_DAILY_BUDGET).");
  if ((b.start && !DATE.test(b.start)) || (b.end && !DATE.test(b.end))) throw bad("Dates are invalid.");
  if (b.start && b.end && b.start > b.end) throw bad("Start date is after the end date.");
  if (!["CLICKS", "MANUAL"].includes(b.bidding)) throw bad("Bidding strategy is invalid.");
  if (b.cpc && (!money.test(b.cpc) || +b.cpc <= 0)) throw bad("Max cost per click is invalid.");
  if (b.bidding === "MANUAL" && !b.cpc) throw bad("Manual CPC needs a max cost per click.");
  if (b.cpc && +b.cpc > +b.budget) throw bad("Max cost per click is above the daily budget.");
  if (!Array.isArray(b.suburbs) || !b.suburbs.length || b.suburbs.length > 100 || !b.suburbs.every(s => str(s, 60))) throw bad("Select between 1 and 100 suburbs.");
  if (!Array.isArray(b.negatives) || b.negatives.length > 100 || !b.negatives.every(x => str(x, 80) && !/[\[\]"]/.test(x))) throw bad("Negative keywords are invalid.");
  if (!Array.isArray(b.bands) || !b.bands.every(x => AGE[x])) throw bad("Age range is invalid.");
  if (!Array.isArray(b.adGroups) || !b.adGroups.length || b.adGroups.length > 50) throw bad("Select between 1 and 50 products.");
  const names = new Set();
  b.adGroups = b.adGroups.map(g => {
    if (!g || !str(g.name, 255) || names.has(g.name.toLowerCase())) throw bad("Ad group names must be unique.");
    names.add(g.name.toLowerCase());
    if (!SITE.test(g.url || "")) throw bad(g.name + ": the page URL must be on greaterwesternshades.com.au.");
    const H = [...new Set((g.headlines || []).map(x => String(x).trim()))], D = [...new Set((g.descriptions || []).map(x => String(x).trim()))];
    if (H.length < 3 || H.length > 15 || H.some(x => !x || x.length > 30)) throw bad(g.name + ": needs 3 to 15 different headlines of up to 30 characters.");
    if (D.length < 2 || D.length > 4 || D.some(x => !x || x.length > 90)) throw bad(g.name + ": needs 2 to 4 different descriptions of up to 90 characters.");
    const seen = new Set(), kw = [];
    for (const k of g.keywords || []) {
      const t = String((k && k.t) || "").trim().toLowerCase(), m = String((k && k.m) || "").toUpperCase();
      if (!/^[a-z0-9 ]{1,80}$/.test(t) || t.split(" ").length > 10 || !["BROAD", "PHRASE", "EXACT"].includes(m)) throw bad(g.name + ": invalid keyword “" + t + "”.");
      if (!seen.has(t + "|" + m)) { seen.add(t + "|" + m); kw.push({ t, m }); }
    }
    if (!kw.length || kw.length > 500) throw bad(g.name + ": needs 1 to 500 keywords.");
    return { name: g.name.trim(), url: g.url, headlines: H, descriptions: D, keywords: kw };
  });
  return b;
}

// geo: { suburbName: "geoTargetConstants/123" }. All created PAUSED at campaign level; one atomic mutate.
function buildOps(b, cid, geo) {
  const C = "customers/" + cid, BUD = C + "/campaignBudgets/-1", CAM = C + "/campaigns/-2", ops = [];
  ops.push({ campaignBudgetOperation: { create: { resourceName: BUD, name: b.name + " budget", amountMicros: micros(b.budget), deliveryMethod: "STANDARD", explicitlyShared: false } } });
  const camp = { resourceName: CAM, name: b.name, status: "PAUSED", advertisingChannelType: "SEARCH", campaignBudget: BUD,
    networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
    geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE" }, containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING" };
  if (b.bidding === "MANUAL") camp.manualCpc = { enhancedCpcEnabled: false };
  else camp.targetSpend = b.cpc ? { cpcBidCeilingMicros: micros(b.cpc) } : {};
  if (b.start) camp.startDateTime = b.start + " 00:00:00";
  if (b.end) camp.endDateTime = b.end + " 23:59:59";
  ops.push({ campaignOperation: { create: camp } });
  b.suburbs.forEach(s => ops.push({ campaignCriterionOperation: { create: { campaign: CAM, location: { geoTargetConstant: geo[s] } } } }));
  ops.push({ campaignCriterionOperation: { create: { campaign: CAM, language: { languageConstant: "languageConstants/1000" } } } });
  b.negatives.forEach(x => ops.push({ campaignCriterionOperation: { create: { campaign: CAM, negative: true, keyword: { text: x.trim(), matchType: "PHRASE" } } } }));
  const noMale = b.female && !b.male, noFemale = b.male && !b.female;
  const dropAges = b.bands.length && b.bands.length < 6 ? Object.keys(AGE).filter(k => !b.bands.includes(k)) : [];
  b.adGroups.forEach((g, i) => {
    const AG = C + "/adGroups/-" + (10 + i), ag = { resourceName: AG, name: g.name, campaign: CAM, status: "ENABLED", type: "SEARCH_STANDARD" };
    if (b.bidding === "MANUAL") ag.cpcBidMicros = micros(b.cpc);
    ops.push({ adGroupOperation: { create: ag } });
    g.keywords.forEach(k => ops.push({ adGroupCriterionOperation: { create: { adGroup: AG, status: "ENABLED", keyword: { text: k.t, matchType: k.m } } } }));
    if (noMale) ops.push({ adGroupCriterionOperation: { create: { adGroup: AG, negative: true, gender: { type: "MALE" } } } });
    if (noFemale) ops.push({ adGroupCriterionOperation: { create: { adGroup: AG, negative: true, gender: { type: "FEMALE" } } } });
    dropAges.forEach(k => ops.push({ adGroupCriterionOperation: { create: { adGroup: AG, negative: true, ageRange: { type: AGE[k] } } } }));
    const rsa = { headlines: g.headlines.map(text => ({ text })), descriptions: g.descriptions.map(text => ({ text })) };
    ops.push({ adGroupAdOperation: { create: { adGroup: AG, status: "ENABLED", ad: { finalUrls: [g.url], responsiveSearchAd: rsa } } } });
  });
  return ops;
}
module.exports = { validate, buildOps, AGE };
