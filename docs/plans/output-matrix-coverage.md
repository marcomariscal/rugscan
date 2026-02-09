# Output matrix coverage plan (high-leverage, minimal)

## Goal
Expand **text output** coverage with a compact matrix that locks high-signal branches without exploding fixtures.

## Why this matrix (vs exhaustive combos)
The user-facing output branches mostly on:
1. **Threat signal** (danger/warning/caution/ok)
2. **Simulation certainty** (high vs inconclusive/failure)
3. **Verification state** (verified vs unverified)
4. **Transaction archetype** (contract scan, approval, swap, intricate DeFi, Safe ingest)

A minimal matrix that hits each branch once gives high confidence with low maintenance.

## Selected matrix

| Scenario | Primary branch coverage | Secondary coverage | Type |
|---|---|---|---|
| Malicious phishing contract | danger + no-calldata contract output | phishing finding ordering, BLOCK action | render fixture/golden |
| Malicious approval | danger approval path | unlimited approval rendering + dangerous spender messaging | render fixture/golden |
| Unverified contract | unverified checks context | warning recommendation + no-calldata next-action wording | render fixture/golden |
| Weird/inconclusive edge | simulation failure + INCONCLUSIVE wording | hints + partial balance estimate rendering | render fixture/golden |
| Happy-path swap | ok + high-confidence simulation | swap intent upgrade from simulation + actor-based balance wording | render fixture/golden |
| Intricate DeFi action | caution path with proxy contract | multi-asset balance changes + mixed approval changes (grant/revoke) | render fixture/golden |
| Intricate Safe tx output | Safe CLI success text path | multisend summary fields (kind/safe/calls) | CLI fixture test |
| Broken Safe tx output | Safe CLI error text path | invalid fixture parse failure surfaced to stderr | CLI fixture test |

## Implementation plan
1. Add a single scenario source (`test/fixtures/output-matrix/scenarios.ts`) for six scan-output cases.
2. Add deterministic goldens (`test/fixtures/output-matrix/*/rendered.txt`) and lock full output equality.
3. Add key assertion checks per scenario to guard critical phrasing.
4. Add Safe CLI matrix tests for both success and broken fixture paths.
5. Keep fixture count small (6 scan + 2 Safe paths) to avoid combinatorial growth.

## Validation
- `bun run check`
- `bun test test/output-matrix-text.contract.test.ts test/safe-cli-output-matrix.unit.test.ts`
- Re-run touched baseline snapshot-style output tests if needed (none expected for this scoped matrix)
