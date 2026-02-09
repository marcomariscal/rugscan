# Assay (formerly Rugscan) Security Audit (current codebase)

Scope reviewed:
- Core analysis flow: `src/analyzer.ts`, `src/approval.ts`, `src/scan.ts`
- Providers: `src/providers/*`
- Calldata/intent/simulation paths: `src/analyzers/calldata/*`, `src/intent/*`, `src/simulations/*`
- CLI and schema: `src/cli/*`, `src/schema.ts`, `src/types.ts`, `src/config.ts`
- Chain config and allowlists: `src/chains.ts`, `src/approvals/*`

This is a static review of the current repository state.

## What works well

- Clear, deterministic findings model and recommendation logic in `src/analyzer.ts` and `src/approval.ts`.
- Sourcify-first verification with Etherscan fallback keeps verification cheap and widely available.
- Proxy detection covers EIP-1967 slots and minimal proxies in `src/providers/proxy.ts`.
- Phishing/scam label lookup uses Etherscan labels and the phish/hack export as a fallback (`src/providers/etherscan.ts`).
- GoPlus integration adds high-signal token security flags (`src/providers/goplus.ts`).
- Approval analysis checks for unlimited approvals, target mismatches, EOAs, unverified/new spender contracts, and typosquats (`src/approval.ts`, `src/approvals/*`).
- Config layering (env + file) is straightforward and explicit (`src/config.ts`).

## Critical gaps for scam detection

These are major blind spots for a pre-signing tool, not just nice-to-haves:

- Permit2 allowances and signature-based approvals are not checked.
- EIP-2612/DAI permit drains are not detected unless calldata analysis is used; the default analysis path does not look at calldata.
- Proxy admin and upgrade authority risk is not assessed; only proxy type is reported.
- Verified proxy + unverified implementation is not flagged as dangerous.
- No detection for admin-controlled tax/blacklist/maxTx toggles outside GoPlus coverage.
- No token metadata or brand typosquat detection (only spender address typosquats).
- Multicall/aggregator patterns (approve + transferFrom in one payload) are not decoded in the core path.
- Signature bait (EIP-712, Seaport orders, permit signatures) is not detectable without message inspection.
- NFT approval risks (`setApprovalForAll` for ERC-721/1155) are not surfaced by default analysis.
- Domain/website phishing and front-end hijacking are out of scope (but are common root causes in practice).

## Risk areas in the current implementation

- External dependency trust: Sourcify, Etherscan, GoPlus, DeFiLlama, 4byte, and public RPCs are trusted without cryptographic verification or trust scoring. A compromised or stale source can change findings.
- No request timeouts, retry policy, or circuit breaker for provider fetches. A slow provider can stall the CLI.
- Etherscan age/tx count heuristics use the account tx list and are inaccurate for create2, internal-creation-only contracts, and high-activity contracts (tx count is capped by offset).
- Sourcify verification treats any returned files as verified, without checking full vs partial verification.
- Proxy detection reports beacon address as `implementation` for beacon proxies; implementation is not resolved or verified.
- Known protocol matching via DeFiLlama is not authoritative for contract addresses. False-positive matches can result in a `KNOWN_PROTOCOL` safe finding that may downgrade recommendation to `caution`.
- Approval analysis treats RPC failures as non-contract, which can produce a false `APPROVAL_TO_EOA` danger finding.
- CLI address validation only checks prefix and length (`src/cli/index.ts`), so non-hex addresses can pass and cause inconsistent results.
- Calldata analysis relies on 4byte signatures which are ambiguous; without display of confidence, results can mislead.
- Balance simulation is best-effort. It can be fooled by state changes, non-standard events, or proxy indirection. Simulation results do not affect recommendation, which can confuse users.
- Provider results are not normalized by confidence; all findings are treated as equally trustworthy.

## Trust assumptions

The current design implicitly assumes:

- RPC endpoints return accurate chain state and are not censored or tampered with.
- Sourcify/Etherscan verification data is correct and current.
- Etherscan labels and phish/hack exports are accurate and not poisoned.
- GoPlus security flags are accurate for the chain and token.
- DeFiLlama protocol data maps correctly to on-chain addresses.
- 4byte signatures are correct and not maliciously inserted.
- Local system time is correct (age calculation uses `Date.now()`).
- Users understand that "verified" and "known protocol" do not imply safety.
