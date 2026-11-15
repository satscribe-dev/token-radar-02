# Launch Radar — token-radar-02 (v3)

A radar for pre-token protocols: a board of 192 protocols ranked by an
implied value, a detail view per protocol, and a method page. Every number
is derived at run time from the sealed DefiLlama snapshot
(`input/snapshot.json`, as of 2026-11-14); no protocol name is hardcoded.

## Model (dashboard/model.js — one module prices the page and board.json)

- Size curve: least squares on log10(market cap) = a + b·log10(TVL), fitted
  to the 101 tokens that already trade: a = 3.1147, b = 0.5025. One point
  per traded token: listings sharing a token are merged (no-op here);
  bridges and version listings dropped (14 + 1); ratios past 1/500 or 50x
  trimmed (4); centralised-exchange tokens dropped (8). 101 of 128 remain.
- Family: median log residual per category, shrunk by n/(n+10).
- Growth: TVL carried two more weeks at its 7-day rate, through the slope,
  clamped to +/-30%.
- Seasoning: 1.00 — the snapshot cannot confirm an age effect (blind
  residual correlation with log days r = -0.03), so the model invents none.
- Sibling: a pre-token protocol sharing its first word with a traded token
  is set aside; a watchlist sibling stays at half value (1 protocol).
- Set aside by house rule: CEX / Bridge / Canonical Bridge / Liquid
  Staking / Liquid Restaking / Restaked BTC categories, wrapped/staked
  names, version-suffixed names, exchange-prefixed names, siblings
  (150 protocols).
- Blind validation (printed on the page): leave-one-out median miss x2.80
  vs x4.89 flat; within 3x 51.5% vs 36.6%; time split (fit 35 pre-2024,
  test 42 newer) x1.98 vs x4.88. Curve alone x2.95, curve + family x3.04:
  family alone does not improve the blind miss; growth carries the model.
- Farm economics: slice $1,000 at 10% of value, fees by cheapest chain,
  T-bill 4% a year forgone over 90 days; FARM when net beats all costs,
  THIN when the slice beats fees only, SKIP otherwise.

## Run

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Reads the snapshot, writes board.json, data.js, dashboard/, screenshots/
and dossier.json into the output directory, then verifies all seven gate
rows itself and throws on any failure. Two runs write byte-identical
output. `--stage` writes everything except dossier.json (for screenshots).
