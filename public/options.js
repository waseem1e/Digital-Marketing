// Analysis page: campaign options (AI Max, Search Network, Display Network, Target ROAS), editable for live campaigns only,
// saved to Google Ads after a confirmation that lists just the changed values. Also locks the suggestion fixes on paused campaigns.
(function () {
  "use strict";
  var LABEL = { aiMax: "Optimise your campaign with AI Max", searchPartners: "Search Network (Google search partners)", display: "Display Network", roas: "Target ROAS" };
  var HELP = { aiMax: "Google finds more searches like yours. E.g. “blinds Penrith” also shows for “window shades near me”.", searchPartners: "Also show ads on sites that use Google search. E.g. search results on a news site.", display: "Also show ads on websites and apps. E.g. a banner on a home-decor blog.", roas: "Bid for sales value, not clicks. E.g. 400% aims for A$400 of sales per A$100 spent." };
  var orig = window.renderAnalysis;
  window.renderAnalysis = function () {
    orig();
    if (anaMode !== "single" || !anaData || !anaData.options) return;
    var o = anaData.options;
    if (!o.live) {
      $("#ana-body").querySelectorAll("input[data-fix],input[data-fixval]").forEach(function (el) { var row = el.closest(".row"); if (row) row.remove(); });
      var ap = $("#ana-apply"); if (ap) ap.closest(".row").outerHTML = '<p class="note" style="margin-top:12px">This campaign is paused, so suggestions can only be applied while it is live.</p>';
    }
    $("#ana-body").insertAdjacentHTML("beforeend", panel(o));
  };
  function yn(v) { return v ? "Yes" : "No"; }
  function sel(key, v, on) {
    if (!on) return '<span class="note">' + yn(v) + "</span>";
    return '<select data-opt="' + key + '" style="max-width:140px"><option value="no"' + (v ? "" : " selected") + '>No</option><option value="yes"' + (v ? " selected" : "") + ">Yes</option></select>";
  }
  function panel(o) {
    var ed = o.live, na = function (k) { return '<span class="note">Not available for ' + esc(String(o.type).toLowerCase().replace(/_/g, " ")) + " campaigns</span>"; };
    var rows = [
      ["aiMax", o.can.aiMax ? sel("aiMax", o.aiMax, ed) : na()],
      ["searchPartners", o.can.networks ? sel("searchPartners", o.searchPartners, ed) : na()],
      ["display", o.can.networks ? sel("display", o.display, ed) : na()],
      ["roas", o.can.roas ? sel("roas", o.roas, ed) + (ed ? ' at <input type="text" inputmode="decimal" data-opt="roasPct" value="' + (o.roasPct || 400) + '" style="max-width:90px"' + (o.roas ? "" : " disabled") + '>%' : o.roas ? " (" + o.roasPct + "%)" : "") : na()]
    ];
    return '<div class="panel" id="opt-panel" style="margin-top:16px"><h3>Campaign options</h3><table><tbody>' +
      rows.map(function (r) { return "<tr><td>" + LABEL[r[0]] + '<div class="note" style="font-weight:400">' + HELP[r[0]] + "</div></td><td>" + r[1] + "</td></tr>"; }).join("") + "</tbody></table>" +
      (ed ? '<div class="row" style="margin-top:12px;align-items:center"><div style="flex:0 0 auto"><button class="pri" id="opt-confirm" type="button" disabled>Confirm</button></div><div class="note" style="flex:1 1 200px" id="opt-pending">Change an option above, then click Confirm.</div></div>' +
        '<div id="opt-progress" hidden style="margin-top:12px"><div style="height:10px;border-radius:99px;background:var(--paper);border:1px solid var(--slat);overflow:hidden"><div id="opt-bar" style="height:100%;width:0;background:var(--acc);transition:width .3s"></div></div><p id="opt-status" style="margin:6px 0 0"></p></div>'
        : '<p class="note">This campaign is paused, so its options are read-only. They become editable while it is live.</p>') + "</div>";
  }
  function wanted() {
    var o = anaData.options, w = {}, get = function (k) { var el = document.querySelector('[data-opt="' + k + '"]'); return el ? el.value : null; };
    ["aiMax", "searchPartners", "display", "roas"].forEach(function (k) { var v = get(k); if (v != null) w[k] = v === "yes"; });
    if (w.roas) w.roasPct = parseFloat(get("roasPct"));
    var ch = [];
    ["aiMax", "searchPartners", "display"].forEach(function (k) { if (k in w && w[k] !== o[k]) ch.push(LABEL[k] + ": " + yn(o[k]) + " → " + yn(w[k])); });
    if ("roas" in w && (w.roas !== o.roas || (w.roas && w.roasPct !== o.roasPct)))
      ch.push(LABEL.roas + ": " + (o.roas ? o.roasPct + "%" : "No") + " → " + (w.roas ? w.roasPct + "%" : "No (switches to Maximise conversions)"));
    return { body: w, changes: ch };
  }
  function refresh() {
    var w = wanted(), btn = $("#opt-confirm"); if (!btn) return;
    var pct = document.querySelector('[data-opt="roasPct"]'); if (pct) pct.disabled = !w.body.roas;
    btn.disabled = !w.changes.length;
    $("#opt-pending").textContent = w.changes.length ? w.changes.length + " change(s) ready. Click Confirm to review." : "Change an option above, then click Confirm.";
  }
  $("#ana-body").addEventListener("change", function (e) { if (e.target.dataset && e.target.dataset.opt) refresh(); });
  $("#ana-body").addEventListener("input", function (e) { if (e.target.dataset && e.target.dataset.opt) refresh(); });
  $("#ana-body").addEventListener("click", function (e) {
    if (e.target.id !== "opt-confirm") return;
    var w = wanted(); if (!w.changes.length) return;
    if (w.body.roas && !(w.body.roasPct >= 10 && w.body.roasPct <= 10000)) { $("#opt-pending").textContent = "Target ROAS must be between 10% and 10000%."; return; }
    $("#ana-confirm-body").innerHTML = "<p>Update “" + esc(anaData.name) + "” in Google Ads?</p><ul>" + w.changes.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>";
    pendFix = { options: w.body, id: anaData.id }; $("#anadlg").showModal();
  });
  $("#ana-ok").addEventListener("click", function () {
    var pf = pendFix; if (!pf || !pf.options) return;
    $("#anadlg").close(); pendFix = null; save(pf.id, pf.options);
  }, true);
  function save(id, body) {
    var p = 0, t = setInterval(function () { p += (90 - p) * 0.15; $("#opt-bar").style.width = p.toFixed(0) + "%"; }, 200);
    $("#opt-confirm").disabled = true;
    document.querySelectorAll("[data-opt]").forEach(function (el) { el.disabled = true; });
    $("#opt-progress").hidden = false; $("#opt-bar").style.background = "var(--acc)"; $("#opt-status").textContent = "Updating Google Ads…";
    fetch("/api/campaigns/" + id + "/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).catch(function () { return { message: "Could not reach the app server." }; })
      .then(function (j) {
        clearInterval(t);
        if (j.ok && j.options) anaData.options = j.options;
        if (j.ok) { renderAnalysis(); }
        $("#opt-progress").hidden = false; $("#opt-bar").style.width = "100%";
        $("#opt-bar").style.background = j.ok ? "var(--ok)" : "var(--bad)";
        $("#opt-status").innerHTML = j.ok ? '<b style="color:var(--ok)">Completed Successfully</b>' : '<b style="color:var(--bad)">Not updated.</b> ' + esc(j.message || "");
        log(j.ok ? "Campaign options updated for campaign " + id : "Campaign options not updated: " + (j.message || ""));
        if (!j.ok) { document.querySelectorAll("[data-opt]").forEach(function (el) { el.disabled = false; }); refresh(); }
      });
  }
})();
