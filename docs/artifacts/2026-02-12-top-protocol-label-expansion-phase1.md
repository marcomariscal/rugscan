# Top Protocol Label Expansion — Phase 1

**Date:** 2026-02-12
**Status:** Implemented
**PR:** (linked on merge)

## Goal

Expand deterministic protocol labeling for high-traffic Ethereum and Base contracts without massive manual address mapping. Labels improve UX clarity (human-readable names in scan output) without changing any safety thresholds or risk semantics.

## Selected Protocols and Rationale

Phase 1 adds **7 new protocol lanes** (Balancer V2, CoW Protocol, 0x Protocol, Morpho, OpenSea Seaport, QuickSwap on Base, Uniswap Permit2 on Base) alongside consolidation of the existing set. Protocols chosen by:

1. **TVL / usage rank** — top-20 Ethereum DeFi by TVL (DeFiLlama) or volume (DEX aggregators).
2. **Fixture presence** — contracts that appear in existing test fixtures (Seaport 1.6, 1inch V6).
3. **Base chain coverage** — canonical WETH, USDC, Uniswap routers, Permit2 on Base had no offline entries.

### Registry entries (21 protocols, ~45 root addresses)

| Protocol | Chains | Root addresses | Rationale |
|---|---|---|---|
| Uniswap V2 | ETH, Base | 2 | Top DEX by longevity |
| Uniswap V3 | ETH, Base | 3 | Top DEX by volume |
| Uniswap (Universal Router) | ETH, Base | 3 | Current default Uniswap entry |
| Uniswap Permit2 | Base | 1 | ETH already covered; Base gap filled |
| Aave V3 | ETH | 2 | Top lending by TVL |
| Aave V2 | ETH | 1 | Legacy but still >$1B TVL |
| Curve DEX | ETH | 2 | Top stableswap |
| 1inch | ETH | 3 | Top aggregator (V4+V5+V6) |
| **Balancer V2** | ETH | 1 | **NEW** — ~$1B TVL |
| **CoW Protocol** | ETH | 1 | **NEW** — top intent-based DEX |
| **0x Protocol** | ETH | 1 | **NEW** — major aggregation layer |
| **Morpho** | ETH | 1 | **NEW** — fast-growing lending |
| **OpenSea Seaport** | ETH | 2 | **NEW** — dominant NFT marketplace (1.5+1.6) |
| **QuickSwap** | Base | 1 | **NEW** — already in known-spenders |
| WETH | ETH, Base | 2 | Canonical wrapped ETH |
| Circle USDC | ETH, Base | 2 | Top stablecoin |
| Tether USDT | ETH | 1 | Top stablecoin |
| Lido | ETH | 1 | Top liquid staking |
| Compound | ETH | 1 | Legacy lending |
| Cap | ETH | 2 | Recent live feedback |
| ether.fi/weETH adapter | ETH | 2 | Recent live feedback |

## Mapping Strategy

### Three-tier resolution (avoids thousands of manual entries)

1. **Compact root registry** (`src/protocols/top-protocol-registry.ts`):
   - ~45 canonical root addresses (routers, vaults, pool providers, adapters).
   - O(1) lookup via pre-built chain→address→match index.
   - Source of truth for deterministic offline resolution.

2. **Deterministic name heuristics** (`src/protocols/fallback-heuristics.ts`):
   - If the address isn't in the registry, check `KNOWN_SPENDERS` name → protocol name inference.
   - If still unresolved, check proxy `implementationName` or `proxyName` against high-confidence keyword hints (e.g., "Aave", "Uniswap", "Seaport", "Morpho").
   - Only fires for known protocol keywords — never guesses on ambiguous names.

3. **DeFiLlama network fallback** (existing, unchanged):
   - For addresses not matched by tiers 1-2, the existing DeFiLlama `/protocols` API match still runs when network is available.

### Priority order

