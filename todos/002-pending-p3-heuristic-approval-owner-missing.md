---
status: pending
priority: p3
issue_id: "002"
tags: [code-review, simulation, quality]
dependencies: []
---

# Heuristic approvals use zero address when sender missing

Heuristic simulation inserts an approval entry even when the sender address is
missing, populating `owner` with the zero address.

## Problem Statement

When `tx.from` is missing, heuristic approvals show `owner` as
`0x0000000000000000000000000000000000000000`, which is misleading and can
surface fake approval warnings.

## Findings

- `src/simulations/balance.ts:231-244` pushes approvals without requiring `from`.
- `simulateBalance` can fall back to heuristic when sender address is absent.

## Proposed Solutions

### Option 1: Skip approve entries unless `from` is present

**Approach:** Gate heuristic approval creation on `from` being defined and valid.

**Pros:**
- Removes incorrect owner attribution
- Minimal change

**Cons:**
- Loses approval info when sender unknown (already low confidence)

**Effort:** 10-15 minutes

**Risk:** Low

---

### Option 2: Add placeholder "unknown" owner

**Approach:** Extend schema to allow unknown owners and render accordingly.

**Pros:**
- Preserves approval intent even with missing sender

**Cons:**
- Requires schema changes and UI updates

**Effort:** 1-2 hours

**Risk:** Medium

## Recommended Action

(To be filled during triage.)

## Technical Details

**Affected files:**
- `src/simulations/balance.ts`

## Resources

- Commit: 28d8bb3

## Acceptance Criteria

- [ ] Heuristic approvals are not emitted when sender is missing
- [ ] No change to behavior when sender is provided

## Work Log

### 2026-02-03 - Initial Discovery

**By:** Codex

**Actions:**
- Reviewed heuristic approval logic for missing sender

**Learnings:**
- Zero address is used as owner, causing misleading output

## Notes

- Option 1 fits current schema constraints.
