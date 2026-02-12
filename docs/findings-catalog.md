# Findings catalog (`finding.code`)

This doc enumerates the current `FindingCode` union in `src/types.ts`, where each code comes from, and how it should surface in the north-star pre-sign UI.

Key concepts:
- **Data source** is one of: `calldata`, `simulation`, `provider`, or `heuristic` (derived from simulation/provider results).
- **Surface** indicates where this finding should appear:
  - **Front-and-center**: shown in `🧾 CHECKS` (or the dedicated BALANCE/APPROVALS sections)
  - **Detail**: available in structured output, logs, or an “expanded details” UI

> Note: “Surface” is a UX policy; the renderer may evolve, but the intent here is to keep wallet UX high-signal and readable.

---

## Current surfacing rules (CLI/proxy)

Today’s `renderChecksSection()` surfaces:
- all `danger` + `warning` findings
- plus safe signals `VERIFIED` and `KNOWN_PROTOCOL`
- with special ordering preference: `KNOWN_PHISHING`, `UNVERIFIED`, `UPGRADEABLE`, `NEW_CONTRACT`
- deduped by code, and capped at 4 additional finding lines
- `CALLDATA_DECODED` is intentionally **not** shown as a finding line (it influences `Action:`)

`💰 BALANCE CHANGES` and `🔐 APPROVALS` have their own rendering and do **not** rely solely on findings.

---

## Codes

### Danger

#### `UNVERIFIED`
- Trigger: contract source not verified by Sourcify/Etherscan
- Source: provider (Sourcify/Etherscan)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center** (CHECKS)

#### `HONEYPOT`
- Trigger: token security provider indicates honeypot (`is_honeypot === true`)
- Source: provider (GoPlus)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center** (CHECKS)

#### `HIDDEN_MINT`
- Trigger: token is mintable (`is_mintable === true`)
- Source: provider (GoPlus)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center** (CHECKS)

#### `SELFDESTRUCT`
- Trigger: token can selfdestruct (`selfdestruct === true`)
- Source: provider (GoPlus)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center** (CHECKS)

#### `OWNER_DRAIN`
- Trigger: owner can change balances (`owner_can_change_balance === true`)
- Source: provider (GoPlus)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center** (CHECKS)

#### `APPROVAL_TARGET_MISMATCH`
- Trigger: approval spender mismatches expected spender / called contract
- Source: calldata + context (heuristic)
- Where: `src/approval.ts`
- Surface: **Front-and-center** (CHECKS or a dedicated approvals-details view)

#### `APPROVAL_TO_EOA`
- Trigger: spender is not a contract (EOA/empty)
- Source: provider/RPC (`isContract`)
- Where: `src/approval.ts`
- Surface: **Front-and-center**

#### `POSSIBLE_TYPOSQUAT`
- Trigger: spender address resembles a known spender list entry
- Source: heuristic (address similarity) + known spender list
- Where: `src/approval.ts`, `src/approvals/typosquat.ts`
- Surface: **Front-and-center**

#### `APPROVAL_TO_DANGEROUS_CONTRACT`
- Trigger: spender risk scan contains danger findings
- Source: heuristic (derived from deterministic spender checks)
- Where: `src/approval.ts`
- Surface: **Front-and-center**

#### `KNOWN_PHISHING`
- Trigger: Etherscan labels/nametag contain phishing keywords
- Source: provider (Etherscan labels)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center**, highest priority (CHECKS)

#### `SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR`
- Trigger: simulation shows ApprovalForAll granted to an unknown operator (not in known spender list)
- Source: simulation + heuristic
- Where: `src/simulations/verdict.ts`
- Surface: **Front-and-center** (CHECKS) and also relevant to APPROVALS endpoints

#### `SIM_MULTIPLE_OUTBOUND_TRANSFERS`
- Trigger: simulation shows multiple outbound transfers (multiple counterparties and/or many outflows)
- Source: simulation + heuristic
- Where: `src/simulations/verdict.ts`
- Surface: **Front-and-center** (CHECKS) and supported by BALANCE CHANGES section

---

