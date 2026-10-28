// Compare Campaigns: money settings side by side, editable amounts, predicted results, and a confirmed update with progress.
(function () {
  "use strict";
  var MONTH = 30.4;
  // Used only when a campaign has no activity in the last 12 months (typical local home-improvement search ads).
  var BENCH = { cpc: 4, ctr: 0.05, cvr: 0.07 };
  var data = [], edits = {};

  function money(v) { return v == null || !isFinite(v) ? "n/a" : "A$" + Number(v).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function num(v) { return v == null || !isFinite(v) ? "n/a" : Math.round(v).toLocaleString("en-AU"); }
  function pct(v) { return v == null || !isFinite(v) ? "n/a" : (v * 100).toFixed(1) + "%"; }
  var BID = { TARGET_SPEND: "Maximise clicks", MAXIMIZE_CONVERSIONS: "Maximise conversions", MAXIMIZE_CONVERSION_VALUE: "Maximise conversion value", TARGET_CPA: "Target CPA", TARGET_ROAS: "Target ROAS", MANUAL_CPC: "Manual CPC", TARGET_IMPRESSION_SHARE: "Target impression share" };
  function nice(s) { if (BID[s]) return BID[s]; return String(s || "").toLowerCase().replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); }); }

  // Per-day baseline from Google Ads history, or benchmarks when there is none.
  function baseline(c) {
    var p = c.perf, d = c.days;
    if (d && p.clicks > 0) return { real: true, spend: p.cost / d, cpc: p.cost / p.clicks, ctr: p.clicks / p.impr, cvr: p.conv / p.clicks, is: p.is, lostB: p.lostBudget || 0, lostR: p.lostRank || 0 };
    var b = c.budget || 0;
    return { real: false, spend: b * 0.9, cpc: BENCH.cpc, ctr: BENCH.ctr, cvr: BENCH.cvr, is: null, lostB: 0, lostR: 0 };
  }
  // Simple, explainable model: spend follows the budget only while the campaign is budget-limited; extra spend buys
  // progressively dearer clicks; a lower CPC cap or target CPA trades volume for cost.
  function predict(c, inp) {
    var b = baseline(c), B = inp.budget, B0 = c.budget || B, spend;
    if (!b.real) b.spend = B * 0.9; // no history: assume most of the new budget gets spent at benchmark prices
    var budgetLimited = !b.real || (b.lostB > 0.05) || b.spend >= 0.8 * B0;
    if (!budgetLimited) spend = Math.min(B, b.spend);
    else {
      var util = b.real && B0 > 0 ? Math.min(b.spend / B0, 1) : 0.9;
      spend = B * util;
      if (b.is) spend = Math.min(spend, b.spend * Math.min((b.is + b.lostB) / b.is, 3));
    }
    var k = b.spend > 0 ? spend / b.spend : 1, cpc = b.cpc * Math.pow(k, k > 1 ? 0.35 : 0.15);
    if (inp.cpcCap && c.editable.cpcCap && cpc > inp.cpcCap * 0.85) { var eff = inp.cpcCap * 0.85; spend *= Math.pow(eff / cpc, 2); cpc = eff; }
    var cvr = b.cvr, cpa = cvr > 0 ? cpc / cvr : null;
    if (inp.targetCpa && c.editable.targetCpa && cpa && inp.targetCpa < cpa) { var r = inp.targetCpa / cpa; spend *= Math.pow(r, 1.5); cpc *= Math.pow(r, 0.5); cpa = cpc / cvr; }
    var clicks = cpc > 0 ? spend / cpc : 0, conv = clicks * cvr, impr = b.ctr > 0 ? clicks / b.ctr : 0;
    var is = null;
    if (b.is) { var i0 = b.spend / b.cpc / b.ctr; is = Math.min(b.is * impr / i0, Math.min(b.is + b.lostB + b.lostR, 1)); }
    return { real: b.real, spend: spend * MONTH, clicks: clicks * MONTH, impr: impr * MONTH, conv: conv * MONTH, cpa: conv > 0 ? spend / conv : null, cpc: cpc, ctr: b.ctr, cvr: cvr, is: is };
  }
  function current(c) {
    var p = c.perf, d = c.days || 0, f = d ? MONTH / d : 0;
    return { spend: p.cost * f, clicks: p.clicks * f, impr: p.impr * f, conv: p.conv * f, cpa: p.conv ? p.cost / p.conv : null, cpc: p.clicks ? p.cost / p.clicks : null, ctr: p.impr ? p.clicks / p.impr : null, cvr: p.clicks ? p.conv / p.clicks : null, is: p.is, lostB: p.lostBudget, lostR: p.lostRank };
  }
  function inputs(c) { var e = edits[c.id] || {}; return { budget: num0(e.budget, c.budget), cpcCap: num0(e.cpcCap, c.cpcCap), targetCpa: num0(e.targetCpa, c.targetCpa) }; }
  function num0(v, d) { var n = parseFloat(v); return v != null && v !== "" && isFinite(n) ? n : d; }
  function changes(c) {
    var e = edits[c.id] || {}, out = [];
    [["budget", "Daily budget"], ["cpcCap", "Max CPC"], ["targetCpa", "Target CPA"]].forEach(function (f) {
      if (e[f[0]] == null || e[f[0]] === "" || !c.editable[f[0]]) return;
      var v = parseFloat(e[f[0]]);
      if (isFinite(v) && (c[f[0]] == null || Math.abs(v - c[f[0]]) >= 0.005)) out.push({ key: f[0], label: f[1], from: c[f[0]], to: v });
    });
    return out;
  }
  function delta(now, pred, fmt, lowerIsBetter) {
    if (pred == null || !isFinite(pred)) return '<span class="note">n/a</span>';
    var s = fmt(pred);
    if (now != null && isFinite(now) && now > 0 && Math.abs(pred - now) / now >= 0.01) {
      var up = pred > now, good = lowerIsBetter ? !up : up;
      s += ' <span style="font-size:12px;color:var(' + (good ? "--ok" : "--bad") + ')">' + (up ? "▲" : "▼") + Math.abs((pred - now) / now * 100).toFixed(0) + "%</span>";
    }
    return s;
  }
  function field(c, key) {
    if (!c.live) { var cur = c[key]; return '<span class="note">' + (cur != null ? money(cur) : key === "budget" ? "n/a" : "None") + " · editable for live campaigns only</span>"; }
    if (!c.editable[key]) return '<span class="note">' + (key === "budget" && c.budgetShared ? money(c.budget) + " (shared budget, change in Google Ads)" : key === "budget" ? money(c.budget) : "Not used by " + nice(c.bidding)) + "</span>";
    var v = (edits[c.id] || {})[key];
    if (v == null) v = c[key] != null ? c[key].toFixed(2) : "";
    return '<input type="text" inputmode="decimal" data-cmp="' + c.id + '" data-key="' + key + '" value="' + esc(String(v)) + '" placeholder="' + (key === "targetCpa" ? "No target" : key === "cpcCap" ? "No cap" : "") + '" style="max-width:120px">';
  }
  function render() {
    var cols = data.map(function (c) { return { c: c, now: current(c), pred: predict(c, inputs(c)) }; });
    var row = function (label, fn, cls) { return "<tr" + (cls ? ' class="' + cls + '"' : "") + "><td>" + label + "</td>" + cols.map(function (x) { return "<td>" + fn(x) + "</td>"; }).join("") + "</tr>"; };
    var head = function (t) { return '<tr><th colspan="' + (cols.length + 1) + '" style="background:var(--paper)">' + t + "</th></tr>"; };
    var html = '<div class="tw"><table><thead><tr><th>Campaign</th>' + cols.map(function (x) { return "<th>" + esc(x.c.name) + '<div class="note" style="font-weight:400">' + esc(nice(x.c.status) + " · " + nice(x.c.type) + " · " + nice(x.c.bidding)) + "</div></th>"; }).join("") + "</tr></thead><tbody>" +
      head("Amounts you can change") +
      row("Daily budget (A$)", function (x) { return field(x.c, "budget"); }) +
      row("Max cost per click (A$)", function (x) { return field(x.c, "cpcCap"); }) +
      row("Target cost per conversion, CPA (A$)", function (x) { return field(x.c, "targetCpa"); }) +
      head("From Google Ads: totals since the campaign started") +
      row("Period used", function (x) { return '<span class="note">' + esc(x.c.period) + "</span>"; }) +
      row("Spend", function (x) { return money(x.c.perf.cost); }) +
      row("Impressions", function (x) { return num(x.c.perf.impr); }) +
      row("Clicks", function (x) { return num(x.c.perf.clicks); }) +
      row("Conversions", function (x) { return num(x.c.perf.conv); }) +
      row("Average spend per month while running", function (x) { return money(x.c.days ? x.now.spend : null); }) +
      row("Cost per conversion (CPA)", function (x) { return money(x.now.cpa); }) +
      row("Average cost per click", function (x) { return money(x.now.cpc); }) +
      row("Click-through rate", function (x) { return pct(x.now.ctr); }) +
      row("Conversion rate", function (x) { return pct(x.now.cvr); }) +
      row("Search impression share", function (x) { return pct(x.now.is); }) +
      row("Impression share lost to budget", function (x) { return pct(x.now.lostB); }) +
      row("Impression share lost to ad rank (bids)", function (x) { return pct(x.now.lostR); }) +
      head("Predicted per month with the amounts above (▲▼ compared with its average month while running)") +
      row("Basis", function (x) { return '<span class="note">' + (x.pred.real ? "This campaign's own history" : "Industry benchmarks (no history yet)") + "</span>"; }) +
      row("Spend", function (x) { return delta(x.now.spend, x.pred.spend, money); }) +
      row("Impressions", function (x) { return delta(x.now.impr, x.pred.impr, num); }) +
      row("Clicks", function (x) { return delta(x.now.clicks, x.pred.clicks, num); }) +
      row("Conversions", function (x) { return delta(x.now.conv, x.pred.conv, num); }) +
      row("Cost per conversion (CPA)", function (x) { return delta(x.now.cpa, x.pred.cpa, money, true); }) +
      row("Average cost per click", function (x) { return delta(x.now.cpc, x.pred.cpc, money, true); }) +
      row("Search impression share", function (x) { return delta(x.now.is, x.pred.is, pct); }) +
      "</tbody></table></div>" +
      '<p class="note">Predictions are estimates from each campaign\'s own results (or benchmarks when it has none). Real results depend on competition, season and Google\'s auctions.</p>' +
      '<div class="row" style="margin-top:12px;align-items:center"><div style="flex:0 0 auto"><button class="pri" id="cmp-confirm" type="button">Confirm</button></div><div style="flex:1 1 200px" class="note" id="cmp-pending"></div></div>' +
      '<div id="cmp-progress" hidden style="margin-top:16px"><div style="height:10px;border-radius:99px;background:var(--paper);border:1px solid var(--slat);overflow:hidden"><div id="cmp-bar" style="height:100%;width:0;background:var(--acc);transition:width .3s"></div></div><p id="cmp-status" style="margin:8px 0 0"></p><ul id="cmp-log" class="note" style="margin:6px 0 0;padding-left:18px"></ul></div>';
    var keep = document.activeElement && document.activeElement.dataset ? [document.activeElement.dataset.cmp, document.activeElement.dataset.key, document.activeElement.selectionStart] : null;
    $("#ana-body").innerHTML = html;
    if (keep && keep[0]) { var el = document.querySelector('[data-cmp="' + keep[0] + '"][data-key="' + keep[1] + '"]'); if (el) { el.focus(); try { el.setSelectionRange(keep[2], keep[2]); } catch (e) {} } }
    pending();
  }
  function pending() {
    var n = data.reduce(function (s, c) { return s + changes(c).length; }, 0);
    $("#cmp-pending").textContent = n ? n + " change(s) ready. Click Confirm to review and update Google Ads." : data.some(function (c) { return c.live; }) ? "Edit an amount above to see the predicted effect." : "None of these campaigns is live, so the amounts are read-only. Start a campaign to edit its amounts here.";
    $("#cmp-confirm").disabled = !n;
  }

  window.compareMoney = function (ids) {
    showTab("analysis"); data = []; edits = {};
    $("#ana-sub").textContent = "Fetching campaign data from Google Ads…"; $("#ana-body").innerHTML = '<p class="note">Fetching…</p>';
    fetch("/api/campaigns/compare?ids=" + ids.join(",")).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      data = j.campaigns; anaMode = "money";
      $("#ana-sub").textContent = "Comparing " + data.length + " campaigns: change the amounts to see the predicted effect";
      log("Compared " + data.length + " campaigns"); render();
    }).catch(function (e) { $("#ana-sub").textContent = "Compare Campaigns"; $("#ana-body").innerHTML = '<p class="note">' + esc(e.message || "Could not load the campaigns.") + "</p>"; });
  };

  var timer = null;
  $("#ana-body").addEventListener("input", function (e) {
    var t = e.target; if (!t.dataset || !t.dataset.cmp) return;
    (edits[t.dataset.cmp] = edits[t.dataset.cmp] || {})[t.dataset.key] = t.value.trim();
    clearTimeout(timer); timer = setTimeout(render, 250);
  });
  $("#ana-body").addEventListener("click", function (e) {
    if (e.target.id !== "cmp-confirm") return;
    var list = data.map(function (c) { return { c: c, ch: changes(c) }; }).filter(function (x) { return x.ch.length; });
    if (!list.length) return;
    $("#ana-confirm-body").innerHTML = "<p>Update these campaigns in Google Ads?</p><ul>" + list.map(function (x) {
      return "<li><b>" + esc(x.c.name) + "</b>: " + x.ch.map(function (h) { return esc(h.label + " " + (h.from == null ? "none" : money(h.from)) + " → " + money(h.to)); }).join(", ") + "</li>";
    }).join("") + "</ul>";
    pendFix = { money: list }; $("#anadlg").showModal();
  });
  // Runs after the user confirms in the dialog; the existing OK handler ignores money updates.
  $("#ana-ok").addEventListener("click", function () {
    var pf = pendFix; if (!pf || !pf.money) return;
    $("#anadlg").close(); pendFix = null; run(pf.money);
  }, true);

  function run(list) {
    var total = list.length, done = 0, failed = [];
    $("#cmp-confirm").disabled = true;
    $("#ana-body").querySelectorAll("input[data-cmp]").forEach(function (i) { i.disabled = true; });
    $("#cmp-progress").hidden = false; $("#cmp-log").innerHTML = "";
    var bar = function () { $("#cmp-bar").style.width = Math.round(done / total * 100) + "%"; };
    bar();
    (function next(i) {
      if (i >= total) {
        $("#cmp-bar").style.background = failed.length ? "var(--bad)" : "var(--ok)";
        $("#cmp-status").innerHTML = failed.length ? '<b style="color:var(--bad)">Finished with ' + failed.length + " problem(s).</b> See below." : '<b style="color:var(--ok)">Completed Successfully</b>';
        log(failed.length ? "Campaign update finished with problems" : "Campaign update completed successfully");
        // Reload the figures so the table shows the new amounts, but keep the progress result visible.
        var keep = $("#cmp-progress").outerHTML;
        fetch("/api/campaigns/compare?ids=" + data.map(function (c) { return c.id; }).join(",")).then(function (r) { return r.json(); }).then(function (j) {
          if (j.campaigns) { data = j.campaigns; edits = {}; render(); $("#cmp-progress").outerHTML = keep; }
        });
        return;
      }
      var x = list[i], body = {};
      x.ch.forEach(function (h) { body[h.key] = h.to; });
      $("#cmp-status").textContent = "Updating " + x.c.name + " (" + (i + 1) + " of " + total + ")…";
      fetch("/api/campaigns/" + x.c.id + "/money", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then(function (r) { return r.json(); })
        .catch(function () { return { message: "Could not reach the app server." }; })
        .then(function (j) {
          done++; bar();
          var ok = j.ok;
          if (!ok) failed.push(x.c.name);
          $("#cmp-log").insertAdjacentHTML("beforeend", "<li>" + esc(x.c.name) + ": " + esc(ok ? "updated and verified in Google Ads" : j.message || "not updated") + "</li>");
          next(i + 1);
        });
    })(0);
  }
})();
