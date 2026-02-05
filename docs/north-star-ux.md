# North-star pre-sign UX (one-screen)

Goal: define the canonical, *one-screen* (wallet-friendly) output for a **pre-sign** transaction scan.

This spec intentionally matches the current `renderResultBox()` layout (CLI/proxy), and defines which lines are **required**, which are **optional**, and how to communicate **uncertainty**.

> Scope: human-readable output (terminal / wallet relay). The JSON API can contain additional detail.

---

## 1) Output structure (single screen)

### 1.1 Header (outside the box) — REQUIRED

A single heading line, then a blank line:

```
Tx scan on <chain>

<box>
```

- `<chain>` is the resolved chain name (e.g. `ethereum`, `base`).

### 1.2 Unified box — REQUIRED

The box is a single bordered region, with:

1) **Summary header lines** (top, before the first divider)
2) **Section blocks** separated by dividers

#### 1.2.1 Summary header lines — REQUIRED

Order and required/optional lines:

1. `Chain: <chain>` — REQUIRED
2. `Protocol: <protocol>` — REQUIRED
   - If we also have a canonical slug and it differs from display name, suffix in parens: `Protocol: Uniswap (uniswap)`
3. `Action: <action>` — REQUIRED when calldata is present, otherwise OMIT
   - Source priority: explicit intent → decoded signature → `Unknown action`
4. `Contract: <contract label>` — REQUIRED
   - If proxy: `ProxyName → ImplementationName`
   - Otherwise: `ContractName` or address

#### 1.2.2 Sections — REQUIRED, fixed order

Sections must appear in this order (no reordering):

1. `🧾 CHECKS`
2. `🛡️ POLICY / ALLOWLIST` — OPTIONAL (only when policy is configured)
3. `💰 BALANCE CHANGES`
4. `🔐 APPROVALS`
5. `📊 RISK`

Each section is designed to answer one question quickly.

---

## 2) Section semantics

### 2.1 🧾 CHECKS

Purpose: static contract sanity + high-signal findings.

Required lines (conceptually; exact wording may evolve but must preserve meaning):

- Verification status (one of):
  - `✓ Source verified`
  - `⚠️ Source not verified (or unknown)`
- Proxy/upgradeable indicator when detected:
  - `⚠️ Proxy / upgradeable (code can change)`
- Known protocol indicator when present:
  - `✓ Known protocol: <name>`
- Up to **4** additional “important” findings (deduped), excluding `CALLDATA_DECODED`.

Surfacing rule (north-star):
- **Front-and-center**: danger/warning findings and key safe signals (`VERIFIED`, `KNOWN_PROTOCOL`).
- **Detail-only**: low-signal info findings (selector candidates, raw signature lists).

### 2.2 🛡️ POLICY / ALLOWLIST (optional)

Purpose: explicit allowlist/policy gating that a wallet (or other caller) can configure to restrict **endpoints**.

This section is **optional** and must only render when the caller has configured a policy/allowlist.

What must show (front-and-center):
- **Allowed endpoints** (when known), grouped by role:
  - `to` (called contract)
  - `recipient`
  - `spender`
  - `operator`
- **Non-allowlisted endpoints** (when any): clearly marked as not allowlisted
- **Allowed protocol (soft)** (when configured): a positive hint only; it never overrides simulation uncertainty
- A final **policy decision**: `ALLOW | PROMPT | BLOCK`

Policy behavior rules (v1):

1) **Non-allowlisted endpoints**
- If any endpoint is not allowlisted, the scan must be treated as at least **CAUTION/WARNING**.
- Policy enforcement must be at least `PROMPT`.
- In **wallet mode**, default is `BLOCK` for any non-allowlisted endpoint.

2) **Simulation uncertainty overrides allowlists**
- If the scan is **INCONCLUSIVE** due to simulation not run/failed/not-high-confidence, the policy decision must be `BLOCK` **even if all endpoints are allowlisted**.
- Rationale: allowlists do not protect against intent mismatch or unseen balance changes.

> Note: policy decisions are distinct from `📊 RISK` labels; policy is an explicit integration control surface.

### 2.3 💰 BALANCE CHANGES

Purpose: show *what you will send/receive* (or explicitly state that we cannot know).

Required first line:
- Section title: `💰 BALANCE CHANGES`

Then one of the following states:

1) **No calldata**
- `- Not available (no calldata)`

2) **Simulation not run / missing**
- `- Simulation failed (not run)`

3) **Simulation failed / reverted**
- `- Simulation failed (<reason>)` (reason optional)
- Optional hint lines (if present, derived from simulation notes):
  - `- <hint text>`
- Optional partial estimates:
  - `- Partial estimates:`
  - `- <summary line>`
