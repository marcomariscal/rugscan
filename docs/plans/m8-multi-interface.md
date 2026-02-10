# M8: Multi-Interface Foundations - Implementation Plan

## Goals
- Define a stable `ScanResult` schema used by core analysis, CLI, REST, and SDK.
- Implement CLI output formats `json` and `sarif` with deterministic exit codes.
- Implement REST `POST /v1/scan` with auth for pre-sign inputs only.
- Ship SDK that mirrors REST and validates schemas.

## Non-Goals (explicit)
- Transaction hash forensics or post-sign analysis.
- Async scan workflow, MCP server, or wallet-specific UX (M9+).
- Full JSONL/Markdown/HTML output formats beyond `json|sarif` in M8.

## Assumptions / Open Decisions
- **Auth mechanism**: API key via `Authorization: Bearer <key>`; no request signing in M8.
- **Exit code policy**: exit non-zero when recommendation ≥ `warning` (default), configurable.
- **SARIF**: implement SARIF v2.1.0 minimal output; only findings map to SARIF rules.
- **Confidence**: scalar 0..1 derived from provider coverage; initial heuristic is acceptable.

If any assumption is off, confirm before implementation.

## Success Criteria
- CLI: `assay scan --format json|sarif` emits valid structured output and predictable exit codes.
- REST: `POST /v1/scan` returns `AnalyzeResponse` for both `address` and `calldata` inputs.
- SDK: typed client wraps REST and exposes `scan()` with the same request/response models.
- All interfaces use identical `ScanResult`/`AnalyzeResponse` definitions.

---

## 1) Schema & Types (core)

### 1.1 Primary Interfaces (TypeScript)
Add to `src/types.ts` (or new `src/schema.ts` if preferred):

```ts
export type Recommendation = "ok" | "caution" | "warning" | "danger";

export interface ScanFinding {
  code: string;
  severity: Recommendation;
  message: string;
  details?: Record<string, unknown>;
  refs?: string[];
}

export interface ContractInfo {
  address: string;
  chain?: string;
  isContract?: boolean;
  name?: string;
  symbol?: string;
  isProxy?: boolean;
  implementation?: string;
  verifiedSource?: boolean;
  tags?: string[];
}

export interface CalldataInput {
  to: string;
  data: string;
  value?: string; // decimal or hex string
  chain?: string; // chain id or name
}

export interface ScanInput {
  address?: string;
  calldata?: CalldataInput;
}

export interface ScanResult {
  input: ScanInput;
  recommendation: Recommendation;
  confidence: number; // 0..1
  findings: ScanFinding[];
  contract?: ContractInfo;
}

export interface AnalyzeResponse {
  requestId: string;
  scan: ScanResult;
}
```

Notes:
- `ScanInput` is intentionally narrow for M8: `address` or `calldata` only.
- `CalldataInput` is PRE-SIGN only and does not accept `txHash`.
- `confidence` should be documented as heuristic and may be 0 when no provider data.

### 1.2 Validation
- Add runtime schema validation (Zod or similar) for both request and response types.
- Ensure the same validators are used by REST and SDK.

**Estimated complexity**: Medium

---

## 2) CLI (format + exit codes)

### 2.1 Commands
- `assay scan [address]` (existing or new entrypoint)
- Add `--calldata` to accept JSON string or file (see spec below).

### 2.2 CLI argument spec
- `--format`: `json | sarif` (default: text)
- `--address <address>`: explicit address input (optional if positional address is used)
- `--calldata <json|@file|->`: unsigned tx simulation input
- `--chain <chain>`: optional override for both address and calldata
- `--fail-on <caution|warning|danger>`: exit code threshold (default: caution)
- `--output <file|->`: optional output path (default: stdout)
- `--quiet`: suppress non-essential logs

Calldata JSON shape:
```json
{ "to": "0x...", "data": "0x...", "value": "0", "chain": "1" }
```

### 2.3 Exit codes
- `0`: recommendation below `--fail-on`
- `2`: recommendation at/above `--fail-on`
- `1`: invalid input, auth failure, or internal error

### 2.4 Output behavior
- `json`: emit `AnalyzeResponse`
- `sarif`: map `findings[]` to SARIF `runs[0].results` with rules for each `code`

**Estimated complexity**: Medium

---

