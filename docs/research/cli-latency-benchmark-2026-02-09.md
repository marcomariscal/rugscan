# Assay CLI Latency Benchmark — 2026-02-09

## Summary

Baseline latency snapshot for key CLI paths, measured with `scripts/bench-cli-latency.ts`.
Purpose: establish reproducible numbers for regression tracking. No recommendation or risk
semantics were changed.

## Configuration

- **Iterations per scenario:** 5
- **Warmup runs per scenario:** 1
- **Timeout per run:** 120 000 ms
- **Total benchmark wall time:** ~257 s
- **Machine:** PN50 mini-PC (AMD Ryzen, 16 GB RAM), Linux 5.15, Bun 1.3.6
- **Network:** residential broadband (varies; online scenarios hit Sourcify, GoPlus, DeFiLlama)

## Results

| Scenario | min (ms) | p50 (ms) | p95 (ms) | max (ms) |
| --- | ---: | ---: | ---: | ---: |
| scan known-safe address (UNI) | 12 272 | 13 549 | 14 933 | 14 962 |
| scan risky/unverified address | 12 222 | 12 328 | 13 847 | 14 182 |
| scan --no-sim with fixture calldata | 11 791 | 12 411 | 23 692 | 24 370 |
| safe offline fixture ingest success | 272 | 276 | 283 | 284 |
| safe broken fixture fast-fail | 261 | 271 | 324 | 329 |

### Key takeaways

1. **Online scans are dominated by provider round-trips** (~12–15 s p50). The three online
   scenarios cluster tightly because the same set of external APIs (Sourcify, GoPlus,
   DeFiLlama, Etherscan) are called sequentially.
2. **`--no-sim` calldata scan** has a similar p50 (~12.4 s) but a notably higher p95/max
   (~24 s). This is likely caused by provider latency spikes during the calldata analysis
   path, which adds Etherscan V2 lookups for contract ABI resolution.
3. **Offline paths are fast** — safe fixture ingest completes in ~275 ms (p50), and the
   broken-fixture fast-fail path in ~271 ms (p50). This is essentially Bun startup + JSON
   parse + validation.
4. **p95 spread** on online paths is modest (< 2× p50), suggesting provider latency is
   relatively stable during this run but could widen under load or rate-limiting.

### Caveats

- **Network-dependent:** Online scenarios hit live third-party APIs. Results will vary by
  time of day, provider rate limits, and geographic location.
- **No simulation (Anvil):** The benchmark does not exercise the simulation path because
  Anvil availability is environment-dependent. The `--no-sim` scenario explicitly disables
  it. Simulation latency is a separate concern tracked in M9.
- **Bun cold-start included:** Each iteration spawns a fresh `bun run` process. The warmup
  run absorbs the first cold-start, but subsequent runs still include Bun process overhead
  (~200–300 ms baseline from the offline scenarios).
- **Small sample size:** 5 iterations per scenario. Sufficient for a baseline snapshot but
  not statistically rigorous for tail-latency analysis.

## Reproducing

```bash
bun run bench:cli-latency --iterations 5 --warmup 1
```

Or with custom settings:

```bash
bun run scripts/bench-cli-latency.ts --iterations 9 --warmup 2 --timeout-ms 180000
```

Output is markdown on stdout; progress logs go to stderr.
