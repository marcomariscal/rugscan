# Assay CLI UX Width Audit (2026-02-09)

## Scope
Audit of `assay scan` text output aesthetics/readability across terminal widths, with emphasis on:

1. Visual polish + clarity at narrow / medium / wide widths
2. Graceful handling of wrapping/truncation/box layout
3. Prioritized recommendations (quick wins vs deeper refactors)
4. Low-risk implementation of top improvements

## Method
- Reviewed renderer implementation (`src/cli/ui.ts`, `src/cli/index.ts`) and snapshot fixtures in `test/fixtures/recordings/*`.
- Measured rendered line widths from fixture outputs.
- Validated behavior at representative widths:
  - **Narrow:** 80 cols
  - **Medium:** 120 cols
  - **Wide:** 160 cols
- Applied frontend-design rubric principles to terminal UI:
  - clear hierarchy
  - scan-first information architecture
  - resilient layout under constraints
  - consistent spacing rhythm

---

## Baseline Findings (Before)

### 1) Width behavior: content-defined, not viewport-defined
The box width was set to the longest line in content. No awareness of terminal width (`process.stdout.columns`).

**Observed max widths (visible columns):**
- `north-star__approve-unlimited-sim-not-run`: **138**
- `wallet-transferfrom-failed-8362e95e`: **117**
- `north-star__swap-sim-failed`: **85**
- `wallet-*swap/approve`: **83**

**Overflow rate from fixtures (7 bundles):**
- At 80 cols: **5/7 overflow**
- At 100 cols: **2/7 overflow**
- At 120 cols: **1/7 overflow**

### 2) Primary overflow driver
The long `INCONCLUSIVE` risk line frequently set the entire box width, e.g.:

- `⚠️ INCONCLUSIVE: simulation failed (...) — balances/approvals may be unknown`

This made otherwise tidy cards become horizontally brittle on narrow and medium terminals.

### 3) Aesthetic impact
- Good: clear sectioning, semantic icons, strong contrast, predictable vertical structure.
- Weakness: when one line grows, the whole card loses composure and becomes hard to parse in smaller terminals.

---

## Implemented Improvements (Low Risk)

### ✅ Improvement 1: Width-aware word wrapping in box renderer
Implemented ANSI-preserving line wrapping in `src/cli/ui.ts`:
- Added `wrapBoxLine(...)` and `wrapAllLines(...)`
- Added optional `maxWidth` support to:
  - `renderUnifiedBox(...)`
  - `renderBox(...)`
  - `renderResultBox(...)`
  - `renderApprovalBox(...)`

Behavior:
- If `maxWidth` is provided, long lines wrap by words.
- Continuation lines gain slight extra indent for readability.
- No truncation (content preserved).
- Backwards-compatible when `maxWidth` is omitted.

### ✅ Improvement 2: Pass terminal width from CLI entry points
In `src/cli/index.ts`, added `terminalWidth()` and passed it into rendered text paths:
- `assay analyze`
- `assay scan` (text mode)
- `assay approval`
- proxy wallet-mode rendered summaries

This activates width-aware wrapping automatically in interactive terminals.

---

## Before / After Notes

### Before (80-col terminal, problematic case)
- Box expanded to **117+ cols** for long risk lines.
- Horizontal overflow required wrapping by terminal emulator (breaking visual structure).

### After (80-col terminal)
- Same content stays within terminal width.
- Box borders remain intact.
- Long risk lines wrap into aligned continuation lines.

### Quantitative check (north-star bundles)
- **Before:**
  - overflow >80: **2/4**
  - overflow >100: **1/4**
  - overflow >120: **1/4**
- **After** (render with `maxWidth`):
  - overflow >80: **0/4**
  - overflow >100: **0/4**
  - overflow >120: **0/4**

---

## Tradeoffs

1. **Pros**
   - Big readability win at narrow widths
   - No data loss (word-wrap, not truncation)
   - Preserves existing UX and snapshots when width clamp is absent
   - Low implementation risk

2. **Cons / constraints**
   - Wrapping currently uses simple visible-length logic (no full grapheme-width engine), so some exotic emoji/font environments may still have minor alignment variance.
   - Box width is an upper-bound clamp, not forced fill to terminal width (intentional to avoid noisy whitespace).

---

## Prioritized Recommendations

### Quick wins (next)
1. **Section-level compact mode for <90 cols**
   - Collapse low-priority lines (e.g., secondary safe findings) behind a concise summary line.
2. **Message length budgeting for high-variance strings**
   - Keep verbose risk explanations in 1–2 wrapped clauses with stable rhythm.

### Deeper refactors
3. **Adaptive layout tiers (80 / 120 / 160+)**
   - Small: compact labels + fewer ornaments
   - Medium: current card
   - Wide: richer details inline
4. **Design-system pass for terminal tokens**
   - Standardize indentation, bullets, and section header rhythm via centralized constants.
5. **Optional “headline verdict” strip**
   - One-line top summary (`SAFE / LOW / MEDIUM / HIGH`) before details for scan-at-a-glance workflows.

---

## 11/10 Polish Path

To reach “11/10” CLI polish:
1. Keep current wrapping foundation (done).
2. Add **responsive density modes** by width tier.
3. Add a **top-level verdict headline** + **actionable next step** line.
4. Normalize message copy to a tighter editorial style (short clauses, consistent verb forms).
5. Add fixture-backed visual contracts for 80/100/120/160 widths.

This yields an interface that remains legible under pressure, scales elegantly across terminal sizes, and feels intentionally designed rather than merely formatted.
