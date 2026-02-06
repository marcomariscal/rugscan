# Stable JSON Output v1 (`rugscan scan --format json`)

This document defines a **stable, versioned** JSON contract intended for programmatic integrations (SDK/MCP/CI) consuming rugscan scan output.

Applies to:
- `rugscan scan --format json`
- the local server endpoint `POST /v1/scan`

## Contract

All v1 payloads MUST include a top-level version:

- `schemaVersion: 1`

```json
{
  "schemaVersion": 1,
  "requestId": "<uuid>",
  "scan": { "...": "..." }
}
```

### Required fields (guaranteed)

Top-level:
- `schemaVersion` — always the literal number `1`.
- `requestId` — UUID string generated per scan.
- `scan` — scan result object.

`scan`:
- `scan.input` — exactly one of:
  - `{ "address": "0x…" }`, OR
  - `{ "calldata": { "to": "0x…", "data": "0x…", ... } }`
- `scan.recommendation` — one of `"ok" | "caution" | "warning" | "danger"`.
- `scan.confidence` — number in `[0, 1]`.
- `scan.findings` — array (may be empty). Each finding includes:
  - `code` (string)
  - `severity` (`"ok" | "caution" | "warning" | "danger"`)
  - `message` (string)
- `scan.contract` — always present.
  - `scan.contract.address` is always present.

### Best-effort fields (may be missing)

These may be omitted depending on provider availability, configuration, or scan mode:

- `scan.intent` — human-readable intent summary (when calldata decoding succeeds).
- `scan.contract.*` metadata:
  - `chain`, `isContract`, `name`, `symbol`, `isProxy`, `implementation`, `verifiedSource`, `tags`
- `scan.simulation` — simulation result (may be omitted when disabled via `--no-sim`, unsupported, or unavailable).

## Non-goals

- AI output is optional and **not part of this stable scan JSON contract**.
- Providers may be skipped/time out; missing best-effort fields should not be treated as an error.
- This contract does not promise determinism for values derived from live upstream sources.

## Implementation note

The v1 contract is represented in TypeScript + Zod in `src/schema.ts`.
