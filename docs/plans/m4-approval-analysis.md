# M4: Approval Analysis — Implementation Plan

## Goals
- Analyze token approval transactions before signing.
- Detect dangerous approval patterns with clear findings.
- Provide a standalone `analyzeApproval` API + CLI subcommand.
- Return a full `spenderAnalysis` for deeper inspection.

## Non-Goals (explicit)
- On-chain execution simulation or trace-based approval detection.
- ERC-2612/Permit2 signature validation logic (we only analyze the approval intent).
- Heuristic detection beyond known protocol address lists.
- Decimal token amount parsing (CLI will accept integer strings or `max`).

## Assumptions / Open Decisions
- **Meaning of `calledContract`**: We assume it refers to the dapp contract the user intends to call (e.g., a swap router). If this is actually the ERC-20 token contract for `approve()`, the mismatch signal will be noisy. If this assumption is wrong, we should change the mismatch logic to prefer `expectedSpender` only.
- **Danger findings on spender**: The new finding list doesn’t include a code for “spender has danger findings.” I plan to surface spender danger via `spenderAnalysis` and (optionally) elevate the overall recommendation. If we need a dedicated code, we should add one now.
- **Verification + age sources**: Unverified and age (<7 days) rely on Sourcify + Etherscan. If no Etherscan key is present, age may be undefined and the “new contract” flag will be best-effort.
- **Known addresses for typosquat**: We’ll maintain a minimal, curated list of known router/protocol spender addresses per chain. If you want this sourced from a registry or a config file, say so.
- **Spender analysis**: `analyze()` is deterministic-only in v1; `spenderAnalysis` never uses cloud services.

If any of these assumptions are wrong, please confirm before implementation.

## Success Criteria
- `analyzeApproval()` returns `ApprovalAnalysisResult` with flags and findings.
- Each core detection feature triggers its specified finding codes.
- `rugscan approval ...` works with or without context, produces clear output, and uses exit codes consistent with existing CLI behavior.
- Typosquat detection triggers only for “near misses,” not exact matches.

---

## 1. Data Model Changes

### New Types (`src/types.ts`)
Add approval-specific types and finding codes:

```ts
export type FindingCode =
  // ...existing
  | "UNLIMITED_APPROVAL"
  | "APPROVAL_TARGET_MISMATCH"
  | "APPROVAL_TO_EOA"
  | "APPROVAL_TO_UNVERIFIED"
  | "APPROVAL_TO_NEW_CONTRACT"
  | "POSSIBLE_TYPOSQUAT";

export interface ApprovalTx {
  token: string;
  spender: string;
  amount: bigint;
}

export interface ApprovalContext {
  expectedSpender?: string;
  calledContract?: string;
}

export interface ApprovalAnalysisResult {
  recommendation: Recommendation;
  findings: Finding[];
  spenderAnalysis: AnalysisResult;
  flags: {
    isUnlimited: boolean;
    targetMismatch: boolean;
    spenderUnverified: boolean;
    spenderNew: boolean;
    possibleTyposquat: boolean;
  };
}
```

Notes:
- Keep the new types colocated with existing `AnalysisResult` types.
- Avoid `as` casts; use type guards where needed.

---

## 2. Approval Analysis Flow

### New module
Create `src/approval.ts` (or `src/approvals/analyze.ts`) to implement `analyzeApproval`:

High-level steps:
1. Normalize addresses (lowercase).
2. Detect spender EOA vs contract using `proxy.isContract`.
3. Run `analyze(spender, chain, config)` to produce `spenderAnalysis`.
4. Build approval findings and flags based on:
   - Mismatch logic
   - Spender suspicion (unverified, new, EOA, danger findings)
   - Unlimited approval
   - Typosquat detection
5. Derive recommendation from approval findings (not from `spenderAnalysis` alone).

### Recommendation mapping (proposal)
- `danger`: `APPROVAL_TO_EOA`, `POSSIBLE_TYPOSQUAT`, or `APPROVAL_TARGET_MISMATCH`.
- `warning`: `UNLIMITED_APPROVAL`, `APPROVAL_TO_UNVERIFIED`, `APPROVAL_TO_NEW_CONTRACT`.
- `caution`: multiple warnings but no danger.
- `ok`: no findings.

If you want a different severity mapping, we should lock that now.

---

## 3. Detection Details

### 3.1 Approval Target Mismatch
- If `context.expectedSpender` is provided and differs from `approvalTx.spender` (case-insensitive), add:
  - Finding: `APPROVAL_TARGET_MISMATCH`
  - Flag: `targetMismatch = true`
- Else if `context.calledContract` is provided and differs from `approvalTx.spender`, add the same finding.