```
registry address match → known-spender name match → impl/proxy name heuristic → DeFiLlama API
```

### Integration point

The fallback heuristic is invoked in `analyzer.ts` after the DeFiLlama provider step completes, only when `protocolLabel` or `protocolNameForFriendly` is still unresolved. This means:
- Registry matches are fastest (no network).
- DeFiLlama can still override with TVL data when online.
- The heuristic fills gaps that DeFiLlama misses (e.g., new deployments, implementation contracts).

## Before/After Examples

### Before: Balancer V2 Vault
```
Protocol: Unknown
Contract: 0xba12222222228d8ba445958a75a0704d566bf2c8
```

### After: Balancer V2 Vault
```
Protocol: Balancer V2 (balancer-v2)
Contract: 0xba12222222228d8ba445958a75a0704d566bf2c8
✓ Recognized protocol: Balancer V2
```

### Before: SushiSwap Router (known spender, no protocol label)
```
Spender: SushiSwap Router (0xd9e1...8b9f)
Protocol: Unknown
```

### After: SushiSwap Router (name heuristic)
```
Spender: SushiSwap Router (0xd9e1...8b9f)
Protocol: SushiSwap
```

### Before: Proxy with AavePoolV3 implementation name
```
Contract: 0x1234...5678 → AavePoolV3 (impl)
Protocol: Unknown
```

### After: Name heuristic infers Aave
```
Contract: 0x1234...5678 → AavePoolV3 (impl)
Protocol: Aave
```

## Explicit Limits

1. **No safety/threshold changes** — `KNOWN_PROTOCOL` finding is `level: "safe"` and cannot escalate risk. Recommendation logic is untouched.
2. **ETH + Base only for new entries** — Arbitrum/Optimism/Polygon coverage is future work. Existing entries for those chains are preserved.
3. **Root contracts only** — we map routers, vaults, and primary adapters, not individual pool/pair contracts (those are thousands of addresses and better served by DeFiLlama API or future factory-pattern heuristics).
4. **Name heuristics are conservative** — only high-confidence keywords trigger (e.g., "uniswap", "aave", "seaport"). Generic words like "swap", "pool", "vault" do NOT trigger.
5. **No new network calls** — all additions are deterministic/offline. The DeFiLlama API path is unchanged.
6. **Factory/CREATE2 pattern matching is out of scope** — Phase 2 could infer protocol from factory deployer addresses (e.g., Uniswap V3 pool factory → all child pools).

## Test Coverage

- **71 new unit tests** across 3 test files:
  - `test/protocols/top-protocol-registry.unit.test.ts` — 38 tests covering all registry entries, cross-chain isolation, case-insensitivity, negative cases.
  - `test/protocols/fallback-heuristics.unit.test.ts` — 19 tests covering registry passthrough, known-spender name heuristic, implementation name heuristic, proxy name heuristic, priority ordering, negative cases.
  - `test/providers/defillama.test.ts` — 14 new offline-only tests for Phase 1 protocols (Balancer, CoW, 0x, Morpho, Seaport, 1inch V6, Cap, weETH, Base entries).
- **Full suite green**: 303 pass, 0 fail (85 skip = live-API tests).

## Files Changed

- `src/protocols/top-protocol-registry.ts` — NEW: compact address→protocol index
- `src/protocols/fallback-heuristics.ts` — NEW: deterministic name-based inference
- `src/providers/defillama.ts` — refactored to use top-protocol-registry instead of inline `KNOWN_PROTOCOL_ADDRESSES`
- `src/analyzer.ts` — invoke fallback heuristics when DeFiLlama misses
- `test/protocols/top-protocol-registry.unit.test.ts` — NEW
- `test/protocols/fallback-heuristics.unit.test.ts` — NEW
- `test/providers/defillama.test.ts` — expanded with Phase 1 entries
- `docs/artifacts/2026-02-12-top-protocol-label-expansion-phase1.md` — this artifact
