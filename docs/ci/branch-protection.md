# Branch protection runbook (main)

This repository-level PR cannot enforce GitHub branch protection settings directly.
Use this checklist to configure `main` immediately after merge.

## GitHub settings to click

### 0) Security prerequisite (for dependency review)

1. Open: `assay` repository → **Settings** → **Security & analysis**
2. Ensure **Dependency graph** is enabled

> Until Dependency graph is enabled, the `Dependency Review` workflow will report a warning and skip (non-blocking).

### 1) Branch protection rule

1. Open: `assay` repository → **Settings** → **Branches**
2. Under **Branch protection rules**, click **Add rule**
3. In **Branch name pattern**, enter: `main`
4. Enable:
   - **Require a pull request before merging**
     - Enable **Require approvals** (recommended: at least 1)
     - Enable **Dismiss stale pull request approvals when new commits are pushed**
   - **Require status checks to pass before merging**
     - Click **Search for status checks** and add:
       - `CI / ci` (required)
       - `Dependency Review / dependency-review` (required)
       - `CodeQL / Analyze (javascript-typescript)` (required)
     - Do **not** require `CI (comprehensive) / ci` (keep visible, non-blocking)
   - **Require branches to be up to date before merging**
   - **Require conversation resolution before merging**
   - **Require linear history** (recommended)
   - **Do not allow bypassing the above settings** (recommended)
5. Click **Create** (or **Save changes**)

## Notes

- `CI (comprehensive)` is intentionally best-effort on pull requests. It should stay visible but not block merges.
- If check names differ slightly in the UI, pick the same workflow/job pair shown in recent runs.