Notes:
- We’ll treat exact matches as safe.
- If both `expectedSpender` and `calledContract` exist and disagree with each other, surface mismatch and include both in the message.

### 3.2 Approval to Suspicious Contracts
- **EOA spender**: if `proxy.isContract(spender)` returns false → `APPROVAL_TO_EOA` (danger).
- **Unverified spender**: if `spenderAnalysis.contract.verified === false` → `APPROVAL_TO_UNVERIFIED` (warning).
- **New spender**: if `spenderAnalysis.contract.age_days !== undefined && < 7` → `APPROVAL_TO_NEW_CONTRACT` (warning).
- **Danger findings**: if `spenderAnalysis.findings` contains danger-level items, elevate overall recommendation and include a summary line in output.

### 3.3 Unlimited Approvals
- If `approvalTx.amount === MAX_UINT256`:
  - Finding: `UNLIMITED_APPROVAL` (warning)
  - Flag: `isUnlimited = true`

`MAX_UINT256` should be a shared constant (BigInt literal) to avoid drift.

### 3.4 Lookalike Address Detection
- Maintain a curated list of known spender addresses by chain.
- Implement `isPossibleTyposquat(spender, knownAddress)` using Levenshtein distance.
- Trigger `POSSIBLE_TYPOSQUAT` if:
  - `spender` is not an exact match, and
  - distance ≤ 2 (or a small threshold), and
  - the prefix/suffix also matches (to reduce false positives).

The finding message should include the protocol name + known address.

---

## 4. Typosquat Utilities

### New files
- `src/approvals/known-spenders.ts`
  - map of `Chain -> { name, address }[]`
- `src/approvals/typosquat.ts`
  - `levenshtein(a, b)`
  - `isPossibleTyposquat(candidate, knownList)`

Optionally, extract the existing `KNOWN_PROTOCOL_ADDRESSES` from `defillama.ts` into a shared module to avoid duplication. This is a tradeoff: touching existing code vs. having two sources of truth.

---

## 5. CLI Integration

### New subcommand
`rugscan approval --token <addr> --spender <addr> --amount <value> [--expected <addr>] [--called <addr>] [--chain <chain>]`

Parsing:
- `--amount max` → `MAX_UINT256`.
- `--amount <integer>` → `BigInt()`.
- Validate addresses start with `0x` and have length 42.

### Output
Add a new render function in `src/cli/ui.ts` (e.g., `renderApprovalBox`) to show:
- Token + spender addresses
- Flags (unlimited, mismatch, typosquat)
- Findings with severity
- Summary recommendation

Exit codes should follow existing logic (`danger`=2, `warning|caution`=1, `ok`=0).

---

## 6. Tests

### Unit tests
- `typosquat.test.ts`: exact match vs. near match vs. distant match.
- `approval.logic.test.ts`:
  - `UNLIMITED_APPROVAL` when amount is max.
  - `APPROVAL_TARGET_MISMATCH` when spender != expected/called.
  - `APPROVAL_TO_EOA` for EOA detection.

### Integration tests
- `approval.test.ts` uses known addresses:
  - Uniswap router spender should not trigger typosquat.
  - A single-character changed address should trigger typosquat.
  - `spenderAnalysis` returns verified status for known contracts.

To make tests reliable without heavy network calls, split core logic into pure functions and mock provider calls.

---

## 7. Files & Touch Points

Planned updates:
- `src/types.ts` — new approval types + finding codes
- `src/approval.ts` — `analyzeApproval` implementation
- `src/approvals/known-spenders.ts` — curated known addresses
- `src/approvals/typosquat.ts` — Levenshtein + match helpers
- `src/index.ts` — export `analyzeApproval`
- `src/cli/index.ts` — add `approval` subcommand and flags
- `src/cli/ui.ts` — new output renderer
- `test/approval.test.ts` + `test/typosquat.test.ts`
- `README.md` — add approval usage + flags

---

## 8. Implementation Order

1. Add types + finding codes in `src/types.ts`.
2. Add typosquat utilities + known spender list.
3. Implement `analyzeApproval` with flags + findings.
4. Add CLI subcommand + UI output.
5. Add tests (unit + integration).
6. Update README.

If you want strict TDD, I can reorder steps 2–5 to scaffold tests first.

---

## 9. Manual Verification Checklist

- `rugscan approval --token 0xUSDC --spender <router> --amount max` → warns on unlimited.
- `--expected` mismatch triggers `APPROVAL_TARGET_MISMATCH`.
- EOA spender triggers `APPROVAL_TO_EOA` + danger exit code.
- Typosquat-like address triggers `POSSIBLE_TYPOSQUAT`.
- Known router address does not trigger typosquat.
- CLI exits with 0/1/2 according to recommendation.
