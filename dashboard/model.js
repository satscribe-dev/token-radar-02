// Launch Radar model: one module prices the page and board.json.
// Pure functions, no I/O, no network, no clock, no randomness: the same
// input bytes always give the same output bytes. Runs in node (main.ts)
// and in the browser (index.html loads it before app.js).
// Every number below is derived from the sealed snapshot at run time;
// nothing about any protocol is hardcoded.

(function (root) {
  "use strict";

  var AS_OF = "2026-11-14";
  var TBILL_YEAR = 0.04; // 4% a year forgone while capital sits in a farm
  var FARM_DAYS = 90;
  var AIRDROP_SHARE = 0.1; // a 10% drop, pro rata to TVL, is the working guess
  var SLICE_CAPITAL = 1000;

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

  function growthFactor(change7d) {
    if (change7d === null || change7d === undefined) return 1.0;
    return clamp(1 + change7d / 100, 0.8, 1.3);
  }
  function ageYears(listedAt) {
    if (!listedAt) return 1.0; // unreported: one year, stated on the page
    var parts = listedAt.split("-");
    var then = Date.UTC(+parts[0], +parts[1] - 1, +parts[2]);
    var now = Date.UTC(2026, 10, 14);
    return Math.max(0, (now - then) / 86400000 / 365.25);
  }
  function seasoningFactor(age) {
    return clamp(Math.pow(0.95, age), 0.7, 1.0);
  }
  // A shared first word is a name, not evidence: no adjustment either way.
  function siblingFactor() { return 1.0; }

  function priceProtocol(p, curve, famTable) {
    var base = Math.pow(10, curve.a + curve.b * log10(p.tvl_usd));
    var fam = familyFactor(famTable, p.category);
    var growth = growthFactor(p.change_7d);
    var age = ageYears(p.listed_at);
    var seas = seasoningFactor(age);
    var sib = siblingFactor();
    return {
      base: base, family: fam, growth: growth, seasoning: seas,
      sibling: sib, ageYears: age,
      implied: base * fam * growth * seas * sib,
    };
  }

  // Why a protocol is set aside: it cannot launch a token of its own.
  // Returns a short reason, or null when the protocol stays on the board.
  function setAsideReason(p) {
    if (EXCLUDED_CATEGORIES[p.category || ""]) return "category " + p.category;
    if (WRAPPED_WORD.test(p.name)) return "name carries wrapped / staked";
    if (VERSION_SUFFIX.test(p.name)) return "name ends in a version marker";
    if (EXCHANGE_PREFIX.test(p.name)) return "name begins with an exchange";
    return null;
  }

  function gasFor(chain) {
    return GAS_USD[chain] !== undefined ? GAS_USD[chain] : 0.5;
  }
  function methodFor(category) {
    return METHODS[category || ""] || DEFAULT_METHOD;
  }

  // Seven concrete steps for one protocol, each 20-600 characters once
  // trimmed, naming the protocol, its chain and its method, with a dollar
  // cost and minutes on every step that has one.
  function farmPlan(p, priced, chain) {
    var name = p.name, method = methodFor(p.category).method, verb = methodFor(p.category).verb;
    var gas = gasFor(chain);
    var slice = SLICE_CAPITAL * (priced.implied / p.tvl_usd) * AIRDROP_SHARE;
    var fees = gas + gas + CLAIM_USD + EXIT_USD;
    var tbill = SLICE_CAPITAL * TBILL_YEAR * FARM_DAYS / 365;
    var net = slice - fees - tbill;
    var verdict = net > 2 ? "FARM" : net < -5 ? "SKIP" : "THIN";
    var steps = [
      "Fund. Open a fresh wallet on " + chain + " with $1,000 of USDC and some gas, so the position is easy to track. Cost $" + gas.toFixed(2) + ", about 5 minutes.",
      "Verify. Reach " + name + " from its DefiLlama listing, not a search ad. Check the contracts, the audits and whether a points page exists. No cost, about 15 minutes.",
      "Deposit. " + verb + " on " + chain + " with $1,000 of USDC, then stake it into the " + method + ". Check the redemption queue first. Cost $" + gas.toFixed(2) + ", about 15 minutes.",
      "Upkeep. Every week for 13 weeks, check the points page and the position in about 5 minutes. No cost, about 65 minutes in all.",
      "Risk. Redeem if funding stays negative for a week or the backing report shows less than 100 percent. No cost, about 5 minutes.",
      "Claim. If a token launches, claim only from the official app. At this implied value a 10 percent drop pro rata to TVL pays this position about " + fmtMoney(slice) + ". Cost $" + CLAIM_USD.toFixed(2) + ", about 10 minutes.",
      "Exit. Withdraw after " + FARM_DAYS + " days or the claim. Idle dollars here forgo 4 percent a year in T-bills. Cost $" + EXIT_USD.toFixed(2) + ", about 10 minutes.",
    ];
    return {
      steps: steps, slice: slice, fees: fees, tbill: tbill, net: net,
      verdict: verdict, method: method,
      costTotal: fees, minutesTotal: 5 + 15 + 15 + 65 + 5 + 10 + 10,
    };
  }

  // Blind validation. Leave-one-out refits curve and family without the
  // token being predicted; the time split fits only tokens listed before
  // 2024 and tests the newer ones. The flat baseline predicts the median
  // mcap/TVL times TVL. Miss factor is max(pred/actual, actual/pred).
  function validate(traded) {
    var pts = traded.map(function (p) { return { tvl: p.tvl_usd, mcap: p.mcap_usd, category: p.category || "(none)", listed_at: p.listed_at }; });
    var ratios = pts.map(function (q) { return q.mcap / q.tvl; }).sort(function (x, y) { return x - y; });
    var flatRatio = median(ratios);
    var looMiss = [], looSigned = [], flatMiss = [];
    var i, j, others, curve, fam;
    for (i = 0; i < pts.length; i++) {
      others = [];
      for (j = 0; j < pts.length; j++) if (j !== i) others.push(pts[j]);
      curve = fitCurve(others);
      fam = familyTable(others.map(function (q) { return { tvl: q.tvl, mcap: q.mcap, category: q.category }; }), curve);
      var pred = Math.pow(10, curve.a + curve.b * log10(pts[i].tvl)) * familyFactor(fam, pts[i].category);
      looMiss.push(Math.max(pred / pts[i].mcap, pts[i].mcap / pred));
      looSigned.push(log10(pts[i].mcap / pred));
      var fp = flatRatio * pts[i].tvl;
      flatMiss.push(Math.max(fp / pts[i].mcap, pts[i].mcap / fp));
    }
    looMiss.sort(function (x, y) { return x - y; });
    flatMiss.sort(function (x, y) { return x - y; });
    looSigned.sort(function (x, y) { return x - y; });
    var absLog = looMiss.map(function (m) { return log10(m); }).sort(function (x, y) { return x - y; });
    var oldPts = pts.filter(function (q) { return q.listed_at && q.listed_at < "2024-01-01"; });
    var newPts = pts.filter(function (q) { return q.listed_at && q.listed_at >= "2024-01-01"; });
    var tsCurve = null, tsFlat = null;
    if (oldPts.length > 0 && newPts.length > 0) {
      var c2 = fitCurve(oldPts);
      var f2 = familyTable(oldPts.map(function (q) { return { tvl: q.tvl, mcap: q.mcap, category: q.category }; }), c2);
      tsCurve = []; tsFlat = [];
      for (i = 0; i < newPts.length; i++) {
        var pr = Math.pow(10, c2.a + c2.b * log10(newPts[i].tvl)) * familyFactor(f2, newPts[i].category);
        tsCurve.push(Math.max(pr / newPts[i].mcap, newPts[i].mcap / pr));
        var fpr = flatRatio * newPts[i].tvl;
        tsFlat.push(Math.max(fpr / newPts[i].mcap, newPts[i].mcap / fpr));
      }
      tsCurve.sort(function (x, y) { return x - y; });
      tsFlat.sort(function (x, y) { return x - y; });
    }
    function within3(arr) {
      var c = 0, k;
      for (k = 0; k < arr.length; k++) if (arr[k] <= 3) c++;
      return arr.length ? c / arr.length : 0;
    }
    return {
      n: pts.length,
      looMedian: median(looMiss), flatMedian: median(flatMiss),
      looWithin3: within3(looMiss), flatWithin3: within3(flatMiss),
      band50: Math.pow(10, quantile(absLog, 0.5)),
      band80: Math.pow(10, quantile(absLog, 0.8)),
      p10Mult: Math.pow(10, quantile(looSigned, 0.1)),
      p25Mult: Math.pow(10, quantile(looSigned, 0.25)),
      p50Mult: Math.pow(10, quantile(looSigned, 0.5)),
      p75Mult: Math.pow(10, quantile(looSigned, 0.75)),
      p90Mult: Math.pow(10, quantile(looSigned, 0.9)),
      timeTrain: oldPts.length, timeTest: newPts.length,
      timeCurveMedian: tsCurve ? median(tsCurve) : null,
      timeFlatMedian: tsFlat ? median(tsFlat) : null,
      timeCurveWithin3: tsCurve ? within3(tsCurve) : null,
      timeFlatWithin3: tsFlat ? within3(tsFlat) : null,
    };
  }

  // Full build from a parsed snapshot object.
  function buildBoard(snapshot) {
    var protocols = snapshot.protocols || [];
    var watchlist = snapshot.watchlist || [];
    var watchSet = {};
    watchlist.forEach(function (s) { watchSet[s] = true; });
    var traded = protocols.filter(function (p) {
      return p.gecko_id !== null && p.symbol !== null && p.mcap_usd && p.mcap_usd > 0 && p.tvl_usd > 0;
    });
    var preToken = protocols.filter(function (p) { return p.gecko_id === null && p.symbol === null; });
    var withToken = protocols.filter(function (p) { return p.gecko_id !== null || p.symbol !== null; });
    var curve = fitCurve(traded.map(function (p) { return { tvl: p.tvl_usd, mcap: p.mcap_usd }; }));
    var fam = familyTable(traded.map(function (p) { return { tvl: p.tvl_usd, mcap: p.mcap_usd, category: p.category || "(none)" }; }), curve);
    var validation = validate(traded);
    var setAside = [];
    var rows = [];
    var i, p, reason, priced, plan;
    for (i = 0; i < preToken.length; i++) {
      p = preToken[i];
      reason = setAsideReason(p);
      if (reason) { setAside.push({ slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, category: p.category, chains: p.chains, reason: reason }); continue; }
      priced = priceProtocol(p, curve, fam);
      plan = farmPlan(p, priced, (p.chains && p.chains[0]) || "Ethereum");
      rows.push({
        slug: p.slug, name: p.name, category: p.category, chains: p.chains,
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
        farm_cost_usd: plan.costTotal, farm_minutes: plan.minutesTotal,
        farm_steps: plan.steps,
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
      if (rows[i].verdict === "FARM") farmCount++;
      else if (rows[i].verdict === "THIN") thinCount++;
      else skipCount++;
    }
    var famList = [];
    for (var cat in fam) famList.push({ category: cat, factor: fam[cat].factor, n: fam[cat].n });
    famList.sort(function (x, y) { return y.factor - x.factor; });
    return {
      asOf: snapshot.as_of || AS_OF,
      totalProtocols: protocols.length,
      tradedCount: withToken.length,
      preTokenCount: preToken.length,
      watchlistCount: watchlist.length,
      watchlistCovered: rows.filter(function (r) { return r.watchlist; }).length,
      setAsideCount: setAside.length,
      curve: { a: curve.a, b: curve.b, n: curve.n, per100m: Math.pow(10, curve.a + curve.b * 8) },
      families: famList,
      validation: validation,
      counts: { farm: farmCount, thin: thinCount, skip: skipCount },
      rows: rows,
      tradedRows: tradedRows,
      setAside: setAside,
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
    familyFactor: familyFactor, growthFactor: growthFactor,
    ageYears: ageYears, seasoningFactor: seasoningFactor,
    siblingFactor: siblingFactor, priceProtocol: priceProtocol,
    setAsideReason: setAsideReason, gasFor: gasFor, methodFor: methodFor,
    farmPlan: farmPlan, validate: validate, buildBoard: buildBoard,
    fmtMoney: fmtMoney, fmtSigned: fmtSigned,
    SLICE_CAPITAL: SLICE_CAPITAL, AIRDROP_SHARE: AIRDROP_SHARE,
    TBILL_YEAR: TBILL_YEAR, FARM_DAYS: FARM_DAYS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RadarModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
