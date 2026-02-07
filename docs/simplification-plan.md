# Rugscan Simplification Plan

## Assumptions
- Primary product is a local CLI for quick contract checks.
- Goal is high-signal scam detection, not full transaction analysis.
- Outputs should be minimal and actionable (no verbose JSON unless asked).

## Keep (Essential Scam Catchers)
- Approval analysis path (core of drainers/unlimited approvals).
  - `src/approval.ts`
  - `src/approvals/known-spenders.ts`
  - `src/approvals/typosquat.ts`
- Contract verification check (unverified = danger).
  - `src/providers/sourcify.ts`
  - `src/providers/etherscan.ts` (verification + labels only)
- Phishing/scam label detection (Etherscan labels).
  - `src/providers/etherscan.ts`
- GoPlus token security signals (honeypot, hidden mint, owner drain).
  - `src/providers/goplus.ts`
- Minimal protocol allowlist to mark known safe contracts.
  - Keep a trimmed local list only (no remote protocol crawling).

## Cut (Delete Now)
- Balance simulation (Anvil + heuristics).
  - `src/simulations/anvil.ts`
  - `src/simulations/balance.ts`
  - `src/simulations/logs.ts`
  - `test/simulation-e2e.test.ts`
  - `test/fixtures/simulation-config.json`
- Call-data decoding + intent system (overkill for 95% scam detection).
  - `src/analyzers/calldata/*`
  - `src/intent/*`
  - `test/calldata.test.ts`
  - `test/intent.test.ts`
- SARIF output (security tooling integration, not core CLI value).
  - `src/cli/formatters/sarif.ts`
  - `test/sarif.test.ts`
  - `test/fixtures/scan-sarif.json`
- Server + SDK interfaces (multi-interface design).
  - `src/server/index.ts`
  - `src/sdk/index.ts`
  - `test/server.test.ts`
  - `test/sdk.test.ts`
- DeFiLlama protocol crawling (slow, failure-prone, not required).
  - `src/providers/defillama.ts`
  - `test/providers/defillama.test.ts`
- Name-resolution extras (proxy/implementation naming polish).
  - `src/name-resolution.ts` (replace with minimal name resolution)
- Unused research/plan docs that encode deferred scope.
  - `docs/plans/m7-parallel-streaming.md`
  - `docs/plans/m8-multi-interface.md`
  - `docs/plans/balance-simulation.md`
  - `docs/research/*` (move to archive or delete)

## Defer to v2 (Backlog)
- Balance simulation (Anvil or hosted): revisit only if real demand exists.
- Full call trace decoding / intent summaries.
- Multi-interface design (server, SDK, extensions, wallet plugins).
- Provider fallback chains and adaptive retries.
- Rich reporting formats (SARIF, JSON schemas for CI).

## Simplify (Reduce Complexity in-place)
- Analyzer flow: keep only verification + phishing labels + GoPlus + approval analysis.
  - Remove age/tx-count heuristics from Etherscan (extra API calls, low signal).
- Protocol safety: replace DeFiLlama with a small local allowlist (Uniswap, Aave, etc.).
- CLI commands: collapse to `check` and `approval` only.
- Output: fixed minimal text with emoji status and 1-3 key findings.

## New UX (Minimal CLI Experience)
Goal: one-line command, three-line output, clear severity.

Command:
```
rugscan check 0x...
```

Example outputs:
```
→ 🔴 DANGER: Unverified contract, matches drainer pattern
→ ⚠️ RISKY: Unlimited approval to new contract
→ ✅ SAFE: Verified, known protocol (Uniswap)
```

Behavior:
- Print only the top 1-3 findings by severity.
- Always include verification + phishing labels if present.
- Exit codes: 0 = safe, 1 = risky, 2 = danger.
- Optional flags: `--chain`, `--json` (if needed later).

Notes:
- Keep `rugscan approval` for explicit approval checks.
- Remove `rugscan analyze`/`scan` once `check` exists.

## 99% Coverage (What's Missing)

Assumptions for estimates:
- Incremental % reflects share of scams not covered by the 95% set (rough order-of-magnitude).
- Effort is relative to current codebase (S = small additive checks, M = new provider logic, L = deeper tracing).