## 3) REST API

### 3.1 Endpoint
`POST /v1/scan`

### 3.2 Auth
- Header: `Authorization: Bearer <api_key>`
- Missing/invalid key returns `401`.

### 3.3 Request body
```json
{
  "address": "0x...",
  "chain": "1"
}
```

or

```json
{
  "calldata": {
    "to": "0x...",
    "data": "0x...",
    "value": "0",
    "chain": "1"
  }
}
```

### 3.4 Response body
```json
{
  "requestId": "uuid",
  "scan": {
    "input": { "address": "0x..." },
    "recommendation": "warning",
    "confidence": 0.74,
    "findings": [
      {
        "code": "PROXY_UNVERIFIED",
        "severity": "warning",
        "message": "Proxy detected but implementation unverified"
      }
    ],
    "contract": {
      "address": "0x...",
      "chain": "1",
      "isContract": true
    }
  }
}
```

### 3.5 Error responses
- `400`: invalid input, missing both `address` and `calldata`
- `401`: unauthorized
- `422`: valid shape but failed validation (e.g., malformed address)
- `500`: internal error

**Estimated complexity**: Medium

---

## 4) SDK (REST mirror)

### 4.1 Public surface
- `scan(input: ScanInput, options?: { apiKey?: string; baseUrl?: string }): Promise<AnalyzeResponse>`
- Optional helpers: `scanAddress(address, chain?)`, `scanCalldata(calldata)`

### 4.2 Shared schemas
- Import `ScanInput` and `AnalyzeResponse` types from core package.
- Reuse runtime validators to ensure response integrity.

### 4.3 HTTP client
- Use `fetch` with timeout and JSON parsing.
- Map errors into a typed `ScanError` with `status`, `message`, `requestId?`.

**Estimated complexity**: Low-Medium

---

## 5) File Structure Changes

- `src/types.ts`
  - Add `ScanInput`, `ScanResult`, `AnalyzeResponse`, `ScanFinding`, `ContractInfo`.
- `src/schema.ts` (new) OR `src/types.ts`
  - Add runtime validators for input/output.
- `src/cli/` (existing)
  - `src/cli/index.ts` or command file: add `--format`, `--calldata`, `--fail-on`.
  - `src/cli/formatters/sarif.ts` (new) for SARIF mapping.
- `src/server/` or `src/api/` (existing)
  - Add `/v1/scan` handler with auth and validation.
- `src/sdk/` (new or existing)
  - `src/sdk/index.ts` client, shared types import.
- `test/` (or `tests/`)
  - Add fixtures for JSON + SARIF output and REST/SDK parity.

**Estimated complexity**: Medium

---

## 6) Task Breakdown & Estimates

1) **Schema + validators**
- Define `ScanInput`, `ScanResult`, `AnalyzeResponse`, and supporting types.
- Add runtime validation and tests.
- Complexity: Medium

2) **CLI output formats + exit codes**
- Add `--format json|sarif` and `--fail-on`.
- Implement SARIF formatter and map findings.
- Update tests/fixtures for CLI output.
- Complexity: Medium

3) **REST endpoint**
- Add `POST /v1/scan` with auth middleware.
- Validate request, call core analyzer, return `AnalyzeResponse`.
- Add API tests.
- Complexity: Medium

4) **SDK**
- Implement `scan()` with proper request typing.
- Reuse validators to enforce response correctness.
- Add SDK tests (mocked fetch).
- Complexity: Low-Medium

5) **Parity fixtures**
- Golden output fixtures for CLI JSON + SARIF and REST response.
- Ensure consistent `ScanResult` between CLI/REST/SDK.
- Complexity: Low

---

## 7) Risks & Mitigations
- **Schema drift across interfaces**: enforce shared types and validators; add parity tests.
- **SARIF correctness**: keep minimal SARIF output and validate against v2.1.0 schema.
- **Auth handling**: centralize middleware and ensure consistent error format.

---

## 8) Acceptance Checklist
- `ScanResult` and `AnalyzeResponse` used by core, CLI, REST, SDK.
- CLI produces valid JSON and SARIF outputs with correct exit codes.
- REST `/v1/scan` accepts `address` and `calldata` inputs.
- SDK mirrors REST and validates responses.
- Tests cover each interface and parity between outputs.
