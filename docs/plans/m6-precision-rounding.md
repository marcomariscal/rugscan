# M6: Precision & Rounding Vulnerability Detection - Implementation Plan

## Goals
- Detect precision loss and rounding error patterns in verified smart contracts.
- Surface common DeFi rounding exploits (vault inflation, donation attacks, truncation).
- Provide clear findings with minimal false positives.

## Non-Goals (explicit)
- Full symbolic math or formal verification.
- On-chain execution simulation.
- Economic analysis of oracle-based pricing (beyond obvious donation/flash manipulation patterns).

## Assumptions / Open Decisions
- **Verified source required for static detection**: if `source` is missing, static checks are skipped.
- **Etherscan SourceCode format**: may be flattened or JSON; v1 will scan the raw string only. If this proves too noisy, we can add parsing for the JSON multi-file format.
- **Static analysis depth**: start with lightweight regex/heuristics. Add AST-based parsing only if false positives are unacceptable.
- **Finding mapping for flash-loan amplification**: use `DONATION_ATTACK` unless we decide to add a dedicated code.

If any of these assumptions are wrong, confirm before implementation.

## Success Criteria
- New finding codes appear on known vulnerable snippets and do not trigger on safe patterns using `mulDiv`/rounding helpers.
- Unit tests cover each detection rule with positive + negative cases.

---

## 1. Data Model Changes

### New finding codes (`src/types.ts`)
Add the codes requested in the API changes:

```ts
export type FindingCode =
  // ...existing
  | "FIRST_DEPOSITOR_VULN"
  | "PRECISION_LOSS"
  | "MISSING_MIN_CHECK"
  | "ROUNDING_TO_ZERO"
  | "DONATION_ATTACK";
```

Severity mapping (proposed):
- `FIRST_DEPOSITOR_VULN` -> danger
- `DONATION_ATTACK` -> danger
- `PRECISION_LOSS` -> warning
- `ROUNDING_TO_ZERO` -> warning
- `MISSING_MIN_CHECK` -> warning

## 3. Static Precision Detector (Optional but Recommended)

### New module
Create `src/detectors/precision.ts` (or similar) exporting:

```ts
export interface PrecisionFinding {
  code: FindingCode;
  level: FindingLevel;
  message: string;
}

export function detectPrecisionIssues(source: string): PrecisionFinding[];
```

### Source preprocessing
- Keep scanning lightweight; avoid full parsing in v1.

### Detection rules (v1 heuristics)

#### 3.1 First Depositor / Vault Inflation
Goal: detect ERC-4626-like share calc without initial deposit safeguards.

Heuristic signals:
- Function names: `deposit`, `mint`, `previewDeposit`, `convertToShares`.
- Formula patterns:
  - `shares = assets * totalSupply / totalAssets`
  - `shares = assets * totalSupply() / totalAssets()`
  - `shares = assets * totalSupply / totalAssets()`
- Missing guard patterns:
  - No `if (totalSupply == 0)` or `totalSupply() == 0` branch.
  - No `require(shares > 0)` or `require(minShares > 0)`.

Finding:
- `FIRST_DEPOSITOR_VULN` (danger) when formula exists without guard.

#### 3.2 Donation / Share Price Manipulation
Heuristic signals:
- `totalAssets()` implemented as `asset.balanceOf(address(this))` or similar.
- Share price uses `totalAssets()` without excluding donated balance.
- Deposit/convert calculation uses current balance prior to transfer.

Finding:
- `DONATION_ATTACK` (danger).

#### 3.3 Division Before Multiplication
Pattern:
- `(a / b) * c` or `a / b * c`.

Exclusions:
- Any use of `mulDiv`, `mulDivDown`, `mulDivUp`, `mulWadDown`, `mulWadUp` in the same function.

Finding:
- `PRECISION_LOSS` (warning).

#### 3.4 Integer Division Truncation / Rounding to Zero
Heuristic signals:
- Division where numerator is a user amount or fee and denominator is large or dynamic:
  - `amount / totalSupply`
  - `fee / 10000`
  - `assets * totalSupply / totalAssets` with no min check.
- Missing guard for `> 0` or `minShares`.

Finding:
- `ROUNDING_TO_ZERO` (warning).

#### 3.5 Missing Slippage/Minimum/Deadline Checks
Heuristic signals:
- Function names: `deposit`, `mint`, `swap`, `redeem`, `withdraw`.
- No `minShares` / `minAmountOut` / `amountOutMin` parameter in signature.
- No `require(min... )` or `deadline` checks inside function.

Finding:
- `MISSING_MIN_CHECK` (warning).

### False-positive controls
- Only run when `source` is verified.
- Limit to files under a max character threshold (reuse `MAX_SOURCE_CHARS`).
- Skip when safe math helpers are detected.

---

## 4. Analyzer Integration

### Flow update (`src/analyzer.ts`)
- After `source` is fetched and verified, run `detectPrecisionIssues(source)`.
- If `source` is missing, skip static detection.

Optionally add a config flag:
- `config.precisionDetection.enabled` default `true` (if you want to allow opt-out).

---

## 5. README Updates

Add a section describing:
- New precision/rounding findings and severity.
- That static detection requires verified source.

---

## 6. Tests

### Unit tests (preferred)
Add deterministic tests for the detector with inline Solidity snippets:
- `FIRST_DEPOSITOR_VULN` should trigger on ERC-4626-like formula without `totalSupply == 0` guard.
- `DONATION_ATTACK` should trigger when `totalAssets()` is `balanceOf(this)` and used for share price.
- `PRECISION_LOSS` should trigger on `(a / b) * c` and not trigger on `mulDiv`.
- `ROUNDING_TO_ZERO` should trigger on `fee / 10000` with no min guard.
- `MISSING_MIN_CHECK` should trigger on `swap(amountIn)` with no `amountOutMin` or `deadline`.

### Integration tests (optional)
- Feed `detectPrecisionIssues()` through `analyze()` by stubbing a verified source in a unit test.

---

## 7. Files & Touch Points

Planned edits:
- `src/detectors/precision.ts` - new static detector.
- `src/analyzer.ts` - wire in static detection.
- `test/precision.test.ts` - unit tests for detector.
- `README.md` - update findings list and usage notes.

---

## 8. Implementation Order

3. Implement `detectPrecisionIssues()` with minimal regex heuristics.
4. Wire detector into `analyze()` for verified source.
5. Add unit tests for each rule and verify false-positive exclusions.
6. Update `README.md` with new findings.

If you want strict TDD, I can reorder steps 3-5 to scaffold tests first.

---

## 9. Manual Verification Checklist

- A known ERC-4626 vault without `totalSupply == 0` guard triggers `FIRST_DEPOSITOR_VULN`.
- A vault using `balanceOf(this)` for `totalAssets()` triggers `DONATION_ATTACK`.
- `(a / b) * c` triggers `PRECISION_LOSS`, while `mulDiv(a, c, b)` does not.
- Missing `minShares` or `amountOutMin` triggers `MISSING_MIN_CHECK`.
- Tiny `fee / 10000` with no guard triggers `ROUNDING_TO_ZERO`.
