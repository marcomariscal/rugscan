# Safe adapter (`assay safe`)

`assay safe` ingests a Safe Transaction Service payload and (when online) scans each call in the bundle.

## Usage

```bash
assay safe <chain> <safeTxHash>
```

Text output is a human-readable summary.

## JSON output

```bash
assay safe <chain> <safeTxHash> --format json
```

JSON mode returns the raw Safe transaction payload plus an ingest plan.

## Offline mode

Offline mode disables Safe API fetches.

```bash
assay safe <chain> <safeTxHash> \
  --offline \
  --safe-tx-json @/path/to/safe-tx.json
```

Notes:
- In offline mode you must provide `--safe-tx-json` (no Safe Tx Service fetch).
- Offline mode is strict; see `offline.md`.
