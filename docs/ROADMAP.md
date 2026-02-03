# Rugscan Roadmap ("Blowfish, but open source and local")

Effort scale:
- S: 0.5-1 day
- M: 2-4 days
- L: 1-2 weeks
- XL: 2+ weeks

The phases below reflect the simplification plan and a staged path to 99% and 99.9% coverage.

## Phase 1: Core simplification (minimal local CLI)
Goal: ship a fast, local `rugscan check` and `rugscan approval` with high-signal findings only.

Tasks (Phase 1)
1) Collapse CLI to `check` + `approval` only, remove `scan` and `analyze`
   - Files: `src/cli/index.ts`, `src/cli/ui.ts`, `README.md`
   - Effort: M

2) Remove AI analysis feature and config plumbing
   - Files: `src/providers/ai.ts`, `src/analyzer.ts`, `src/types.ts`, `src/config.ts`, `README.md`, `package.json`
   - Effort: M

3) Remove simulation, calldata decoding, and intent system from the core path
   - Files: `src/scan.ts`, `src/analyzers/calldata/*`, `src/intent/*`, `src/simulations/*`, `src/schema.ts`, `src/types.ts`
   - Effort: L

4) Remove server + SDK surfaces (focus on local CLI)
   - Files: `src/server/index.ts`, `src/sdk/index.ts`, `README.md`, `package.json`
   - Effort: S

5) Replace DeFiLlama dependency with a small local allowlist
   - Files: `src/providers/defillama.ts` (remove), new `src/providers/allowlist.ts`, `src/analyzer.ts`, `src/types.ts`
   - Effort: M

6) Simplify output to 1-3 line summary with deterministic exit codes
   - Files: `src/cli/ui.ts`, `src/analyzer.ts`, `src/approval.ts`
   - Effort: M

7) Prune docs and tests that reference removed features
   - Files: `docs/*`, `test/*`, `README.md`
   - Effort: S

Phase 1 success criteria
- `rugscan check 0x...` completes in seconds and prints 1-3 findings
- No AI, server, or simulation dependencies
- Exit codes reflect severity (0 ok, 1 risky, 2 danger)
- No external writes, no background services

## Phase 2: 99% coverage (practical additions)
Goal: add the highest-yield checks that cover most remaining scams without full tracing.

Tasks (Phase 2)
1) Permit2 allowance detection
   - Add Permit2 allowance reads and checks against unknown spenders
   - Files: new `src/providers/permit2.ts`, `src/approval.ts`, `src/analyzer.ts`, `src/types.ts`, `src/constants.ts`
   - Effort: M

2) Detect permit/permit2 usage in calldata (minimal decoder)
   - If calldata is present, flag permit/permit2 selectors and unknown spenders
   - Files: new lightweight decoder in `src/analyzers/permit.ts` or reintroduce a minimal subset of `src/analyzers/calldata/*`
   - Effort: M

3) Proxy admin / upgrade authority risk
   - Read admin slot for EIP-1967, check if admin is EOA, and flag unverified admin contracts
   - Files: `src/providers/proxy.ts` (admin read), new `src/providers/proxy-admin.ts`, `src/analyzer.ts`, `src/types.ts`
   - Effort: M

4) Require verified implementations for proxies
   - If proxy is verified, ensure implementation is verified too
   - Files: `src/analyzer.ts`, `src/providers/sourcify.ts`, `src/types.ts`
   - Effort: S

5) Admin-controlled tax/blacklist toggles
   - Scan ABI/bytecode for common admin setters (`setTax`, `setBlacklist`, `setMaxTx`)
   - Files: new `src/analyzers/bytecode.ts`, `src/providers/sourcify.ts`, `src/analyzer.ts`, `src/types.ts`
   - Effort: M

6) Fee-on-transfer detection via on-chain reads
   - Read and validate common `tax`/`fee` variables if present; flag >20%
   - Files: new `src/analyzers/token-fee.ts`, `src/providers/proxy.ts` (for impl ABI), `src/analyzer.ts`
   - Effort: M

7) Token metadata typosquat detection
   - Compare token name/symbol against curated list of top tokens
   - Files: new `src/analyzers/metadata-typosquat.ts`, `src/providers/allowlist.ts`, `src/analyzer.ts`
   - Effort: M

Phase 2 success criteria
- Detect common permit-based drains and unknown spender approvals
- Proxy upgrade risks are surfaced with clear danger/warning findings
- Token tax/blacklist toggles are flagged when discoverable
- Allowlist is local, deterministic, and auditable

## Phase 3: 99.9% coverage (edge cases)
Goal: cover advanced scams that require deeper context, simulation, or message inspection.

Tasks (Phase 3)
1) Multicall bundle decoding
   - Decode multicall payloads and surface hidden approvals/transfers
   - Files: new `src/analyzers/multicall.ts`, optional minimal calldata decoding utilities
   - Effort: L

2) EIP-712 / signature bait detection
   - Parse typed data payloads when available and warn on risky fields
   - Files: new `src/analyzers/eip712.ts`, CLI input support for message payloads
   - Effort: L

3) Delegatecall and dynamic-call detection
   - Static scan for delegatecall to user-supplied or configurable addresses
   - Files: `src/analyzers/bytecode.ts` (extended), `src/analyzer.ts`
   - Effort: L

4) Bridge / cross-chain risk profiling
   - Allowlist canonical bridges; warn on unknown bridge approvals
   - Files: `src/providers/allowlist.ts`, `src/analyzer.ts`, `src/approval.ts`
   - Effort: M

5) Domain phishing and frontend hijack warnings (opt-in)
   - Local blocklist + "new domain" heuristics for URLs supplied by the user
   - Files: new `src/analyzers/domain.ts`, CLI flags for URL input
   - Effort: M

6) Optional transaction simulation (reintroduced as opt-in)
   - Use local anvil fork or a lightweight trace provider; no default reliance
   - Files: `src/simulations/*` (reintroduced or redesigned), `src/cli/index.ts`
   - Effort: XL

Phase 3 success criteria
- Payload-aware warnings for multicall and signature-based drains
- Clear opt-in flow for high-cost analysis steps
- No hidden network dependencies; all external calls are explicit and configurable

## Ongoing quality work
- Add provider timeouts and retry budgets
- Add confidence scoring per provider and per finding
- Expand tests for provider error handling and false-positive scenarios
- Maintain a local, versioned allowlist with change logs
