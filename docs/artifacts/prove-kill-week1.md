# Prove/Kill Week 1 Scorecard Template

> Window: YYYY-MM-DD → YYYY-MM-DD (UTC)
> Owner: @___
> Data source: `~/.config/assay/telemetry/events/*.jsonl`

## Daily rollup command

```bash
bun run scripts/rollup-prove-kill.ts \
  --date YYYY-MM-DD \
  --window-days 7 \
  --out docs/artifacts/rollups/YYYY-MM-DD.json
```

Notes:
- `--date` uses **UTC day** (matches telemetry file naming: `YYYY-MM-DD.jsonl`).
- Script output prints a markdown snapshot to stdout and writes structured JSON when `--out` is provided.

## Daily snapshots

| Date (UTC) | Decision sessions | Proceed rate (all) | Block rate (all) | WAU installs | Returning install rate | Edit-and-retry inferred |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| YYYY-MM-DD |  |  |  |  |  |  |
| YYYY-MM-DD |  |  |  |  |  |  |
| YYYY-MM-DD |  |  |  |  |  |  |
| YYYY-MM-DD |  |  |  |  |  |  |
| YYYY-MM-DD |  |  |  |  |  |  |
| YYYY-MM-DD |  |  |  |  |  |  |
| YYYY-MM-DD |  |  |  |  |  |  |

## Severity breakdown (end-of-week)

- SAFE: proceed ___ / block ___ / error ___
- CAUTION: proceed ___ / block ___ / error ___
- WARNING: proceed ___ / block ___ / error ___
- BLOCK: proceed ___ / block ___ / error ___

## Week 1 narrative

- What changed in user behavior after warnings?
- Any sign of repeat voluntary usage?
- Where telemetry is still ambiguous/noisy?

## Decision checkpoint (prove / kill / continue)

- **Recommendation:** ___
- **Rationale:** ___
- **Gaps to close in Week 2:** ___
