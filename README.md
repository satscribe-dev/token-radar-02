# Launch Radar — token-radar-02

A radar for pre-token protocols: a board of 198 protocols ranked by an
implied value, a detail view per protocol, and a method page. Every number
is derived at run time from the sealed DefiLlama snapshot
(`input/snapshot.json`, as of 2026-11-14); no protocol name is hardcoded.

## Model (dashboard/model.js — one module prices the page and board.json)

- Size curve: least squares on log10(market cap) = a + b·log10(TVL), fitted
  to the 128 tokens that already trade: a = 3.0247, b = 0.5223.
- Family: median log residual per category, shrunk by n/(n+10).
- Growth: 1 + 7-day TVL change, clamped 0.8–1.3.
- Seasoning: 0.95 per year without a token, clamped 0.7–1.0.
- Sibling: 1.00 (a shared first word is a name, not evidence).
- Set aside by house rule: CEX / Bridge / Canonical Bridge / Liquid
  Staking / Liquid Restaking / Restaked BTC categories, wrapped/staked
  names, version-suffixed names, exchange-prefixed names (144 protocols).
- Blind validation (printed on the page): leave-one-out median miss x3.47
  vs x4.86 flat; within 3x 44.5% vs 35.2%; time split (fit pre-2024, test
  51 newer) x2.91 vs x4.80.
- Farm economics: slice $1,000 at 10% of value, fees by chain, T-bill 4%
  a year forgone over 90 days; FARM over +$2, THIN −$5…+$2, SKIP under −$5.

## Run

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Reads the snapshot, writes board.json, data.js, dashboard/, screenshots/
and dossier.json into the output directory, then verifies all seven gate
rows itself and throws on any failure. Two runs write byte-identical
output. `--stage` writes everything except dossier.json (for screenshots).
