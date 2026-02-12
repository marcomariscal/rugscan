# Eval fixtures scope

`test/evals/` now contains only deterministic, transaction-focused regression fixtures used by Assay’s current product scope.

Out of scope (removed):
- AI/source-code exploit analysis lanes
- static vulnerable-contract code eval TODOs

Assay’s runtime and tests focus on deterministic pre-sign safety behavior (scan/proxy/simulation/replay), not contract-source vulnerability auditing.