- Otherwise:
  - `- Balance changes unknown`

4) **Simulation succeeded**
- If no changes:
  - `- No balance changes detected` (+ optional confidence note)
- If changes exist:
  - Outbound: `- You sent <amount>` (or `Sender sent` when sender is unknown)
  - Inbound: `- You received <amount>`
- Optional confidence note line when confidence != high:
  - `- Note: <medium|low> confidence`

### 2.4 🔐 APPROVALS

Purpose: show *who will be allowed to spend/use your assets*.

Required first line:
- Section title: `🔐 APPROVALS`

Then one of the following states:

1) **No calldata**
- `- Not available (no calldata)`

2) **Simulation failed/not run and no approval signals**
- `- Approvals unknown (simulation failed)`

3) **Simulation failed/not run but we have partial signals**
- `- Partial approvals (simulation failed):`
- Then a bulleted list of approvals found from calldata and/or partial simulation.

4) **Simulation succeeded**
- If none:
  - `- None detected` (+ optional confidence note)
- Otherwise list approvals:
  - Unlimited approvals should be visually prominent (e.g. `⚠️` prefix)

#### Endpoint terms used in approvals
- **Spender** (ERC-20 approve / Permit2): the address that can transfer tokens.
- **Operator** (ERC-721 / ERC-1155 ApprovalForAll): the address that can transfer *all* NFTs in a collection.

### 2.5 📊 RISK

Purpose: the “go / slow / stop” decision line.

Required lines:

1) `📊 RISK: <label>` — REQUIRED
   - Label set is: `SAFE | LOW | MEDIUM | HIGH | CRITICAL`
   - Source priority:
     - AI risk score → mapped label
     - Otherwise recommendation → mapped label (`ok→SAFE`, `caution→LOW`, `warning→MEDIUM`, `danger→HIGH`)

2) `⚠️ INCONCLUSIVE: <reason> — balances/approvals may be unknown` — REQUIRED **when simulation is uncertain**
   - Simulation is *uncertain* if calldata is present and:
     - simulation was not run, OR
     - simulation failed, OR
     - simulation confidence is not `high`

#### Simulation-uncertain behavior
- If simulation is uncertain and the computed label would have been `SAFE`, it must be bumped to `LOW`.
- The UI must explicitly tell the user it is **INCONCLUSIVE**.

This prevents a false “SAFE” in wallet fast-mode, provider timeouts, or simulation failures.

---

## 3) Unknown / skipped signals

Pre-sign UX must never silently omit important signals.

### 3.1 Wallet fast-mode / latency budgets
If the caller chooses a reduced-latency mode ("fast-mode"), any skipped signals must be rendered as **unknown/skipped**, not as negative findings.

Examples (preferred phrasing):
- `- Simulation skipped (wallet fast-mode)`
- `- Verification unknown (provider skipped)`

### 3.2 Provider timeouts / partial provider failures
If a provider times out or errors, we should:
- Keep whatever data is available.
- Add an explicit unknown line in the relevant section.

Examples:
- `- Protocol match unknown (provider timeout)`
- `- Contract age unknown (Etherscan timeout)`

### 3.3 Skipped vs unknown vs none
- **None**: we checked, and there were no items (e.g. "None detected")
- **Unknown**: we could not determine (timeout/error)
- **Skipped**: we chose not to run it (fast-mode)

---

## 4) Endpoints (recipients / spenders / operators)

In pre-sign context, an **endpoint** is any address the user is effectively interacting with or granting power to.

Endpoint categories:

1) **Recipient endpoints**
   - Addresses that will *receive value* (native/erc20/erc721/erc1155) as part of the transaction.
   - Primary sources:
     - Simulation `assetChanges[].counterparty`
     - Calldata decode args like `to`, `recipient`, `dst`, etc.

2) **Spender endpoints**
   - Addresses granted ERC-20 allowance (including Permit2).
   - Sources:
     - Calldata findings (unlimited approvals)
     - Simulation approvals (erc20/permit2)

3) **Operator endpoints**
   - Addresses granted NFT ApprovalForAll.
   - Sources:
     - Simulation approvals (erc721/erc1155 with scope=all)

North-star surfacing:
- Recipients should appear in **BALANCE CHANGES** context (who receives what).
- Spenders/operators should appear in **APPROVALS** context.
- Unknown/unnamed addresses should be shortened and still shown (never hidden).

---

## 5) Determinism (contract-testable)

To keep the UX stable and testable:
- The section order is fixed.
- Presence/absence of the **INCONCLUSIVE** line is deterministic based on simulation state.
- ANSI color codes must be optional (`NO_COLOR=1` should produce clean text output).
