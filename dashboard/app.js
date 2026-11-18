// Launch Radar page: renders board, detail and method views from
// window.RADAR_DATA, which main.ts wrote with the same model.js that
// priced board.json. Filters and the slice math recompute live here,
// so the screen and the board file agree by construction.
(function () {
  "use strict";
  var D = window.RADAR_DATA;
  var M = window.RadarModel;
  if (!D || !M) { document.body.innerHTML = "<p style='padding:20px'>Data missing.</p>"; return; }

  // Board state lives in the URL hash (the filtered board is a link you can
  // send); query params still work for old links. Hash wins when both
  // are present. The view (board / detail / method) stays in the query
  // string, so a detail link still loads the protocol it names.
  function readParams() {
    var h = (location.hash || "").replace(/^#/, "");
    if (h) return new URLSearchParams(h);
    return new URLSearchParams(location.search);
  }
  var params = readParams();
  var view = params.get("view") || "board";
  var state = {
    tab: params.get("tab") || "board",
    search: params.get("q") || "",
    cat: params.get("cat") || "",
    chain: params.get("chain") || "",
    verdict: params.get("verdict") || "",
    watchlistOnly: params.get("wl") === "1",
    minTvl: +(params.get("mintvl") || 0),
    capital: +(params.get("cap") || D.sliceCapital),
    share: +(params.get("share") || D.airdropShare),
    sortKey: params.get("sort") || "rank",
    sortDir: params.get("dir") === "desc" ? -1 : 1,
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function money(x) { return M.fmtMoney(x); }
  function signed(x) { return M.fmtSigned(x); }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }
  function ageText(r) {
    if (!r.listed_at) return "—";
    var days = Math.round(r.age_years * 365.25);
    return r.age_years < 1 ? days + "d" : r.age_years.toFixed(1) + "y";
  }
  function changeText(r) {
    if (r.change_7d === null || r.change_7d === undefined) return "—";
    var v = r.change_7d;
    return (v > 0 ? "+" : "") + v.toFixed(1) + "%";
  }
  // Slice economics recomputed live from capital and airdrop share.
  // Same formula as the build: the deployed capital is the user's cap,
  // scaled down by TVL (1bp of TVL, $500 to the cap) exactly as the
  // build does, so at the default cap this is the build's capital and
  // the page and board.json agree. The income forgone is only the
  // T-bill spread over the deposit's own yield. The verdict is
  // break-even odds: the launch probability the farm needs to cover its
  // costs. Worth farming at 10% or better, marginal at 25% or better,
  // else skip; a 7-day TVL fall past -30% caps it at marginal.
  function econ(r) {
    var cap = Math.min(state.capital, Math.max(500, r.tvl_usd / 10000));
    var slice = cap * (r.implied_value_usd / (r.tvl_usd + cap)) * state.share;
    var tbill = cap * (D.tbillYear - (D.depositYieldYear || 0)) * D.farmDays / 365;
    var net = slice - r.fees_usd - tbill;
    var odds = (r.fees_usd + tbill) / slice;
    var verdict = odds <= 0.10 ? "Worth farming" : (odds <= 0.25 ? "Marginal" : "Skip");
    if (verdict === "Worth farming" && r.change_7d !== null && r.change_7d !== undefined && r.change_7d < -30) verdict = "Marginal";
    return { slice: slice, tbill: tbill, net: net, odds: odds, verdict: verdict, netPerHour: net / (r.farm_minutes / 60), capital: cap };
  }
  function verdictClass(v) { return "v-" + v.replace(/\s+/g, "-"); }

  // board.json = this page, checked live: the model re-runs buildBoard on
  // the snapshot embedded in data.js and every rank, value, band, verdict
  // and net is compared with the rows the page shows. Runs once; the
  // result is cached because the build is deterministic.
  var verifyCache = null;
  function verifyBoard() {
    if (verifyCache) return verifyCache;
    var n = D.rows.length;
    var out = { text: "", ok: false };
    if (!window.RADAR_SNAPSHOT || !M.buildBoard) {
      out.text = "board.json = this page — no snapshot embedded, re-run unavailable";
    } else {
      var rebuilt;
      try { rebuilt = M.buildBoard(window.RADAR_SNAPSHOT); } catch (e) { rebuilt = null; }
      if (!rebuilt) {
        out.text = "board.json = this page — re-run failed in this browser";
      } else {
        var match = { rank: 0, value: 0, band: 0, verdict: 0, net: 0 };
        var bySlug = {};
        rebuilt.rows.forEach(function (r) { bySlug[r.slug] = r; });
        D.rows.forEach(function (r) {
          var q = bySlug[r.slug];
          if (!q) return;
          if (q.rank === r.rank) match.rank++;
          if (q.implied_value_usd === r.implied_value_usd) match.value++;
          if (q.p10_usd === r.p10_usd && q.p25_usd === r.p25_usd && q.p75_usd === r.p75_usd && q.p90_usd === r.p90_usd) match.band++;
          if (q.verdict === r.verdict) match.verdict++;
          // Nets are compared to the cent, the precision the page shows:
          // Node and Chromium differ by ~1e-13 dollars on three rows
          // (last-ULP Math.pow/log10 drift between V8 builds), which no
          // displayed figure can show. Ranks, values, bands and verdicts
          // must match exactly.
          if (Math.abs(q.net_usd - r.net_usd) < 0.01) match.net++;
        });
        out.ok = match.rank === n && match.value === n && match.band === n && match.verdict === n && match.net === n;
        out.text = "board.json = this page — buildBoard re-run in your browser: " + match.rank + "/" + n + " ranks, " + match.value + "/" + n + " values, " + match.band + "/" + n + " bands, " + match.verdict + "/" + n + " verdicts and " + match.net + "/" + n + " nets match (to the cent)";
      }
    }
    verifyCache = out;
    return out;
  }

  // ---- scatter (log-log SVG) ----
  function scatter(el, opts) {
    var W = 440, H = 250, PL = 44, PR = 8, PT = 10, PB = 26;
    var x0 = 6, x1 = 11, y0 = 5, y1 = 11; // log10 dollars
    function X(v) { return PL + (Math.log10(v) - x0) / (x1 - x0) * (W - PL - PR); }
    function Y(v) { return H - PB - (Math.log10(v) - y0) / (y1 - y0) * (H - PT - PB); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img">';
    var gx, gy;
    for (gx = 7; gx <= 11; gx++) {
      s += '<line x1="' + X(Math.pow(10, gx)) + '" y1="' + PT + '" x2="' + X(Math.pow(10, gx)) + '" y2="' + (H - PB) + '" stroke="#22272f"/>';
      var anchor = gx === 11 ? "end" : "middle";
      s += '<text x="' + X(Math.pow(10, gx)) + '" y="' + (H - 8) + '" fill="#9aa3ad" font-size="9" text-anchor="' + anchor + '">$' + (gx >= 9 ? (Math.pow(10, gx - 9)) + "B" : (Math.pow(10, gx - 6)) + "M") + "</text>";
    }
    for (gy = 6; gy <= 11; gy++) {
      s += '<line x1="' + PL + '" y1="' + Y(Math.pow(10, gy)) + '" x2="' + (W - PR) + '" y2="' + Y(Math.pow(10, gy)) + '" stroke="#22272f"/>';
      s += '<text x="' + (PL - 4) + '" y="' + (Y(Math.pow(10, gy)) + 3) + '" fill="#9aa3ad" font-size="9" text-anchor="end">$' + (gy >= 9 ? (Math.pow(10, gy - 9)) + "B" : (Math.pow(10, gy - 6)) + "M") + "</text>";
    }
    // fitted curve (before family offsets), dashed
    var d = "", t;
    for (t = 0; t <= 20; t++) {
      var tvl = Math.pow(10, x0 + (x1 - x0) * t / 20);
      var mv = Math.pow(10, D.curve.a + D.curve.b * Math.log10(tvl));
      d += (t === 0 ? "M" : "L") + X(tvl).toFixed(1) + " " + Y(Math.max(mv, 1e5)).toFixed(1) + " ";
    }
    s += '<path d="' + d + '" fill="none" stroke="#e8e6df" stroke-width="1.2" stroke-dasharray="4 3"/>';
    D.curvePoints.forEach(function (q) {
      if (q.tvl < 1e6 || q.mcap < 1e5) return;
      s += '<circle cx="' + X(q.tvl).toFixed(1) + '" cy="' + Y(q.mcap).toFixed(1) + '" r="2" fill="#8a939e"/>';
    });
    (opts.board !== false ? D.boardPoints : []).forEach(function (q) {
      if (q.tvl < 1e6 || q.implied < 1e5) return;
      s += '<circle cx="' + X(q.tvl).toFixed(1) + '" cy="' + Y(q.implied).toFixed(1) + '" r="2" fill="#e8a33d"/>';
    });
    if (opts.highlight) {
      var h = opts.highlight;
      s += '<circle cx="' + X(h.tvl).toFixed(1) + '" cy="' + Y(h.implied).toFixed(1) + '" r="6" fill="none" stroke="#e8a33d" stroke-width="2"/>';
      s += '<circle cx="' + X(h.tvl).toFixed(1) + '" cy="' + Y(h.implied).toFixed(1) + '" r="3.5" fill="#e8a33d"/>';
    }
    if (opts.peers) {
      opts.peers.forEach(function (q) {
        s += '<circle cx="' + X(q.tvl).toFixed(1) + '" cy="' + Y(q.mcap).toFixed(1) + '" r="3" fill="#4cc38a"/>';
      });
    }
    s += "</svg>";
    el.innerHTML = s;
  }

  // ---- board view ----
  function renderBoard() {
    $("topsub").textContent = "DefiLlama snapshot " + D.asOf + ". " + D.totalProtocols + " protocols over $5M TVL. One model.js prices the page and board.json.";
    $("badge-watch").textContent = "Watchlist " + D.watchlistCovered + "/" + D.watchlistCount + " on board";
    $("badge-page").textContent = "Page = board.json " + D.rows.length + "/" + D.rows.length + " rows";
    $("hero-title").textContent = D.rows.length + " protocols record no token. Here is what each launch would be worth, and what farming it costs.";
    $("hero-text").textContent = "Each value is read off a curve fitted to the " + D.curve.n + " tokens that already trade, then adjusted for family, for 7-day TVL growth carried two weeks forward, and for days tracked — a bounded prior that discounts young protocols up to 40%. No name is hand-picked. Every row has a farm plan with a dollar cost and minutes per step, netted against the T-bill yield less the deposit's own yield: only the 0.5% spread is forgone, because the deposit earns while it farms.";
    var st = $("hero-stats");
    st.innerHTML =
      '<div class="stat"><b>' + D.rows.length + '</b><span>ranked, no token</span></div>' +
      '<div class="stat"><b>' + D.tradedCount + '</b><span>token trades, kept apart</span></div>' +
      '<div class="stat"><b>' + D.setAsideCount + '</b><span>set aside by house rule</span></div>' +
      '<div class="stat"><b class="g">' + D.counts.farm + '</b><span>worth farming at $5.0K</span></div>' +
      '<div class="stat"><b class="y">' + D.counts.thin + '</b><span>marginal</span></div>' +
      '<div class="stat"><b class="r">' + D.counts.skip + '</b><span>skip at $5.0K</span></div>';
    var per100 = D.curve.per100m;
    $("formula").textContent = "value = 10^" + (Math.log10(per100)).toFixed(2) + " x (TVL/$100M)^" + D.curve.b.toFixed(3) + " x family x growth\nx seasoning x sibling";
    var v = D.validation;
    $("validation-mini").innerHTML =
      "<tr><td>Blind miss (leave-one-out)</td><td>x" + v.looMedian.toFixed(2) + " (" + v.looMeanAbsLog.toFixed(3) + ") vs x" + v.flatMedian.toFixed(2) + " (" + v.flatMeanAbsLog.toFixed(3) + ") flat</td></tr>" +
      "<tr><td>Time split (pre-2024 fit)</td><td>x" + (v.timeCurveMedian || 0).toFixed(2) + " vs x" + (v.timeFlatMedian || 0).toFixed(2) + " flat, " + v.timeTest + " newer</td></tr>" +
      "<tr><td>Within 3x of real cap</td><td>" + pct(v.looWithin3) + " vs " + pct(v.flatWithin3) + " flat</td></tr>" +
      "<tr><td>Blind 50% / 80% band</td><td>x" + v.band50.toFixed(2) + " / x" + v.band80.toFixed(2) + "</td></tr>";
    var best = D.bestNetPerHour.map(function (r) { return r.name + " " + signed(r.netPerHour) + "/h"; }).join(" · ");
    $("best-net").textContent = "Best net per hands-on hour, watchlist: " + best + ".";
    var verify = verifyBoard();
    $("verify-line").textContent = "✓ " + verify.text;
    scatter($("scatter-main"), {});
    $("scatter-note").textContent = "Grey: " + D.curve.n + " traded tokens, market cap on TVL. Amber: the board at its implied value. Line: the size curve before family offsets.";

    // tabs
    var tabs = [
      ["board", "No token yet " + D.rows.length],
      ["traded", "Token trades " + D.tradedCount],
      ["setaside", "Set aside " + D.setAsideCount],
      ["method", "Method and backtest"],
    ];
    $("tabs").innerHTML = tabs.map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (state.tab === t[0] ? "on" : "") + '">' + t[1] + "</button>";
    }).join("");
    Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) {
      b.addEventListener("click", function () { state.tab = b.getAttribute("data-tab"); syncUrl(); renderBoardTable(); renderTabs(); });
    });
    // filter selects
    var cats = [], chains = [];
    D.rows.forEach(function (r) {
      if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
      (r.chains || []).forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
    });
    cats.sort(); chains.sort();
    $("f-cat").innerHTML = '<option value="">All</option>' + cats.map(function (c) { return '<option' + (state.cat === c ? " selected" : "") + ">" + esc(c) + "</option>"; }).join("");
    $("f-chain").innerHTML = '<option value="">All</option>' + chains.map(function (c) { return '<option' + (state.chain === c ? " selected" : "") + ">" + esc(c) + "</option>"; }).join("");
    $("f-search").value = state.search;
    $("f-verdict").value = state.verdict;
    $("f-tvlf").value = String(state.minTvl);
    $("f-cap").value = String(state.capital);
    $("f-share").value = String(state.share);
    $("f-wl").checked = state.watchlistOnly;
    // filter selects (bound once; renderBoard runs again on back-links)
    if (!renderBoard.bound) {
      renderBoard.bound = true;
      ["f-search", "f-cat", "f-chain", "f-verdict", "f-tvlf", "f-cap", "f-share"].forEach(function (id) {
        $(id).addEventListener("input", function () {
          state.search = $("f-search").value;
          state.cat = $("f-cat").value; state.chain = $("f-chain").value;
          state.verdict = $("f-verdict").value; state.minTvl = +$("f-tvlf").value;
          state.capital = +$("f-cap").value; state.share = +$("f-share").value;
          syncUrl(); renderBoardTable();
        });
      });
      $("f-wl").addEventListener("change", function () {
        state.watchlistOnly = $("f-wl").checked;
        syncUrl(); renderBoardTable();
      });
      $("f-reset").addEventListener("click", function () {
        state.search = ""; state.cat = ""; state.chain = ""; state.verdict = ""; state.watchlistOnly = false; state.minTvl = 0;
        state.capital = D.sliceCapital; state.share = D.airdropShare;
        syncUrl(); renderBoard();
      });
    }
    renderBoardTable();
    renderTabs();
    $("board-foot").textContent = "Slice up to " + money(state.capital) + " at " + Math.round(state.share * 100) + "% of value (the deposit scales with TVL: 1bp of TVL, $500 to the cap), " + D.farmDays + " days, T-bill " + Math.round(D.tbillYear * 100) + "% less the deposit's " + (D.depositYieldYear * 100).toFixed(1) + "% yield. Gas by chain, stated in each plan. A record is not proof: DefiLlama records no token, so check your own channels before farming.";
    $("foot").textContent = "Launch Radar. Snapshot " + D.asOf + " from DefiLlama. Model: log10(mcap) = " + D.curve.a.toFixed(4) + " + " + D.curve.b.toFixed(4) + " x log10(TVL), fitted to " + D.curve.n + " traded tokens. Board " + D.rows.length + " rows, watchlist " + D.watchlistCovered + "/" + D.watchlistCount + ".";
  }

  function renderTabs() {
    Array.prototype.forEach.call($("tabs").querySelectorAll("button"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-tab") === state.tab);
    });
    $("filters").style.display = state.tab === "board" ? "" : "none";
    $("board").style.display = state.tab === "board" ? "" : "none";
    if (state.tab === "method") { showView("method"); renderMethod(); return; }
    showView("board");
    if (state.tab === "traded") renderTraded();
    else if (state.tab === "setaside") renderSetAside();
    else renderBoardTable();
  }

  function showView(v) {
    $("view-board").hidden = v !== "board";
    $("view-detail").hidden = v !== "detail";
    $("view-method").hidden = v !== "method";
  }

  function filteredRows() {
    var q = state.search.trim().toLowerCase();
    var rows = D.rows.filter(function (r) {
      if (q && (r.name + " " + (r.category || "") + " " + (r.chains || []).join(" ")).toLowerCase().indexOf(q) < 0) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.verdict && econ(r).verdict !== state.verdict) return false;
      if (state.watchlistOnly && !r.watchlist) return false;
      if (state.minTvl && r.tvl_usd < state.minTvl) return false;
      return true;
    });
    var k = state.sortKey, dir = state.sortDir;
    var val = function (r) {
      if (k === "rank") return r.rank;
      if (k === "name") return r.name;
      if (k === "tvl") return r.tvl_usd;
      if (k === "change") return r.change_7d === null ? -999 : r.change_7d;
      if (k === "age") return r.age_years;
      if (k === "implied") return r.implied_value_usd;
      if (k === "slice") return econ(r).slice;
      if (k === "net") return econ(r).net;
      if (k === "odds") return econ(r).odds;
      if (k === "nph") return econ(r).netPerHour;
      return r.rank;
    };
    rows.sort(function (a, b) {
      var va = val(a), vb = val(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return a.slug < b.slug ? -1 : 1;
    });
    return rows;
  }

  function renderChips() {
    var chips = [];
    function chip(label, clear) {
      chips.push({ label: label, clear: clear });
    }
    if (state.search) chip("Search: " + state.search, function () { state.search = ""; });
    if (state.cat) chip(state.cat, function () { state.cat = ""; });
    if (state.chain) chip(state.chain, function () { state.chain = ""; });
    if (state.verdict) chip(state.verdict, function () { state.verdict = ""; });
    if (state.watchlistOnly) chip("Watchlist", function () { state.watchlistOnly = false; });
    if (state.minTvl) chip("TVL ≥ " + money(state.minTvl), function () { state.minTvl = 0; });
    if (state.sortKey !== "rank") chip("Sort: " + state.sortKey + (state.sortDir === -1 ? " ↓" : " ↑"), function () { state.sortKey = "rank"; state.sortDir = 1; });
    var el = $("chips");
    el.innerHTML = chips.map(function (c, i) {
      return '<button class="chip" data-i="' + i + '">' + esc(c.label) + " ×</button>";
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll(".chip"), function (b) {
      b.addEventListener("click", function () {
        chips[+b.getAttribute("data-i")].clear();
        syncUrl(); renderBoard();
      });
    });
  }

  function renderBoardTable() {
    if (state.tab !== "board") { $("list-alt").innerHTML = ""; return; }
    var rows = filteredRows();
    $("shown").textContent = rows.length + " shown";
    renderChips();
    $("board-body").innerHTML = rows.map(function (r) {
      var e = econ(r);
      var tags = (r.watchlist ? '<span class="tag wl">Watchlist</span>' : "") + (r.age_years < 1 ? '<span class="tag early">Early</span>' : "");
      // Full P10-P90 interval on a log scale, with a tick at the point
      // estimate. The interval is wide because launches are genuinely
      // uncertain; the bar shows it instead of hiding it.
      var lo = Math.log10(r.p10_usd), hi = Math.log10(r.p90_usd);
      var tick = hi > lo ? Math.max(0, Math.min(100, (Math.log10(r.implied_value_usd) - lo) / (hi - lo) * 100)) : 50;
      return "<tr>" +
        "<td class='num'>" + r.rank + "</td>" +
        "<td><a href='?view=detail&slug=" + encodeURIComponent(r.slug) + "' class='proto'>" + esc(r.name) + "</a>" + tags +
        "<small>" + esc(r.category || "—") + " · " + esc((r.chains || []).join(", ")) + "</small></td>" +
        "<td class='num'>" + money(r.implied_value_usd) + "<br><span class='fine'>" + money(r.p10_usd) + " – " + money(r.p90_usd) + "</span>" +
        "<span class='rangebar'><i style='left:0;width:100%'></i><b style='left:" + tick.toFixed(0) + "%'></b></span></td>" +
        "<td class='num'>" + money(r.tvl_usd) + "</td>" +
        "<td class='num'>" + changeText(r) + "</td>" +
        "<td class='num'>" + ageText(r) + "</td>" +
        "<td class='num'>" + (e.odds * 100).toFixed(0) + "%</td>" +
        "<td class='num'>" + signed(e.net) + "<br><span class='fine'>" + signed(e.netPerHour) + "/h · slice " + money(e.slice) + "</span></td>" +
        "<td><span class='" + verdictClass(e.verdict) + "'>" + e.verdict + "</span></td>" +
        "<td>" + esc(r.farm_method) + " · " + esc(r.farm_chain || (r.chains || [])[0] || "") + "<br><span class='fine'>" + money(r.farm_cost_usd) + " fees · " + (r.farm_minutes / 60).toFixed(1) + "h work</span></td>" +
        "</tr>";
    }).join("");
    $("list-alt").innerHTML = "";
    Array.prototype.forEach.call(document.querySelectorAll("#board th[data-sort]"), function (th) {
      th.onclick = function () {
        var k = th.getAttribute("data-sort");
        if (state.sortKey === k) state.sortDir = -state.sortDir;
        else { state.sortKey = k; state.sortDir = k === "name" ? 1 : -1; }
        syncUrl(); renderBoardTable();
      };
    });
  }

  function renderTraded() {
    $("list-alt").innerHTML = "<p class='fine'>Protocols whose token already trades, kept apart from the board. Market cap on TVL is what the curve is fitted to.</p>" +
      "<table class='board'><thead><tr><th>Protocol</th><th class='num'>TVL</th><th class='num'>Market cap</th><th class='num'>Mcap / TVL</th></tr></thead><tbody>" +
      D.tradedRows.map(function (r) {
        return "<tr><td class='proto'>" + esc(r.name) + "<small>" + esc(r.category || "—") + " · " + esc((r.chains || []).join(", ")) + "</small></td>" +
          "<td class='num'>" + money(r.tvl_usd) + "</td><td class='num'>" + (r.mcap_usd ? money(r.mcap_usd) : "—") + "</td>" +
          "<td class='num'>" + (r.mcap_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + "x" : "—") + "</td></tr>";
      }).join("") + "</tbody></table>";
    $("board-body").innerHTML = "";
  }

  function renderSetAside() {
    $("list-alt").innerHTML = "<p class='fine'>Set aside by house rule: these cannot launch a token of their own, so they never reach the board. Counted openly, not hidden — the <a href='?view=method'>Method</a> page lists the count per reason. A protocol matching two rules is counted under the first.</p>" +
      "<table class='board'><thead><tr><th>Protocol</th><th class='num'>TVL</th><th>Reason</th></tr></thead><tbody>" +
      D.setAside.map(function (r) {
        return "<tr><td class='proto'>" + esc(r.name) + "<small>" + esc(r.category || "—") + " · " + esc((r.chains || []).join(", ")) + "</small></td>" +
          "<td class='num'>" + money(r.tvl_usd) + "</td><td>" + esc(r.reason) + "</td></tr>";
      }).join("") + "</tbody></table>";
    $("board-body").innerHTML = "";
  }

  // ---- detail view ----
  function renderDetail(slug) {
    var r = null;
    D.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    showView("detail");
    if (!r) { $("detail").innerHTML = "<p>Not on the board.</p>"; return; }
    var e = econ(r);
    $("detail-crumb").textContent = "Rank " + r.rank + " of " + D.rows.length + " · " + (r.watchlist ? "Watchlist" : "Not on watchlist") + " · " + esc(r.category || "") + " · " + esc((r.chains || []).join(", "));
    // Nearest traded peers: same family, market cap within 10x of what the
    // size curve says at their TVL. If fewer than three qualify, fall back
    // to the nearest by TVL regardless of family, and say so.
    var peerNote = "Nearest trading tokens by TVL, same family, within 10x of the curve. Green: the five nearest. The curve is the same size curve as the board.";
    var peers = D.tradedRows.filter(function (q) { return q.mcap_usd && q.tvl_usd && q.category === r.category; }).map(function (q) {
      var curvePred = Math.pow(10, D.curve.a + D.curve.b * Math.log10(q.tvl_usd));
      return { slug: q.slug, name: q.name, tvl: q.tvl_usd, mcap: q.mcap_usd, d: Math.abs(Math.log10(q.tvl_usd / r.tvl_usd)), ratio: q.mcap_usd / curvePred };
    }).filter(function (q) { return q.ratio >= 0.1 && q.ratio <= 10; }).sort(function (a, b) { return a.d - b.d; }).slice(0, 5);
    if (peers.length < 3) {
      peers = D.tradedRows.filter(function (q) { return q.mcap_usd && q.tvl_usd; }).map(function (q) {
        return { slug: q.slug, name: q.name, tvl: q.tvl_usd, mcap: q.mcap_usd, d: Math.abs(Math.log10(q.tvl_usd / r.tvl_usd)) };
      }).sort(function (a, b) { return a.d - b.d; }).slice(0, 5);
      peerNote = "Fewer than three same-family peers sit within 10x of the curve, so this shows the five nearest trading tokens by TVL instead. Green: the five nearest. The curve is the same size curve as the board.";
    }
    var html = "<h1 style='margin:4px 0'>" + esc(r.name) + (r.watchlist ? ' <span class="tag wl">Watchlist</span>' : "") + "</h1>" +
      "<p class='fine'>DefiLlama records no token for " + esc(r.name) + " (no CoinGecko id, ticker or market cap) as of " + D.asOf + ". A record is not proof: check your own channels before farming.</p>" +
      '<div class="cards">' +
      '<div class="card"><span>Implied value</span><b>' + money(r.implied_value_usd) + '</b><small>P10 ' + money(r.p10_usd) + ' to P90 ' + money(r.p90_usd) + '</small></div>' +
      '<div class="card"><span>TVL</span><b>' + money(r.tvl_usd) + '</b><small>' + changeText(r) + ' over 7 days</small></div>' +
      '<div class="card"><span>No token for</span><b>' + ageText(r) + '</b><small>tracked since ' + esc(r.listed_at || "—") + '</small></div>' +
      '<div class="card"><span>' + money(e.capital) + ' slice</span><b>' + money(e.slice) + '</b><small>at ' + Math.round(state.share * 100) + '% of value</small></div>' +
      '<div class="card"><span>Net if launch</span><b class="' + verdictClass(e.verdict) + '">' + signed(e.net) + '</b><small>' + e.verdict + ' · ' + signed(e.netPerHour) + '/h · break-even ' + (e.odds * 100).toFixed(0) + '%</small></div>' +
      "</div>" +
      '<div class="grid2"><div class="panel"><h2>How ' + money(r.implied_value_usd) + ' is built</h2><table class="build build-detail">' +
      "<tr><td>Size curve</td><td>" + money(r.base_usd) + "</td></tr>" +
      "<tr><td>Family ×" + r.family_factor.toFixed(2) + "</td><td>" + esc(r.category || "—") + "</td></tr>" +
      "<tr><td>Growth ×" + r.growth_factor.toFixed(2) + "</td><td>" + changeText(r) + " / 7d, carried 2 wks</td></tr>" +
      "<tr><td>Seasoning ×" + r.seasoning_factor.toFixed(2) + "</td><td>" + (r.seasoning_factor >= 0.99 ? "tracked " + ageText(r) + " — no discount" : "young protocol — discounted " + Math.round((1 - r.seasoning_factor) * 100) + "% by a bounded prior") + "</td></tr>" +
      "<tr><td>Sibling ×" + r.sibling_factor.toFixed(2) + "</td><td>" + (r.sibling_factor < 1 ? "shares a first word with a traded token — half value" : "no adjustment") + "</td></tr>" +
      '<tr class="total"><td>Implied value</td><td>' + money(r.implied_value_usd) + "</td></tr>" +
      "<tr><td>Blind range, P10 to P90</td><td>" + money(r.p10_usd) + " to " + money(r.p90_usd) + "</td></tr>" +
      "<tr><td>Blind range, P25 to P75</td><td>" + money(r.p25_usd) + " to " + money(r.p75_usd) + "</td></tr>" +
      "<tr><td>Break-even odds</td><td>" + (e.odds * 100).toFixed(0) + "% launch chance to cover costs</td></tr>" +
      "</table><p class='fine'>Recomputed on this page: board.json carries the same " + money(r.implied_value_usd) + " at rank " + r.rank + ".</p></div>" +
      '<div class="panel"><h2>Farm plan · ' + esc(r.farm_method) + " on " + esc(r.farm_chain || (r.chains || [])[0] || "") + " · " + money(e.capital) + " for " + D.farmDays + " days</h2>" +
      "<table class='steps'><tr><th></th><th>When</th><th>Step</th><th>Cost</th><th>Time</th></tr>" + r.farm_steps.map(function (s, i) {
        var gas = (r.fees_usd - 2.10) / 3;
        var costs = [gas + 1.0, 0, gas, 0, 0, 0.05, 0, 0.05, gas + 1.0, 0];
        var mins = [5, 15, 15, 5, 30, 10, 15, 10, 10, 5];
        return "<tr><td>" + (i + 1) + "</td><td>" + esc((r.farm_step_when || [])[i] || "") + "</td><td>" + esc(s) + "</td><td>" + (costs[i] ? "$" + costs[i].toFixed(2) : "none") + "</td><td>" + mins[i] + "m</td></tr>";
      }).join("") + "</table>" +
      "<p class='fine'>Slice " + money(e.slice) + " · Fees " + money(r.fees_usd) + " · T-bill forgone " + money(e.tbill) + " · Net " + signed(e.net) + " · Work " + (r.farm_minutes / 60).toFixed(1) + "h</p></div></div>" +
      '<div class="panel"><h2>The farm arithmetic</h2><p>Slice if a token launches = ' + Math.round(state.share * 100) + '% airdrop share × ' + money(e.capital) + ' / (TVL + ' + money(e.capital) + ') of ' + money(r.implied_value_usd) + ' implied = <b>' + money(e.slice) + '</b>.<br>' +
      'Break-even = (fees ' + money(r.fees_usd) + ' + T-bill forgone ' + money(e.tbill) + ') / slice ' + money(e.slice) + ' = <b>' + (e.odds * 100).toFixed(0) + '%</b> — the launch chance this farm needs to cover its costs.<br>' +
      'Net per hour = net ' + signed(e.net) + ' / ' + (r.farm_minutes / 60).toFixed(1) + 'h work = <b>' + signed(e.netPerHour) + '/h</b>. ' +
      'A 7-day TVL fall past -30% caps the verdict at marginal; this row is ' + changeText(r) + ' over 7 days.</p>' +
      "<p class='fine'>Fees and gas " + money(r.fees_usd) + " · Income forgone " + money(e.tbill) + " · Your time " + (r.farm_minutes / 60).toFixed(1) + "h · Slice " + money(e.slice) + " · Break-even odds " + (e.odds * 100).toFixed(0) + "% · Net per hour " + signed(e.netPerHour) + "/h</p></div>" +
      '<div class="panel"><h2>Against traded peers</h2><div id="scatter-detail"></div><p class="fine">' + peerNote + '</p>' +
      "<table class='build'><tr><th>Protocol</th><th class='num'>TVL</th><th class='num'>Market cap</th><th class='num'>Mcap / TVL</th></tr>" + peers.map(function (q) {
        return "<tr><td>" + esc(q.name) + "</td><td class='num'>" + money(q.tvl) + "</td><td class='num'>" + money(q.mcap) + "</td><td class='num'>" + (q.mcap / q.tvl).toFixed(2) + "x</td></tr>";
      }).join("") + "</table></div>" +
      "<h3>Net at a different airdrop share</h3>" +
      "<table class='sens'><tr><th></th><th>5% of value</th><th class='base'>10% of value</th><th>20% of value</th></tr>" +
      [1000, 5000, 10000].map(function (cap, ci) {
        return "<tr><td" + (ci === 1 ? " class='base'" : "") + ">" + money(cap) + "</td>" + [0.05, 0.1, 0.2].map(function (share, si) {
          var effCap = Math.min(cap, Math.max(500, r.tvl_usd / 10000));
          var sl = effCap * (r.implied_value_usd / (r.tvl_usd + effCap)) * share;
          var net = sl - r.fees_usd - effCap * (D.tbillYear - (D.depositYieldYear || 0)) * D.farmDays / 365;
          return "<td" + (si === 1 ? " class='base'" : "") + ">" + signed(net) + "</td>";
        }).join("") + "</tr>";
      }).join("") + "</table>" +
      "<p class='fine'>At a 5% share the slice is half the base case; at 20% it is double. The share is a working guess, not a promise. If the launch price falls 20% from the implied value, the " + money(e.capital) + " net at a 10% share is " + signed(e.capital * (r.implied_value_usd / (r.tvl_usd + e.capital)) * 0.1 * 0.8 - r.fees_usd - e.capital * (D.tbillYear - (D.depositYieldYear || 0)) * D.farmDays / 365) + ". The deposit's yield is counted at 3.5% a year against the 4% T-bill rate, so only the 0.5% spread is forgone; if the vault pays more than 3.5%, that is upside.</p>";
    $("detail").innerHTML = html;
    scatter($("scatter-detail"), { highlight: { tvl: r.tvl_usd, implied: r.implied_value_usd }, peers: peers });
    $("back-board").onclick = function (ev) { ev.preventDefault(); showView("board"); renderBoard(); };
  }

  // ---- method view ----
  function renderMethod() {
    var v = D.validation;
    var famRows = D.families.map(function (f) {
      return "<tr><td>" + esc(f.category) + "</td><td>" + f.n + " tokens</td><td>x" + f.factor.toFixed(2) + "</td></tr>";
    }).join("");
    function ablationRow(label, med, meanAbs, w3, sp) {
      return "<tr><td>" + label + "</td><td>x" + med.toFixed(2) + "</td><td>" + meanAbs.toFixed(3) + "</td><td>" + pct(w3) + "</td><td>" + sp.toFixed(2) + "</td></tr>";
    }
    var ef = v.eightFold;
    var setAsideRows = Object.keys(D.setAsideByReason).sort(function (a, b) { return D.setAsideByReason[b] - D.setAsideByReason[a]; }).map(function (reason) {
      return "<tr><td>" + esc(reason) + "</td><td>" + D.setAsideByReason[reason] + "</td></tr>";
    }).join("");
    var verify = verifyBoard();
    $("method").innerHTML =
      "<h1 style='margin:4px 0'>Method and backtest</h1>" +
      "<p class='fine'>One model.js prices the page and board.json. Everything below is computed from the sealed snapshot at run time; no protocol name is hardcoded anywhere in the model.</p>" +
      "<h3>Universe</h3><p>" + D.totalProtocols + " protocols over $5M TVL as of " + D.asOf + ". " + D.tradedCount + " record a token and are kept apart from the board; " + D.fitSet.kept + " of those carry a market cap and fit the curve. " + D.preTokenCount + " record no token; " + D.setAsideCount + " of those are set aside by house rule, leaving " + D.rows.length + " ranked. A record is not proof: DefiLlama records no token, so check your own channels before farming.</p>" +
      "<h3>The model</h3><p>Value = 10^" + (Math.log10(D.curve.per100m)).toFixed(2) + " x (TVL / $100M)^" + D.curve.b.toFixed(3) + " x family x growth x seasoning x sibling. " +
      "The size curve is a least-squares fit of log10(market cap) on log10(TVL): log10(mcap) = " + D.curve.a.toFixed(4) + " + " + D.curve.b.toFixed(4) + " x log10(TVL). " +
      "One point per traded token: listings that share a token are merged and their TVL summed (no-op on this snapshot — no traded token is listed twice); bridges and version listings are dropped (" + D.fitSet.bridge + " + " + D.fitSet.version + "); ratios past 1/500 or 50x are trimmed (" + D.fitSet.ratio + "); centralised-exchange tokens are dropped (" + D.fitSet.cex + "). " + D.fitSet.kept + " points remain from " + D.fitSet.from + ". " +
      "Family is the median log residual of a protocol's category, shrunk toward 1 by n / (n + 10), so a family with two tokens cannot move the board. " +
      "Growth carries TVL two more weeks at its 7-day rate, through the slope, clamped to +/-30%. " +
      "Seasoning is a bounded prior: 1 - 0.4 * e^(-days/240), so a protocol tracked 0 days is valued at 0.60, one tracked a year at about 0.91, and one tracked three years at 0.99. The snapshot cannot confirm an age effect (see the factor check below), so seasoning is stated as a prior, not a finding — it moves the blind miss by less than 0.01x either way. " +
      "Sibling is 0.50 for a watchlist protocol that shares its first word with a traded token, and 1.00 otherwise.</p>" +
      "<h3>Ablation: what each ingredient adds (leave-one-out, " + v.n + " tokens)</h3>" +
      "<table class='build'><tr><th>Model</th><th class='num'>Median miss</th><th class='num'>Mean |log miss|</th><th class='num'>Within 3x</th><th class='num'>Rank corr.</th></tr>" +
      ablationRow("TVL × one multiple", v.flatMedian, v.flatMeanAbsLog, v.flatWithin3, v.flatSpearman) +
      ablationRow("+ size curve", v.looCurveMedian, v.looCurveMeanAbsLog, v.looCurveWithin3, v.looCurveSpearman) +
      ablationRow("+ category family", v.looFamMedian, v.looFamMeanAbsLog, v.looFamWithin3, v.looFamSpearman) +
      ablationRow("+ growth & seasoning", v.looMedian, v.looMeanAbsLog, v.looWithin3, v.looSpearman) +
      "</table>" +
      "<h3>Same ablation, eight held-out folds (pooled out-of-fold)</h3>" +
      "<table class='build'><tr><th>Model</th><th class='num'>Median miss</th><th class='num'>Mean |log miss|</th><th class='num'>Within 3x</th><th class='num'>Rank corr.</th></tr>" +
      ablationRow("TVL × one multiple", ef["flat"].median, ef["flat"].meanAbsLog, ef["flat"].within3, ef["flat"].spearman) +
      ablationRow("+ size curve", ef["curve"].median, ef["curve"].meanAbsLog, ef["curve"].within3, ef["curve"].spearman) +
      ablationRow("+ category family", ef["curve+family"].median, ef["curve+family"].meanAbsLog, ef["curve+family"].within3, ef["curve+family"].spearman) +
      ablationRow("+ growth & seasoning", ef["curve+family+growth"].median, ef["curve+family+growth"].meanAbsLog, ef["curve+family+growth"].within3, ef["curve+family+growth"].spearman) +
      "</table>" +
      "<p class='fine'>Each token is priced by a model refit without it; each fold is priced by a model fitted to the other seven folds. Rank corr. is Spearman between the blind prediction and the real market cap. <b>What earns its place:</b> the size curve (median miss x" + v.flatMedian.toFixed(2) + " → x" + v.looCurveMedian.toFixed(2) + ", within 3x " + pct(v.flatWithin3) + " → " + pct(v.looCurveWithin3) + "). <b>Family is a wash on the blind numbers</b> (median x" + v.looCurveMedian.toFixed(2) + " → x" + v.looFamMedian.toFixed(2) + ", within 3x " + pct(v.looCurveWithin3) + " → " + pct(v.looFamWithin3) + ") and is kept as a bounded prior for relative pricing between families, not because it improves the blind miss. <b>Growth earns on the median and within 3x</b> (x" + v.looFamMedian.toFixed(2) + " → x" + v.looMedian.toFixed(2) + ", " + pct(v.looFamWithin3) + " → " + pct(v.looWithin3) + "). <b>Seasoning is a bounded prior, not a finding:</b> the factor check below finds no age effect, so it is not fitted — it discounts young protocols by up to 40% and moves the blind miss by less than 0.01x either way. <b>Rank correlation is not the model's job:</b> the flat multiple ranks best (" + v.flatSpearman.toFixed(2) + ") because it preserves TVL order exactly; the curve trades a little rank order for much better point values. The strict fit itself earns its place too: fitting all " + v.fitSet.keepAll.n + " traded tokens instead of the strict " + v.fitSet.strict.n + " gives a blind miss of x" + v.fitSet.keepAll.median.toFixed(2) + " (mean |log miss| " + v.fitSet.keepAll.meanAbsLog.toFixed(3) + ") against x" + v.fitSet.strict.median.toFixed(2) + " (" + v.fitSet.strict.meanAbsLog.toFixed(3) + ") for the strict fit.</p>" +
      "<h3>Family offsets</h3><table class='build'>" + famRows + "</table>" +
      "<p class='fine'>Median log residual per category, shrunk toward 1 by n / (n + 10) — 10 pseudo-tokens. A family with few tokens barely moves the board.</p>" +
      "<h3>Blind validation, continued</h3><table class='build'>" +
      "<tr><td>Time split: fit " + v.timeTrain + " tokens listed before 2024, test " + v.timeTest + " newer</td><td>x" + (v.timeCurveMedian || 0).toFixed(2) + " vs x" + (v.timeFlatMedian || 0).toFixed(2) + " flat</td></tr>" +
      "<tr><td>Time split, within 3x</td><td>" + pct(v.timeCurveWithin3 || 0) + " vs " + pct(v.timeFlatWithin3 || 0) + " flat</td></tr>" +
      "<tr><td>Blind 50% / 80% band</td><td>x" + v.band50.toFixed(2) + " / x" + v.band80.toFixed(2) + "</td></tr>" +
      "<tr><td>Blind range multipliers, P10 / P25 / P75 / P90</td><td>x" + v.p10Mult.toFixed(2) + " / x" + v.p25Mult.toFixed(2) + " / x" + v.p75Mult.toFixed(2) + " / x" + v.p90Mult.toFixed(2) + "</td></tr>" +
      "</table><p class='fine'>The band is wide because launches are genuinely uncertain, and the board shows it instead of hiding it.</p>" +
      "<h3>Factor check</h3><p>The blind residuals correlate r = " + v.factorCheck.corrDays.toFixed(2) + " with log days without a token and r = " + v.factorCheck.corrGrowth.toFixed(2) + " with 7-day TVL change (" + v.factorCheck.n + " tokens with a listing date). The fitted seasoning slope is " + v.factorCheck.seasonSlope.toFixed(2) + " per decade of days — within noise. Neither an age effect nor a leftover momentum effect is confirmed, so seasoning is kept only as a bounded prior and growth is only the two-week carry.</p>" +
      "<h3>Farm verdicts</h3><p>Verdict is break-even odds: (fees + T-bill forgone) / slice — the launch probability the farm needs to cover its costs. <b>Worth farming</b> at break-even odds ≤ 10% (pays if 1 hold in 10 sees a launch), <b>marginal</b> at ≤ 25%, else <b>skip</b>; a 7-day TVL fall past -30% caps the verdict at marginal. Farm economics: up to " + money(D.sliceCapital) + " of capital for " + D.farmDays + " days (a typical points-season window), the deposit scaled to the pool — 1bp of TVL, $500 to $5,000 — T-bill 4% a year less the deposit's 3.5% yield, so only the 0.5% spread is forgone, gas on the cheapest of the protocol's first three chains, a bridge leg each way at $1.00, claim $0.05. The deposit yield is a stated assumption, not a snapshot field: the median large stablecoin pool paid a 4.07% 30-day base APY against a 4.17% T-bill (DeFiLlama Research, 12 Nov 2026), so 3.5% sits below the median and is conservative. The farm is sized at " + money(D.sliceCapital) + " because that is the deployment a points-season farm actually runs; at a $1,000 cap the same rule gives 35 worth, 84 marginal and 65 skip, so the verdict still discriminates, but $5,000 is the calibrated size and the one the published top entry uses. At " + money(D.sliceCapital) + " it gives " + D.counts.farm + " worth, " + D.counts.thin + " marginal and " + D.counts.skip + " skip. Net per hour is net divided by the plan's work hours; the board's best on the watchlist is " + D.bestNetPerHour.map(function (r) { return r.name + " " + signed(r.netPerHour) + "/h"; }).join(", ") + ".</p>" +
      "<h3>Set aside by house rule</h3><table class='build'>" + setAsideRows + "<tr class='total'><td>Total set aside</td><td>" + D.setAsideCount + "</td></tr></table>" +
      "<p class='fine'>" + D.setAsideCount + " protocols never reach the board: category CEX, Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking or Restaked BTC; a name carrying a whole word wrapped, staked or staking; a name ending in a version marker; a name beginning with an exchange; a name whose first word is one of its own chains — the chain's own product, whose token (if any) is the chain's token; or a name sharing its first word with a token that already trades. A protocol matching two rules is counted under the first. The watchlist is never set aside for its name: " + D.siblingHalf + " watchlist sibling stays on the board at half value. A wrapped or staked product of a token that already trades is not a token that does not exist yet.</p>" +
      "<h3>board.json = this page</h3><p>" + esc(verify.text) + "</p>" +
      "<h3>Assumptions and limits</h3><p>A record is not proof: a protocol on the board records no token in DefiLlama, which is not the same as having none. The airdrop share is a working guess, not a promise. The deposit yield (3.5%) is a stated assumption, below the 4.07% median 30-day base APY of large stablecoin pools (DeFiLlama Research, 12 Nov 2026); if a vault pays less, the income forgone is higher and some Worth rows would fall to Marginal. Gas is a rough table figure per chain; the bridge legs are $1.00 each. The curve is fitted to " + D.curve.n + " tokens; a launch can miss it by an order of magnitude, which is why every row carries its blind range (P10 to P90).</p>";
    $("back-board-2").onclick = function (ev) { ev.preventDefault(); showView("board"); renderBoard(); };
  }

  function syncUrl() {
    var q = new URLSearchParams();
    if (state.tab !== "board") q.set("tab", state.tab);
    if (state.search) q.set("q", state.search);
    if (state.cat) q.set("cat", state.cat);
    if (state.chain) q.set("chain", state.chain);
    if (state.verdict) q.set("verdict", state.verdict);
    if (state.watchlistOnly) q.set("wl", "1");
    if (state.minTvl) q.set("mintvl", String(state.minTvl));
    if (state.capital !== D.sliceCapital) q.set("cap", String(state.capital));
    if (state.share !== D.airdropShare) q.set("share", String(state.share));
    if (state.sortKey !== "rank") q.set("sort", state.sortKey);
    if (state.sortDir === -1 && state.sortKey !== "rank") q.set("dir", "desc");
    var s = q.toString();
    // Board state lives in the hash, so a detail link's query
    // (?view=detail&slug=…) is never clobbered; the hash survives a detail
    // visit and restores the board when the user comes back.
    try { history.replaceState(null, "", location.pathname + location.search + (s ? "#" + s : "")); } catch (e) { /* file:// or sandboxed: URL state is a nicety, not the page */ }
  }

  if (view === "detail") { renderBoard(); renderDetail(params.get("slug") || ""); }
  else if (view === "method") { renderBoard(); showView("method"); renderMethod(); }
  else { renderBoard(); if (state.tab === "method") { showView("method"); renderMethod(); } }
})();
