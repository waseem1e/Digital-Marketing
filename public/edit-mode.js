// Edit a live campaign in the Campaign builder: load its setup into the page, then send only the confirmed changes to Google Ads.
(function () {
  "use strict";
  var editing = null, origUnion = new Set();
  var bar = document.createElement("div");
  bar.id = "editbar"; bar.hidden = true; bar.className = "panel";
  bar.style.cssText = "margin:16px 24px 0;border-color:var(--acc);display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between";
  $("#view-builder").insertAdjacentElement("afterbegin", bar);

  // Edit button next to Start / Stop / Analyse. Only for one selected live campaign.
  $("#canalyse").closest("div").insertAdjacentHTML("beforebegin", '<div style="flex:0 0 auto"><button id="cedit" type="button" disabled>Edit in Campaign builder</button></div>');
  var origRender = window.renderCamps;
  window.renderCamps = function () { origRender(); var s = selCamps(); $("#cedit").disabled = !(s.length === 1 && s[0].status === "ENABLED"); };
  $("#cedit").addEventListener("click", function () { var s = selCamps(); if (s.length === 1) load(s[0].id); });

  // Keywords: loaded ad groups keep their own keywords (minus any you untick); keywords you add go to every ad group.
  var origGroupKw = window.groupKw;
  window.groupKw = function (p) {
    if (!editing || !p) return origGroupKw(p);
    var sel = kws.filter(function (k) { return kwSel.has(k.t); });
    var extra = sel.filter(function (k) { return !origUnion.has(k.t); });
    var own = p.origKw ? p.origKw.filter(function (k) { return kwSel.has(k.t); }) : sel;
    return (p.origKw ? own.concat(extra) : own).map(function (k) { return { t: k.t, m: k.m }; });
  };

  function title(m) { return String(m || "BROAD").charAt(0) + String(m || "BROAD").slice(1).toLowerCase(); }
  function load(id, keepStatus) {
    log("Loading campaign " + id + " into the builder…");
    fetch("/api/campaigns/" + id + "/full").then(function (r) { return r.json(); }).then(function (f) {
      if (f.error) { $("#cmsg").textContent = f.error; log("Could not load campaign: " + f.error); return; }
      editing = f;
      // Suburbs
      subs.clear();
      f.locations.forEach(function (l) {
        var m = SUBURBS.filter(function (s) { return s.toLowerCase() === String(l.name).toLowerCase(); })[0];
        if (!m) { CODES[l.name] = CODES[l.name] || "----"; SUBURBS = Object.keys(CODES).sort(); m = l.name; }
        subs.add(m);
      });
      // Products = every ad group in the campaign (paused ones unticked), each keeping its live ad text and page.
      prods = prods.filter(function (p) { return !p.temp; });
      prods.forEach(function (p) { p.sel = false; delete p.origKw; delete p.agStatus; });
      var union = {};
      f.groups.forEach(function (g) {
        var p = prods.filter(function (x) { return x.n.toLowerCase() === g.name.toLowerCase(); })[0];
        if (!p) { p = { n: g.name, url: "", temp: true }; prods.push(p); }
        var ad = g.ads[0];
        p.sel = g.status === "ENABLED"; p.n = g.name; p.agStatus = g.status;
        if (ad) { p.url = ad.url || p.url; p.custom = true; p.h = ad.headlines.slice(); p.d = ad.descriptions.slice(); }
        p.origKw = g.keywords.map(function (k) { return { t: k.t, m: title(k.m) }; });
        p.origKw.forEach(function (k) { if (!union[k.t]) union[k.t] = { t: k.t, s: null, comp: null, m: k.m }; });
      });
      kws = Object.keys(union).sort().map(function (t) { return union[t]; });
      kwSel = new Set(kws.map(function (k) { return k.t; }));
      origUnion = new Set(kws.map(function (k) { return k.t; }));
      $("#kwmeta").textContent = kws.length + " keyword(s) loaded from the live campaign. Untick to remove; keywords you add go to every ad group.";
      // Budget, dates, bidding, negatives, audience
      nameEdited = true; $("#cname").value = f.name;
      $("#budget").value = f.budget; if (!(+$("#ceiling").value >= +f.budget)) $("#ceiling").value = f.budget; $("#bconfirm").checked = true;
      $("#budget").dispatchEvent(new Event("input", { bubbles: true }));
      $("#cstartd").value = f.start; $("#enddate").value = f.end;
      $("#bid").value = f.builderBidding; $("#cpc").value = f.cpc;
      $("#neg").value = f.negatives.map(function (n) { return n.text; }).join("\n");
      $("#gm").checked = f.male; $("#gf").checked = f.female;
      var b = f.bands;
      if (b.length === 6 || !b.length) { $("#amin").value = ""; $("#amax").value = ""; }
      else { $("#amin").value = b[0].split(/[-+]/)[0]; $("#amax").value = /\+$/.test(b[b.length - 1]) ? "" : b[b.length - 1].split("-")[1]; }
      // Campaign options
      var o = f.options, yn = function (v) { return v ? "yes" : "no"; };
      $("#o-aimax").value = yn(o.aiMax); $("#o-search").value = yn(o.searchPartners); $("#o-display").value = yn(o.display);
      $("#o-roas").value = yn(o.roas); $("#o-roaspct").value = o.roasPct || 400;
      $("#o-roas").dispatchEvent(new Event("change", { bubbles: true }));
      bar.hidden = false;
      renderBar();
      $("#create").textContent = "Review changes to “" + f.name + "”";
      loading = true; $('input[name="mode"][value="new"]').click(); loading = false;
      if (!keepStatus) $("#cstatus").textContent = "Status: loaded from Google Ads. No changes yet.";
      renderSubs(); renderProds(); renderKw(); touch();
      showTab("builder"); window.scrollTo(0, 0);
      log("Loaded “" + f.name + "” for editing");
    }).catch(function () { log("Could not reach the app server to load the campaign"); });
  }
  function stop() { location.reload(); }
  // Banner: the main campaign plus every ad group, with a tick to keep each one on (unticked = paused).
  function renderBar() {
    var f = editing; if (!f) return;
    var groups = prods.filter(function (p) { return p.agStatus || p.origKw; });
    var added = prods.filter(function (p) { return p.sel && !p.agStatus; });
    bar.innerHTML = '<div style="flex:1 1 100%"><div style="display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:space-between;align-items:center"><div><b>Editing live campaign “' + esc(f.name) + '”</b>' +
      '<div class="note" style="margin:2px 0 0">' + esc("Daily budget A$" + f.budget + " · " + f.locations.length + " suburb(s) · " + f.groups.length + " ad group(s) · started " + (f.start || "n/a") + (f.end ? " · ends " + f.end : "")) + '. Nothing is saved to Google Ads until you click Review changes and confirm.</div></div>' +
      '<div style="flex:0 0 auto"><button type="button" id="editstop">Stop editing</button></div></div>' +
      '<div class="tw" style="margin-top:10px"><table><thead><tr><th>On</th><th>Ad group</th><th>Status in Google Ads</th><th>Keywords</th><th>Ad</th><th>Page</th></tr></thead><tbody>' +
      groups.map(function (p) { var i = prods.indexOf(p); return '<tr><td><input type="checkbox" data-agsel="' + i + '"' + (p.sel ? " checked" : "") + ' aria-label="Keep ' + esc(p.n) + ' on"></td><td>' + esc(p.n) + '</td><td>' + (p.agStatus === "ENABLED" ? "On" : "Paused") + (p.sel !== (p.agStatus === "ENABLED") ? ' <span class="chip warn">' + (p.sel ? "will turn on" : "will pause") + "</span>" : "") + "</td><td>" + (p.origKw ? p.origKw.length : 0) + "</td><td>" + (p.custom && p.h ? p.h.length + " headlines, " + (p.d || []).length + " descriptions" : '<span class="note">No ad yet (uses the template)</span>') + '</td><td><a href="' + esc(p.url || "#") + '" target="_blank" rel="noopener" style="word-break:break-all">' + esc(p.url || "") + "</a></td></tr>"; }).join("") +
      added.map(function (p) { return '<tr><td><input type="checkbox" checked disabled></td><td>' + esc(p.n) + '</td><td><span class="chip warn">new, will be added</span></td><td colspan="3" class="note">Uses the selected keywords and the ad template</td></tr>'; }).join("") +
      "</tbody></table></div></div>";
    $("#editstop").addEventListener("click", stop);
  }
  bar.addEventListener("change", function (e) { var i = e.target.dataset.agsel; if (i === undefined) return; prods[i].sel = e.target.checked; renderProds(); touch(); });
  var origProds = window.renderProds;
  window.renderProds = function () { origProds(); if (editing) renderBar(); };
  // "Create new campaign" starts again from the default page (ends any editing).
  var loading = false;
  // Listen on the radio itself: a click on its label also arrives here, exactly once.
  $('input[name="mode"][value="new"]').addEventListener("click", function () {
    if (loading) return;
    askYes("<p>Start a new campaign? This clears everything on the page and goes back to the default values." + (editing ? " Any changes to “" + esc(editing.name) + "” that you have not confirmed are discarded." : "") + "</p>", function () { location.reload(); });
  });

  // Review = Google checks the changes without saving; the confirmation lists only what changed.
  $("#create").addEventListener("click", function (e) {
    if (!editing) return;
    e.stopImmediatePropagation();
    if (busy) return;
    var skip = /Campaign name must look like|Start Date can’t be in the past|confirm the daily budget/;
    var er = problems().filter(function (x) { return !skip.test(x); });
    $("#errs").innerHTML = er.length ? "<ul><li>" + er.map(esc).join("</li><li>") + "</li></ul>" : "";
    if (er.length) return;
    busy = true; $("#cstatus").textContent = "Status: checking your changes with Google Ads…";
    send("preview").then(function (j) {
      busy = false;
      if (!j.ok) { $("#cstatus").textContent = "Status: " + (j.message || "Google Ads did not accept the changes."); return; }
      if (!j.changes.length) { $("#cstatus").textContent = "Status: nothing has changed compared with Google Ads."; return; }
      $("#cstatus").textContent = "Status: " + j.changes.length + " change(s) ready to confirm.";
      askYes("<p>Update “" + esc(editing.name) + "” in Google Ads with these changes?</p><ul>" + j.changes.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>", apply);
    });
  }, true);
  function send(mode) {
    return fetch("/api/campaigns/" + editing.id + "/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: mode, campaign: payload() }) })
      .then(function (r) { return r.json(); }).catch(function () { busy = false; return { message: "Could not reach the app server." }; });
  }
  function apply() {
    busy = true; $("#create").disabled = true; cprogStart([[0, "Sending your changes to Google Ads"], [60, "Checking the campaign in Google Ads"]]); $("#cstatus").textContent = "Status: updating Google Ads…";
    send("apply").then(function (j) {
      busy = false; $("#create").disabled = false;
      cprogEnd(!!j.ok, j.message);
      $("#cstatus").textContent = j.ok ? "Status: updated in Google Ads and verified by reading it back." : "Status: " + (j.message || "not updated.");
      log(j.ok ? "Updated “" + editing.name + "” in Google Ads (" + j.changes.length + " change(s))" : "Update not completed: " + (j.message || ""));
      if (j.ok) { var id = editing.id; setTimeout(function () { load(id, true); }, 300); }
    });
  }
})();