### Warning

#### `UNKNOWN_SECURITY`
- Trigger: (reserved) used when security status cannot be determined
- Source: provider/heuristic
- Where: currently **not emitted**
- Surface: **Front-and-center** when added (CHECKS)

#### `BLACKLIST`
- Trigger: token has blacklist functionality (`is_blacklisted === true`)
- Source: provider (GoPlus)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center**

#### `HIGH_TAX`
- Trigger: transfer tax exceeds threshold (currently > 10%)
- Source: provider (GoPlus)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center**

#### `NEW_CONTRACT`
- Trigger: contract age < 7 days
- Source: provider (Etherscan metadata)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center**, prioritized in CHECKS

#### `UPGRADEABLE`
- Trigger: proxy detected (upgradeable)
- Source: provider/RPC (proxy detection)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center**, prioritized in CHECKS

#### `UNLIMITED_APPROVAL`
- Trigger:
  - approval tx amount is MAX_UINT256 (`src/approval.ts`), OR
  - decoded calldata for `approve`/`permit` has max allowance (`src/analyzers/calldata/index.ts`)
- Source: calldata (decode) or heuristic (approval analyzer)
- Surface: **Front-and-center** in `🔐 APPROVALS` (must be visually prominent)

#### `SIM_UNLIMITED_APPROVAL_UNKNOWN_SPENDER`
- Trigger: simulation shows unlimited ERC-20/Permit2 approval to unknown spender
- Source: simulation + heuristic
- Where: `src/simulations/verdict.ts`
- Surface: **Front-and-center** (CHECKS) and also relevant to APPROVALS

#### `APPROVAL_TO_UNVERIFIED`
- Trigger: spender is a contract but unverified
- Source: provider (Sourcify/Etherscan)
- Where: `src/approval.ts`
- Surface: **Front-and-center**

#### `APPROVAL_TO_NEW_CONTRACT`
- Trigger: spender is a contract deployed < 7 days ago
- Source: provider (Etherscan metadata)
- Where: `src/approval.ts`
- Surface: **Front-and-center**

---

### Info

#### `LOW_ACTIVITY`
- Trigger:
  - contract tx count < 100, OR
  - address is not a contract (EOA/empty) uses `LOW_ACTIVITY` as a proxy warning
- Source: provider (Etherscan metadata) + RPC heuristic
- Where: `src/analyzer.ts`
- Surface: **Front-and-center** only when it meaningfully affects trust; otherwise detail

#### `PROXY`
- Trigger: proxy detected (informational companion to `UPGRADEABLE`)
- Source: provider/RPC (proxy detection)
- Where: `src/analyzer.ts`
- Surface: **Detail** (usually redundant if `UPGRADEABLE` is shown)

#### `CALLDATA_DECODED`
- Trigger: calldata was decoded via known ABI / Sourcify ABI / selector signatures
- Source: calldata + provider (Sourcify ABI) + signature DB
- Where: `src/analyzers/calldata/index.ts`
- Surface: **Detail** as a finding line, but **feeds** the `Action:` line

#### `CALLDATA_UNKNOWN_SELECTOR`
- Trigger: selector not found in signature DB
- Source: calldata
- Where: `src/analyzers/calldata/index.ts`
- Surface: **Detail**

#### `CALLDATA_SIGNATURES`
- Trigger: selector matched signatures but none decoded successfully
- Source: calldata
- Where: `src/analyzers/calldata/index.ts`
- Surface: **Detail**

#### `CALLDATA_EMPTY`
- Trigger: calldata missing selector (empty or too short)
- Source: calldata
- Where: `src/analyzers/calldata/index.ts`
- Surface: **Detail** (but may explain why simulation/intent is limited)

---

### Safe

#### `VERIFIED`
- Trigger: contract source verified
- Source: provider (Sourcify/Etherscan)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center** (CHECKS) as a positive trust signal

#### `KNOWN_PROTOCOL`
- Trigger: protocol match found
- Source: provider (DeFiLlama)
- Where: `src/analyzer.ts`
- Surface: **Front-and-center** (CHECKS)
