---
status: pending
priority: p2
issue_id: "001"
tags: [code-review, simulation, quality]
dependencies: []
---

# ERC-20 balance diff missing for log-only tokens

Balance diffs only consider tokens present in the pre-balance map. Tokens discovered
from receipt logs after the transaction can be omitted from balance changes.

## Problem Statement

ERC-20 tokens that appear only in receipt logs are added to `tokenCandidates` after
pre-balances are read. Because `buildErc20Changes` only iterates over pre-balance
entries, these tokens never produce balance diffs, so users miss asset changes.

## Findings

- `src/simulations/balance.ts:133-157` reads pre-balances before receipt logs.
- `src/simulations/balance.ts:141-153` adds ERC-20 tokens from logs but never
  backfills pre-balances, so changes for those tokens are ignored.

## Proposed Solutions

### Option 1: Backfill pre-balances using blockNumber - 1

**Approach:** After receipt, compute missing tokens and read their balances at
`receipt.blockNumber - 1`, then merge into `preBalances` before diffing.

**Pros:**
- Accurate diffs without re-running the transaction
- Minimal changes to the current flow

**Cons:**
- Requires passing `blockNumber` to `readContract`

**Effort:** 30-45 minutes

**Risk:** Low

---

### Option 2: Derive diffs from logs for missing tokens

**Approach:** Build net changes from `Transfer` logs for tokens missing from
pre-balances.

**Pros:**
- No extra RPC reads

**Cons:**
- Misses non-log balance changes (rebases/fees)

**Effort:** 45-60 minutes

**Risk:** Medium

## Recommended Action

(To be filled during triage.)

## Technical Details

**Affected files:**
- `src/simulations/balance.ts`

## Resources

- Commit: 28d8bb3

## Acceptance Criteria

- [ ] ERC-20 tokens discovered via logs produce balance diffs
- [ ] No regression for tokens already in the curated/pre-balance set
- [ ] Tests updated or added if needed

## Work Log

### 2026-02-03 - Initial Discovery

**By:** Codex

**Actions:**
- Reviewed balance simulation flow
- Identified missing pre-balance coverage for log-only tokens

**Learnings:**
- `buildErc20Changes` only iterates `preBalances` entries

## Notes

- Prefer Option 1 for accuracy.