| Attack Vector | Current Gap | Fix | Effort | Catches |
|--------------|-------------|-----|--------|---------|
| Permit2 allowances + signature-based drains | Approval analysis only checks ERC20 allowances; Permit2 uses its own allowance store + signatures | Add Permit2 allowance check (owner/token/spender) and flag any non-zero Permit2 allowance to unknown spenders | M | +1.0% |
| EIP-2612/DAI permit drains | No detection for off-chain signatures used to grant allowance in a single tx | Detect `permit`/`permit2` selectors in tx calldata and flag when spender is unknown | M | +0.6% |
| Proxy admin upgrade risk | Verified proxy can still be upgraded to malicious logic later | Detect EIP-1967 proxies, read admin/implementation slots; flag if admin is EOA or unverified | M | +0.7% |
| Verified proxy + unverified implementation | Verification check only looks at proxy address | Resolve implementation and require it to be verified too | S | +0.4% |
| Dynamic tax / blacklist / maxTx toggles | GoPlus catches many honeypots but misses runtime toggle of transfer restrictions | Scan for common admin function selectors (`setTax`, `setBlacklist`, `setMaxTx`) in ABI/bytecode and flag if owner-controlled | S | +0.5% |
| Fee-on-transfer edge cases | Some tokens allow buy/sell but drain via extreme transfer fees post-buy | Add on-chain read of `fee`/`tax` variables (if present) and flag above threshold (e.g., >20%) | M | +0.4% |
| Social-engineering with legit-looking contracts | Verified contracts + normal approvals can still be malicious via UI tricks | Add typosquat for token metadata (name/symbol vs known tokens) and flag recent deploys with brand-like names | S | +0.4% |

## 99.9% Coverage (Edge Cases)

These are the last 0.9% — mostly sophisticated flows that require tx simulation, calldata decoding, or off-chain context.
Where detection is unrealistic without full trace or wallet-level inspection, it’s called out explicitly.

| Attack | Why Hard to Catch | Fix | Effort | Reality Check |
|--------|------------------|-----|--------|---------------|
| CREATE2 counterfactual spender / address spoofing in drainers | Spender address may not have code yet and changes per signature; allowlists + proxy checks miss it | Flag Permit/Permit2 spenders with no code or created via CREATE2 factories; warn on counterfactual addresses | M | Heuristic only without tx simulation/mempool context citeturn0search6turn0search10 |
| Multicall bundled drains (e.g., approval → transferFrom via Multicall3) | Payload hides multiple actions inside a trusted aggregator; static contract check looks benign | Decode multicall payloads and flag any `transferFrom`/`setApprovalForAll` or permit calls | L | Requires calldata decoding + trace-level inspection citeturn1search7 |
| EIP-712 signature bait (Permit/Seaport orders, gasless approvals) | No on-chain allowance change before drain; UI can mask spender/value | Add signature/message scanning with human-readable warnings; domain reputation checks | L | Undetectable from contract-only analysis; needs wallet/message inspection citeturn0search1turn1search2turn1search5 |
| Malicious NFT mints using `setApprovalForAll` | Mint tx can hide approval; verified contracts still ask for blanket approval | Detect `setApprovalForAll` selectors in calldata/ABI and flag unknown operator | M | Needs tx decoding; not reliably catchable from contract-only scan citeturn2search5turn2search1 |
| ERC-1155 approval-for-all + batch transfer drains | Approval grants access to *all* IDs; batch transfers obscure which IDs are moved | Warn on any ERC-1155 `setApprovalForAll`, flag batch transfers to new operators | M | You can’t know owned IDs without logs/state indexing citeturn2search6turn2search4 |
| Delegatecall to user-supplied logic (proxy or implementation) | Verified proxy/implementation can still delegatecall to attacker-controlled code | Static scan for `delegatecall` to external/user-provided addresses; flag if present | M | Requires bytecode analysis; high false-positive risk citeturn1search6 |
| Cross-chain message spoofing / bridge validation failures | Exploit depends on off-chain relayer/oracle validation; contract can look normal | Allowlist canonical bridges; flag new/unknown bridges and unlimited approvals to them | L | Largely undetectable without bridge-specific security intelligence citeturn3search0 |
| State-change/TOCTOU attacks vs simulation (fake claim vs drain) | Simulation can be tricked if state changes between sim and execution | Re-simulate close to signing; warn if transaction depends on mutable state | L | Even simulation can be fooled; can’t guarantee safety citeturn1search9 |
| Domain phishing / hijacked frontends | On-chain contracts may be legitimate; attack is the website or domain | Domain blocklist + “new domain” warnings + wallet extension integration | M | Not detectable from chain data alone citeturn1search2turn1search3 |
| Fake DEX orders / fake NFT listings using trusted protocols | Uses known, trusted contracts (e.g., marketplaces), so allowlists pass | Simulate asset movements and compare to expected intent | L | Requires transaction simulation + intent inference citeturn2search0 |
