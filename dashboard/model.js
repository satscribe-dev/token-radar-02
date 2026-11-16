// Launch Radar model: one module prices the page and board.json.
// Pure functions, no I/O, no network, no clock, no randomness: the same
// input bytes always give the same output bytes. Runs in node (main.ts)
// and in the browser (index.html loads it before app.js).
// Every number below is derived from the sealed snapshot at run time;
// nothing about any protocol is hardcoded.

(function (root) {
  "use strict";

  var AS_OF = "2026-11-14";
  var TBILL_YEAR = 0.04; // 4% a year forgone while capital sits idle in a farm
  var FARM_DAYS = 42; // six weeks: a typical points-season window
  var AIRDROP_SHARE = 0.1; // a 10% drop, pro rata to TVL, is the working guess
  var SLICE_CAPITAL = 5000; // a farm has to be this big for the slice to cover its costs (see Method)

  // Categories that cannot launch a token of their own: a centralised
  // exchange, a wrapped / staked / bridged product of a token that already
  // trades. Same spirit as the house watchlist rule, written as a rule,
  // never as a list of protocol names.
  var EXCLUDED_CATEGORIES = {
    "CEX": 1,
    "Bridge": 1,
    "Canonical Bridge": 1,
    "Liquid Staking": 1,
    "Liquid Restaking": 1,
    "Restaked BTC": 1,
  };
  var EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
  var WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
  var VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

  // Typical gas for one simple transaction on each chain, in dollars.
  // A rough public-table figure, stated as an assumption on the page.
  var GAS_USD = {
    "Ethereum": 1.5, "Base": 0.05, "Arbitrum": 0.1, "Optimism": 0.08,
    "Solana": 0.02, "BSC": 0.1, "Polygon": 0.05, "Avalanche": 0.15,
    "Gnosis": 0.05, "Fantom": 0.05, "Linea": 0.05, "Scroll": 0.05,
    "zkSync Era": 0.08, "Mode": 0.05, "Blast": 0.05, "Berachain": 0.05,
  };
  var CLAIM_USD = 1.5;
  var EXIT_USD = 3.0;

  // What farming looks like for each family of protocol. The words change
  // the steps; the steps still name the protocol and its chain.
  var METHODS = {
    "Risk Curators": { method: "curated vault", verb: "Deposit into the curated vault" },
    "Dexs": { method: "liquidity and swaps", verb: "Add liquidity to the main pool" },
    "Lending": { method: "lending market", verb: "Supply assets to the lending market" },
    "Yield": { method: "yield vault", verb: "Deposit into the yield vault" },
    "RWA": { method: "tokenised asset vault", verb: "Deposit into the asset vault" },
    "Derivatives": { method: "perpetuals market", verb: "Open a hedged position on the perpetuals market" },
    "CDP": { method: "collateral vault", verb: "Lock collateral and mint the stable asset" },
    "Prediction Market": { method: "margin and volume", verb: "Trade the prediction market with margin" },
    "Basis Trading": { method: "delta-neutral dollar", verb: "Mint the delta-neutral dollar" },
    "Onchain Capital Allocator": { method: "strategy vault", verb: "Deposit into the strategy vault" },
    "Liquid Staking": { method: "staking receipt", verb: "Stake and hold the receipt token" },
    "Yield Aggregator": { method: "auto-compounding vault", verb: "Deposit into the auto-compounding vault" },
    "Indexes": { method: "index vault", verb: "Buy the index token" },
    "Leveraged Farming": { method: "leveraged farm", verb: "Open a leveraged farm position" },
    "Options": { method: "options vault", verb: "Sell options through the vault" },
    "Insurance": { method: "cover pool", verb: "Provide cover to the insurance pool" },
    "Gaming": { method: "in-game assets", verb: "Buy and hold the in-game assets" },
    "NFT Lending": { method: "NFT lending pool", verb: "Lend against the listed NFT collections" },
    "Algo-Stables": { method: "stability pool", verb: "Deposit into the stability pool" },
    "Synthetics": { method: "synthetic mint", verb: "Mint the synthetic asset" },
    "Cross Chain Bridge": { method: "bridge volume", verb: "Bridge assets through the protocol" },
    "Privacy": { method: "shielded pool", verb: "Deposit into the shielded pool" },
  };
  var DEFAULT_METHOD = { method: "points program", verb: "Use the app and join the points program" };

  function log10(x) { return Math.log(x) / Math.log(10); }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function median(sorted) {
    var n = sorted.length;
    if (n === 0) return 0;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
  function quantile(sorted, q) {
    if (sorted.length === 0) return 0;
    var pos = q * (sorted.length - 1);
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function meanOf(xs) {
    var s = 0, i;
    for (i = 0; i < xs.length; i++) s += xs[i];
    return xs.length ? s / xs.length : 0;
  }
  // Spearman rank correlation, ties averaged. Used on out-of-fold
  // predictions, so it says whether the model ranks launches, not just
  // whether its point values are close.
  function spearman(xs, ys) {
    function ranks(arr) {
      var idx = arr.map(function (v, i) { return [v, i]; }).sort(function (a, b) { return a[0] - b[0]; });
      var r = new Array(arr.length), i = 0;
      while (i < idx.length) {
        var j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        var avg = (i + j) / 2 + 1, k;
        for (k = i; k <= j; k++) r[idx[k][1]] = avg;
        i = j + 1;
      }
      return r;
    }
    var rx = ranks(xs), ry = ranks(ys), n = xs.length;
    var mx = meanOf(rx), my = meanOf(ry), sxy = 0, sxx = 0, syy = 0, i;
    for (i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) * (rx[i] - mx); syy += (ry[i] - my) * (ry[i] - my); }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  }
  function fmtMoney(x) {
    if (x >= 1e9) return "$" + (x / 1e9).toFixed(2) + "B";
    if (x >= 1e6) return "$" + (x / 1e6).toFixed(1) + "M";
    if (x >= 1e3) return "$" + (x / 1e3).toFixed(1) + "K";
    return "$" + x.toFixed(2);
  }
  function fmtSigned(x) {
    return (x < 0 ? "-$" : "+$") + Math.abs(x).toFixed(2);
  }

  // Least squares on log10(mcap) = a + b * log10(tvl).
  function fitCurve(points) {
    var n = points.length, sx = 0, sy = 0, i, x, y;
    for (i = 0; i < n; i++) { sx += log10(points[i].tvl); sy += log10(points[i].mcap); }
    var mx = sx / n, my = sy / n, sxx = 0, sxy = 0;
    for (i = 0; i < n; i++) {
      x = log10(points[i].tvl) - mx; y = log10(points[i].mcap) - my;
      sxx += x * x; sxy += x * y;
    }
    var b = sxx === 0 ? 0 : sxy / sxx;
    return { a: my - b * mx, b: b, n: n };
  }

  // Median log residual per category, shrunk toward 1 by n / (n + 10),
  // so a family with two tokens cannot move the board on its own.
  // Only categories with at least 3 traded tokens get an offset.
  function familyTable(traded, curve) {
    var byCat = {}, i, p, pred, cat;
    for (i = 0; i < traded.length; i++) {
      p = traded[i];
      pred = curve.a + curve.b * log10(p.tvl);
      cat = p.category || "(none)";
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(log10(p.mcap) - pred);
    }
    var table = {};
    for (cat in byCat) {
      var rs = byCat[cat].slice().sort(function (x, y) { return x - y; });
      if (rs.length >= 3) {
        var m = median(rs);
        table[cat] = { factor: Math.pow(10, m * rs.length / (rs.length + 10)), n: rs.length, medianLog: m };
      }
    }
    return table;
  }
  function familyFactor(table, category) {
    var row = table[category || "(none)"];
    return row ? row.factor : 1.0;
  }

  // Growth carries TVL two more weeks at its 7-day rate, through the
  // slope: a fast-growing protocol is worth more than its TVL today, but
  // the sublinear curve damps the carry. The total carry is clamped to
  // +/-30%. Returns the TVL multiplier; the value multiplier is mult^b.
  // Blind-tested: on the 101-token fit set this beats a post-curve
  // 1 + change multiplier on every cut (see validate).
  function growthTvlFactor(change7d) {
    if (change7d === null || change7d === undefined) return 1.0;
    return clamp(Math.pow(1 + change7d / 100, 2), 0.7, 1.3);
  }
  function ageYears(listedAt) {
    if (!listedAt) return 1.0; // unreported: one year, stated on the page
    var parts = listedAt.split("-");
    var then = Date.UTC(+parts[0], +parts[1] - 1, +parts[2]);
    var now = Date.UTC(2026, 10, 14);
    return Math.max(0, (now - then) / 86400000 / 365.25);
  }
  // Seasoning is 1.00: the snapshot cannot confirm an age effect. The
  // factor check in validate() regresses the blind residuals on log days
  // and finds a correlation near zero (r about -0.05), so the model does
  // not invent one. Age is still shown on every row; it just does not
  // move the price.
  function seasoningFactor() { return 1.0; }
  // First words of the names of every protocol whose token already
  // trades. A pre-token protocol sharing one is a sibling of that token.
  function tradedFirstWords(protocols) {
    var words = {};
    protocols.forEach(function (p) {
      if (p.gecko_id === null && p.symbol === null) return;
      var w = (p.name || "").trim().split(/\s+/)[0];
      if (w) words[w.toLowerCase()] = true;
    });
    return words;
  }
  function isSibling(p, words) {
    var w = (p.name || "").trim().split(/\s+/)[0];
    return w ? !!words[w.toLowerCase()] : false;
  }

  function priceProtocol(p, curve, famTable, sibling) {
    var g = growthTvlFactor(p.change_7d);
    var base = Math.pow(10, curve.a + curve.b * log10(p.tvl_usd));
    var fam = familyFactor(famTable, p.category);
    var growth = Math.pow(g, curve.b);
    var seas = seasoningFactor();
    var sib = sibling || 1.0;
    return {
      base: base, family: fam, growth: growth, seasoning: seas,
      sibling: sib, ageYears: ageYears(p.listed_at),
      implied: base * fam * growth * seas * sib,
    };
  }

  // The curve is fitted to the traded tokens that can stand for a
  // launch. One point per traded token: listings that share a token are
  // merged and their TVL summed (no-op on this snapshot: no traded token
  // is listed twice); bridges and version listings are not standalone
  // tokens; ratios past 1/500 or 50x are outliers, not a curve; and a
  // centralised exchange's token is not a protocol launch. Each step is
  // counted so the method page can state it. Returns "kept" or the
  // reason the point is dropped.
  function fitPoint(p) {
    if (!p.gecko_id || !p.symbol || !p.mcap_usd || p.mcap_usd <= 0 || !p.tvl_usd || p.tvl_usd <= 0) return null;
    if (p.category === "Bridge" || p.category === "Canonical Bridge") return "bridge";
    if (VERSION_SUFFIX.test(p.name || "")) return "version";
    var r = p.mcap_usd / p.tvl_usd;
    if (r < 1 / 500 || r > 50) return "ratio";
    if (p.category === "CEX") return "cex";
    return "kept";
  }

  // A protocol whose first word is one of its own chains is the chain's
  // own product: its token, if any, is the chain's token, not a new launch.
  function isNamedForChain(p) {
    var first = (p.name || "").trim().split(/\s+/)[0];
    if (!first) return false;
    first = first.toLowerCase();
    var chains = p.chains || [], i;
    for (i = 0; i < chains.length; i++) if ((chains[i] || "").toLowerCase() === first) return true;
    return false;
  }

  // Why a protocol is set aside: it cannot launch a token of its own.
  // Returns a short reason, or null when the protocol stays on the board.
  function setAsideReason(p) {
    if (EXCLUDED_CATEGORIES[p.category || ""]) return "category " + p.category;
    if (WRAPPED_WORD.test(p.name)) return "name carries wrapped / staked";
    if (VERSION_SUFFIX.test(p.name)) return "name ends in a version marker";
    if (EXCHANGE_PREFIX.test(p.name)) return "name begins with an exchange";
    if (isNamedForChain(p)) return "named for its chain";
    return null;
  }

  function gasFor(chain) {
    return GAS_USD[chain] !== undefined ? GAS_USD[chain] : 0.5;
  }
  // The farm plan runs on the cheapest of the protocol's first three
  // chains: gas is the only chain-dependent cost, and the plan names
  // the chain it runs on.
  function cheapestChain(chains) {
    var list = (chains || []).slice(0, 3);
    if (list.length === 0) return "Ethereum";
    var best = list[0], bestGas = gasFor(best), i;
    for (i = 1; i < list.length; i++) {
      var g = gasFor(list[i]);
      if (g < bestGas) { best = list[i]; bestGas = g; }
    }
    return best;
  }
  function methodFor(category) {
    return METHODS[category || ""] || DEFAULT_METHOD;
  }

  // Ten dated steps for one protocol, each 20-600 characters once
  // trimmed, naming the protocol, its chain and its method, with a dollar
  // cost and minutes on every step that has one. The plan runs 42 days:
  // fund and verify on day 0, deposit on day 3, a weekly check, a mid-way
  // re-read on day 21, claim and exit on day 42, and a stop rule that
  // fires any day the TVL closes 10% under today's level.
  // The verdict is break-even odds: the launch probability the farm needs
  // to cover its costs. Worth farming at 10% or better (pays if 1 hold in
  // 10 sees a launch), marginal at 25% or better, else skip; a 7-day TVL
  // fall past -30% caps the verdict at marginal.
  function farmPlan(p, priced, chain) {
    var name = p.name, method = methodFor(p.category).method, verb = methodFor(p.category).verb;
    var gas = gasFor(chain);
    // The slice is capital / (TVL + capital) of the implied value: the
    // farm buys a share of the pool it joins, so the capital itself is
    // part of the denominator. At TVL >> capital this is the old
    // capital/TVL form; at small TVL it is the honest one.
    var slice = SLICE_CAPITAL * (priced.implied / (p.tvl_usd + SLICE_CAPITAL)) * AIRDROP_SHARE;
    var fees = gas + gas + gas + CLAIM_USD + EXIT_USD;
    var tbill = SLICE_CAPITAL * TBILL_YEAR * FARM_DAYS / 365;
    var net = slice - fees - tbill;
    var odds = (fees + tbill) / slice;
    var verdict = odds <= 0.10 ? "Worth farming" : (odds <= 0.25 ? "Marginal" : "Skip");
    if (verdict === "Worth farming" && p.change_7d !== null && p.change_7d !== undefined && p.change_7d < -30) verdict = "Marginal";
    var stop = p.tvl_usd * 0.9;
    var steps = [
      "Fund. Open a fresh wallet on " + chain + " with $5,000 of USDC and some gas, so the position is easy to track. Cost $" + gas.toFixed(2) + ", about 5 minutes.",
      "Verify. Reach " + name + " from its DefiLlama listing, not a search ad. Check the contracts, the audits and whether a points page exists. No cost, about 15 minutes.",
      "Deposit. " + verb + " on " + chain + " with $5,000 of USDC, then stake it into the " + method + ". Check the redemption queue first. Cost $" + gas.toFixed(2) + ", about 15 minutes.",
      "Check. On day 4, confirm the position shows in " + name + "'s app and log the transaction hash, date and amount. No cost, about 5 minutes.",
      "Upkeep. Once a week for 6 weeks, check the points page and the position in about 5 minutes. No cost, about 30 minutes in all.",
      "Mid-way. On day 21, re-read the rewards page and do any qualifying action it names once, only if it ends by day 42. Cost $0.05, about 10 minutes.",
      "Stop rule. Any day the TVL closes under " + fmtMoney(stop) + " (10% under today's level) or withdrawals pause, withdraw at once and end the plan. Cost $" + gas.toFixed(2) + ", about 15 minutes.",
      "Claim. If a token launches, claim only from the official app. At this implied value a 10 percent drop pro rata to TVL pays this position about " + fmtMoney(slice) + ". Cost $" + CLAIM_USD.toFixed(2) + ", about 10 minutes.",
      "Exit. Withdraw after " + FARM_DAYS + " days or the claim, and move the $5,000 back. Idle dollars here forgo 4 percent a year in T-bills. Cost $" + EXIT_USD.toFixed(2) + ", about 10 minutes.",
      "Close out. Log the outcome, the net and whether the farm beat a T-bill at this size, so the next farm starts from a record, not a guess. No cost, about 5 minutes.",
    ];
    var when = ["Day 0", "Day 0", "Day 3", "Day 4", "Weekly ×6", "Day 21", "Any day", "Day 42", "Day 42", "Day 42"];
    var minutes = [5, 15, 15, 5, 30, 10, 15, 10, 10, 5];
    var minutesTotal = 0, i;
    for (i = 0; i < minutes.length; i++) minutesTotal += minutes[i];
    return {
      steps: steps, stepWhen: when, slice: slice, fees: fees, tbill: tbill, net: net,
      odds: odds, verdict: verdict, method: method,
      netPerHour: net / (minutesTotal / 60),
      costTotal: fees, minutesTotal: minutesTotal,
    };
  }

  // Blind validation. Leave-one-out refits curve and family without the
  // token being predicted; the time split fits only tokens listed before
  // 2024 and tests the newer ones. The flat baseline predicts the median
  // mcap/TVL times TVL. Miss factor is max(pred/actual, actual/pred).
  // Three model variants are left out in turn (curve alone, curve +
  // family, curve + family + growth) so the page can show what each
  // ingredient adds. The factor check regresses the full-model blind
  // residuals on log days without a token and on 7-day TVL change: a
  // correlation near zero means the snapshot cannot confirm that effect,
  // which is why seasoning is 1.00.
  function validate(traded) {
    function corr(xs, ys) {
      var n = xs.length, mx = 0, my = 0, i, sxy = 0, sxx = 0, syy = 0;
      if (n < 10) return 0;
      for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
      mx /= n; my /= n;
      for (i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); syy += (ys[i] - my) * (ys[i] - my); }
      return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    }
    function linSlope(xs, ys) {
      var n = xs.length, mx = 0, my = 0, i, sxy = 0, sxx = 0;
      if (n < 10) return 0;
      for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
      mx /= n; my /= n;
      for (i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
      return sxx ? sxy / sxx : 0;
    }
    function within3(arr) {
      var c = 0, k;
      for (k = 0; k < arr.length; k++) if (arr[k] <= 3) c++;
      return arr.length ? c / arr.length : 0;
    }
    var pts = traded.map(function (p) { return { tvl: p.tvl_usd, mcap: p.mcap_usd, category: p.category || "(none)", listed_at: p.listed_at, change_7d: p.change_7d, slug: p.slug }; });
    var looMiss = [], looFamMiss = [], looCurveMiss = [], looSigned = [], flatMiss = [];
    var looCurvePred = [], looCurveAct = [], looFamPred = [], looFamAct = [];
    var looPred = [], looAct = [], flatPred = [], flatAct = [];
    var looDays = [], looChange = [], looResid = [], looResidDated = [];
    var i, j, others, curve, fam;
    for (i = 0; i < pts.length; i++) {
      others = [];
      for (j = 0; j < pts.length; j++) if (j !== i) others.push(pts[j]);
      curve = fitCurve(others);
      fam = familyTable(others.map(function (q) { return { tvl: q.tvl, mcap: q.mcap, category: q.category }; }), curve);
      var base = Math.pow(10, curve.a + curve.b * log10(pts[i].tvl));
      var famPred = base * familyFactor(fam, pts[i].category);
      var fullPred = famPred * Math.pow(growthTvlFactor(pts[i].change_7d), curve.b);
      looCurveMiss.push(Math.max(base / pts[i].mcap, pts[i].mcap / base));
      looFamMiss.push(Math.max(famPred / pts[i].mcap, pts[i].mcap / famPred));
      looMiss.push(Math.max(fullPred / pts[i].mcap, pts[i].mcap / fullPred));
      looCurvePred.push(base); looCurveAct.push(pts[i].mcap);
      looFamPred.push(famPred); looFamAct.push(pts[i].mcap);
      looPred.push(fullPred); looAct.push(pts[i].mcap);
      var signed = log10(pts[i].mcap / fullPred);
      looSigned.push(signed);
      looResid.push(signed);
      if (pts[i].listed_at) {
        var days = ageYears(pts[i].listed_at);
        looDays.push(log10(Math.max(1, days * 365.25)));
        looChange.push((pts[i].change_7d || 0) / 100);
        looResidDated.push(signed);
      }
      // The flat baseline is leave-one-out too: the median multiple of
      // every token except the one being priced.
      var flatOthers = others.map(function (q) { return q.mcap / q.tvl; }).sort(function (x, y) { return x - y; });
      var fp = median(flatOthers) * pts[i].tvl;
      flatMiss.push(Math.max(fp / pts[i].mcap, pts[i].mcap / fp));
      flatPred.push(fp); flatAct.push(pts[i].mcap);
    }
    looMiss.sort(function (x, y) { return x - y; });
    looFamMiss.sort(function (x, y) { return x - y; });
    looCurveMiss.sort(function (x, y) { return x - y; });
    flatMiss.sort(function (x, y) { return x - y; });
    var signedSorted = looSigned.slice().sort(function (x, y) { return x - y; });
    var absLog = looMiss.map(function (m) { return log10(m); }).sort(function (x, y) { return x - y; });
    var oldPts = pts.filter(function (q) { return q.listed_at && q.listed_at < "2024-01-01"; });
    var newPts = pts.filter(function (q) { return q.listed_at && q.listed_at >= "2024-01-01"; });
    var tsCurve = null, tsFlat = null;
    if (oldPts.length > 0 && newPts.length > 0) {
      var c2 = fitCurve(oldPts);
      var f2 = familyTable(oldPts.map(function (q) { return { tvl: q.tvl, mcap: q.mcap, category: q.category }; }), c2);
      var flatTrain = oldPts.map(function (q) { return q.mcap / q.tvl; }).sort(function (x, y) { return x - y; });
      tsCurve = []; tsFlat = [];
      for (i = 0; i < newPts.length; i++) {
        var pr = Math.pow(10, c2.a + c2.b * log10(newPts[i].tvl)) * familyFactor(f2, newPts[i].category) * Math.pow(growthTvlFactor(newPts[i].change_7d), c2.b);
        tsCurve.push(Math.max(pr / newPts[i].mcap, newPts[i].mcap / pr));
        var fpr = median(flatTrain) * newPts[i].tvl;
        tsFlat.push(Math.max(fpr / newPts[i].mcap, newPts[i].mcap / fpr));
      }
      tsCurve.sort(function (x, y) { return x - y; });
      tsFlat.sort(function (x, y) { return x - y; });
    }
    // Eight held-out folds: traded tokens sorted by slug, fold = index % 8.
    // Each fold is priced by a model fitted to the other seven; the
    // predictions are pooled, so every number below is out-of-fold.
    var eightFold = {};
    (function () {
      var bySlug = pts.slice().sort(function (a, b) { return a.slug < b.slug ? -1 : 1; });
      function predict(variant, train, p) {
        var c = fitCurve(train);
        if (variant === "flat") {
          var ratios = train.map(function (q) { return q.mcap / q.tvl; }).sort(function (x, y) { return x - y; });
          return median(ratios) * p.tvl;
        }
        var pr = Math.pow(10, c.a + c.b * log10(p.tvl));
        if (variant === "curve") return pr;
        var fm = familyTable(train.map(function (q) { return { tvl: q.tvl, mcap: q.mcap, category: q.category }; }), c);
        pr *= familyFactor(fm, p.category);
        if (variant === "curve+family") return pr;
        return pr * Math.pow(growthTvlFactor(p.change_7d), c.b);
      }
      ["flat", "curve", "curve+family", "curve+family+growth"].forEach(function (variant) {
        var pred = [], act = [], f;
        for (f = 0; f < 8; f++) {
          var test = bySlug.filter(function (_, i) { return i % 8 === f; });
          var train = bySlug.filter(function (_, i) { return i % 8 !== f; });
          test.forEach(function (p) { pred.push(predict(variant, train, p)); act.push(p.mcap); });
        }
        var miss = pred.map(function (pr, i) { return Math.max(pr / act[i], act[i] / pr); });
        miss.sort(function (x, y) { return x - y; });
        var abslog = pred.map(function (pr, i) { return Math.abs(log10(act[i] / pr)); });
        eightFold[variant] = {
          median: median(miss), meanAbsLog: meanOf(abslog),
          within3: within3(miss), spearman: spearman(pred, act),
        };
      });
    })();
    function meanAbsLogOf(miss) {
      return meanOf(miss.map(function (m) { return log10(m); }));
    }
    return {
      n: pts.length,
      looMedian: median(looMiss), flatMedian: median(flatMiss),
      looWithin3: within3(looMiss), flatWithin3: within3(flatMiss),
      looCurveMedian: median(looCurveMiss), looCurveWithin3: within3(looCurveMiss),
      looFamMedian: median(looFamMiss), looFamWithin3: within3(looFamMiss),
      looMeanAbsLog: meanAbsLogOf(looMiss), flatMeanAbsLog: meanAbsLogOf(flatMiss),
      looCurveMeanAbsLog: meanAbsLogOf(looCurveMiss), looFamMeanAbsLog: meanAbsLogOf(looFamMiss),
      looSpearman: spearman(looPred, looAct), flatSpearman: spearman(flatPred, flatAct),
      looCurveSpearman: spearman(looCurvePred, looCurveAct), looFamSpearman: spearman(looFamPred, looFamAct),
      eightFold: eightFold,
      band50: Math.pow(10, quantile(absLog, 0.5)),
      band80: Math.pow(10, quantile(absLog, 0.8)),
      p10Mult: Math.pow(10, quantile(signedSorted, 0.1)),
      p25Mult: Math.pow(10, quantile(signedSorted, 0.25)),
      p50Mult: Math.pow(10, quantile(signedSorted, 0.5)),
      p75Mult: Math.pow(10, quantile(signedSorted, 0.75)),
      p90Mult: Math.pow(10, quantile(signedSorted, 0.9)),
      timeTrain: oldPts.length, timeTest: newPts.length,
      timeCurveMedian: tsCurve ? median(tsCurve) : null,
      timeFlatMedian: tsFlat ? median(tsFlat) : null,
      timeCurveWithin3: tsCurve ? within3(tsCurve) : null,
      timeFlatWithin3: tsFlat ? within3(tsFlat) : null,
      factorCheck: {
        n: looDays.length,
        corrDays: corr(looDays, looResidDated),
        corrGrowth: corr(looChange, looResidDated),
        seasonSlope: linSlope(looDays, looResidDated),
      },
    };
  }

  // Strict fit vs keep-everything fit, both leave-one-out on the same
  // full variant. The strict fit drops bridges, version listings, ratio
  // outliers and CEX tokens; the comparison says whether that earns its
  // place or just shrinks the sample.
  function compareFitSets(protocols) {
    function looMedianMean(set) {
      var miss = [], i, j, others, curve, fam, pred;
      for (i = 0; i < set.length; i++) {
        others = [];
        for (j = 0; j < set.length; j++) if (j !== i) others.push(set[j]);
        curve = fitCurve(others.map(function (q) { return { tvl: q.tvl_usd, mcap: q.mcap_usd }; }));
        fam = familyTable(others.map(function (q) { return { tvl: q.tvl_usd, mcap: q.mcap_usd, category: q.category || "(none)" }; }), curve);
        pred = Math.pow(10, curve.a + curve.b * log10(set[i].tvl_usd)) * familyFactor(fam, set[i].category) * Math.pow(growthTvlFactor(set[i].change_7d), curve.b);
        miss.push(Math.max(pred / set[i].mcap_usd, set[i].mcap_usd / pred));
      }
      miss.sort(function (x, y) { return x - y; });
      return { n: set.length, median: median(miss), meanAbsLog: meanOf(miss.map(function (m) { return log10(m); })) };
    }
    var strict = protocols.filter(function (p) { return fitPoint(p) === "kept"; });
    var all = protocols.filter(function (p) {
      return p.gecko_id && p.symbol && p.mcap_usd > 0 && p.tvl_usd > 0;
    });
    return { strict: looMedianMean(strict), keepAll: looMedianMean(all) };
  }

  // Full build from a parsed snapshot object.
  function buildBoard(snapshot) {
    var protocols = snapshot.protocols || [];
    var watchlist = snapshot.watchlist || [];
    var watchSet = {};
    watchlist.forEach(function (s) { watchSet[s] = true; });
    var fitCounts = { from: 0, bridge: 0, version: 0, ratio: 0, cex: 0, kept: 0 };
    var traded = [];
    protocols.forEach(function (p) {
      var fr = fitPoint(p);
      if (fr === null) return;
      fitCounts.from++;
      if (fr === "kept") { fitCounts.kept++; traded.push(p); }
      else fitCounts[fr]++;
    });
    var preToken = protocols.filter(function (p) { return p.gecko_id === null && p.symbol === null; });
    var withToken = protocols.filter(function (p) { return p.gecko_id !== null || p.symbol !== null; });
    var curve = fitCurve(traded.map(function (p) { return { tvl: p.tvl_usd, mcap: p.mcap_usd }; }));
    var fam = familyTable(traded.map(function (p) { return { tvl: p.tvl_usd, mcap: p.mcap_usd, category: p.category || "(none)" }; }), curve);
    var validation = validate(traded);
    validation.fitSet = compareFitSets(protocols);
    var siblingWords = tradedFirstWords(protocols);
    var siblingHalf = 0;
    var setAside = [];
    var rows = [];
    var i, p, reason, priced, plan;
    for (i = 0; i < preToken.length; i++) {
      p = preToken[i];
      reason = setAsideReason(p);
      // The watchlist is never set aside for its name: a watchlist
      // protocol named for its chain stays, like a watchlist sibling.
      if (reason === "named for its chain" && watchSet[p.slug]) reason = null;
      if (!reason && isSibling(p, siblingWords)) {
        // A sibling of a token that already trades cannot launch its own
        // token — except a watchlist sibling, which stays at half value.
        if (watchSet[p.slug]) reason = null;
        else reason = "shares a first word with a token that already trades";
      }
      if (reason) { setAside.push({ slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, category: p.category, chains: p.chains, reason: reason }); continue; }
      var sib = isSibling(p, siblingWords) ? 0.5 : 1.0;
      if (sib === 0.5) siblingHalf++;
      priced = priceProtocol(p, curve, fam, sib);
      var farmChain = cheapestChain(p.chains);
      plan = farmPlan(p, priced, farmChain);
      rows.push({
        slug: p.slug, name: p.name, category: p.category, chains: p.chains,
        farm_chain: farmChain,
        tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at,
        watchlist: !!watchSet[p.slug],
        implied_value_usd: Math.round(priced.implied),
        base_usd: priced.base, family_factor: priced.family,
        growth_factor: priced.growth, seasoning_factor: priced.seasoning,
        sibling_factor: priced.sibling, age_years: priced.ageYears,
        p10_usd: Math.round(priced.implied * validation.p10Mult),
        p25_usd: Math.round(priced.implied * validation.p25Mult),
        p75_usd: Math.round(priced.implied * validation.p75Mult),
        p90_usd: Math.round(priced.implied * validation.p90Mult),
        slice_usd: plan.slice, fees_usd: plan.fees, tbill_usd: plan.tbill,
        net_usd: plan.net, verdict: plan.verdict, farm_method: plan.method,
        break_even_odds: plan.odds, net_per_hour_usd: plan.netPerHour,
        farm_cost_usd: plan.costTotal, farm_minutes: plan.minutesTotal,
        farm_steps: plan.steps, farm_step_when: plan.stepWhen,
      });
    }
    rows.sort(function (x, y) {
      if (y.implied_value_usd !== x.implied_value_usd) return y.implied_value_usd - x.implied_value_usd;
      return x.slug < y.slug ? -1 : 1;
    });
    for (i = 0; i < rows.length; i++) rows[i].rank = i + 1;
    setAside.sort(function (x, y) { return y.tvl_usd - x.tvl_usd || (x.slug < y.slug ? -1 : 1); });
    var tradedRows = withToken.map(function (q) {
      return { slug: q.slug, name: q.name, tvl_usd: q.tvl_usd, mcap_usd: q.mcap_usd, category: q.category, chains: q.chains };
    }).sort(function (x, y) { return (y.mcap_usd || 0) - (x.mcap_usd || 0) || (x.slug < y.slug ? -1 : 1); });
    var curvePoints = traded.map(function (q) { return { tvl: q.tvl_usd, mcap: q.mcap_usd }; });
    var boardPoints = rows.map(function (r) { return { tvl: r.tvl_usd, implied: r.implied_value_usd }; });
    var farmCount = 0, thinCount = 0, skipCount = 0;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].verdict === "Worth farming") farmCount++;
      else if (rows[i].verdict === "Marginal") thinCount++;
      else skipCount++;
    }
    var famList = [];
    for (var cat in fam) famList.push({ category: cat, factor: fam[cat].factor, n: fam[cat].n });
    famList.sort(function (x, y) { return y.factor - x.factor; });
    var setAsideByReason = {};
    setAside.forEach(function (s) { setAsideByReason[s.reason] = (setAsideByReason[s.reason] || 0) + 1; });
    var bestNetPerHour = rows.filter(function (r) { return r.watchlist; }).slice()
      .sort(function (a, b) { return b.net_per_hour_usd - a.net_per_hour_usd; }).slice(0, 3)
      .map(function (r) { return { name: r.name, netPerHour: r.net_per_hour_usd, net: r.net_usd }; });
    return {
      asOf: snapshot.as_of || AS_OF,
      totalProtocols: protocols.length,
      tradedCount: withToken.length,
      preTokenCount: preToken.length,
      watchlistCount: watchlist.length,
      watchlistCovered: rows.filter(function (r) { return r.watchlist; }).length,
      setAsideCount: setAside.length,
      siblingHalf: siblingHalf,
      fitSet: fitCounts,
      curve: { a: curve.a, b: curve.b, n: curve.n, per100m: Math.pow(10, curve.a + curve.b * 8) },
      families: famList,
      validation: validation,
      counts: { farm: farmCount, thin: thinCount, skip: skipCount },
      rows: rows,
      tradedRows: tradedRows,
      setAside: setAside,
      setAsideByReason: setAsideByReason,
      bestNetPerHour: bestNetPerHour,
      curvePoints: curvePoints,
      boardPoints: boardPoints,
      sliceCapital: SLICE_CAPITAL,
      airdropShare: AIRDROP_SHARE,
      tbillYear: TBILL_YEAR,
      farmDays: FARM_DAYS,
    };
  }

  var api = {
    AS_OF: AS_OF, fitCurve: fitCurve, familyTable: familyTable,
    familyFactor: familyFactor, growthTvlFactor: growthTvlFactor,
    ageYears: ageYears, seasoningFactor: seasoningFactor,
    tradedFirstWords: tradedFirstWords, isSibling: isSibling,
    isNamedForChain: isNamedForChain, fitPoint: fitPoint, priceProtocol: priceProtocol,
    setAsideReason: setAsideReason, gasFor: gasFor, cheapestChain: cheapestChain,
    methodFor: methodFor, meanOf: meanOf, spearman: spearman,
    farmPlan: farmPlan, validate: validate, compareFitSets: compareFitSets, buildBoard: buildBoard,
    fmtMoney: fmtMoney, fmtSigned: fmtSigned,
    SLICE_CAPITAL: SLICE_CAPITAL, AIRDROP_SHARE: AIRDROP_SHARE,
    TBILL_YEAR: TBILL_YEAR, FARM_DAYS: FARM_DAYS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadarModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
