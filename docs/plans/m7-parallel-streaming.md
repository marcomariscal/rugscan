# M7: Parallel Execution + Call Trace Analysis - Implementation Plan

## Goals
- Parallelize independent provider calls to reduce total latency.
- Stream findings to CLI as each provider completes.
- Early exit on critical findings (KNOWN_PHISHING → abort remaining checks).
- Add `rugscan analyze-tx <txHash>` for full call trace analysis.
- Cache analysis results to avoid re-checking the same contract.

## Non-Goals (explicit)
- Full EVM execution simulation or symbolic analysis.
- Cross-chain tracing beyond supported `Chain` values.
- Persistent background cache eviction daemon or complex LRU.

## Assumptions / Open Decisions
- **Critical signal definition**: decide which provider fields map to `KNOWN_PHISHING` (GoPlus label, Etherscan label, custom list). If unclear, confirm and codify a single source of truth.
- **Trace RPC method**: prefer `debug_traceTransaction` on geth-compatible RPC; if unavailable, we’ll return a clear error and skip trace analysis.
- **Cache location**: default to a simple JSON file under a cache directory (e.g. `~/.cache/rugscan/analysis.json`), with in-memory fallback.
- **Abort semantics**: we will attempt to cancel provider fetches via `AbortController`, but providers that don’t respect `signal` will be ignored once early-exit is triggered.
- **Aggregate risk**: define whether to use `max`, `weighted average`, or `worst-N` for transaction-level scoring.

If any assumption is off, confirm before implementation.

## Success Criteria
- Median end-to-end analysis latency drops meaningfully (e.g. ~2–3s → ~1–1.5s on typical RPC).
- CLI shows per-provider progress and streams findings as they arrive.
- When `KNOWN_PHISHING` is detected, remaining provider calls are aborted and the result returns immediately.
- `rugscan analyze-tx` analyzes all contracts in a call trace and returns a per-contract breakdown + aggregate risk.
- Cache hits skip provider calls and annotate output with `(cached)`.

---

## 1. API & Type Changes

### 1.1 Progress events
Add new progress types in `src/types.ts` (or a new `src/progress.ts`):

```ts
export interface AnalysisProgress {
  phase: "validation" | "providers";
  provider?: string;
  status: "start" | "complete" | "error";
  finding?: Finding;
  message?: string;
  cached?: boolean;
}

export interface TxAnalysisProgress {
  phase: "trace" | "contract";
  provider?: string;
  contract?: string;
  status: "start" | "complete" | "error";
  finding?: Finding;
  message?: string;
  cached?: boolean;
}
```

### 1.2 Analyzer API changes
Update `analyze` to accept options rather than a positional progress callback:

```ts
analyze(address, chain, config, {
  onProgress?: (progress: AnalysisProgress) => void;
  earlyExitOnCritical?: boolean;
  useCache?: boolean;
}): Promise<AnalysisResult>
```

Add a new transaction analysis API:

```ts
analyzeTransaction(
  txHash: string,
  chain: Chain,
  config: Config,
  options?: {
    onProgress?: (progress: TxAnalysisProgress) => void;
    useCache?: boolean;
    earlyExitOnCritical?: boolean;
  }
): Promise<TxAnalysisResult>
```

### 1.3 Result types
Add new types to `src/types.ts`:

```ts
export interface TxAnalysisResult {
  transaction: DecodedTx;
  contracts: Map<string, AnalysisResult>;
  aggregateRisk: number;
  recommendation: Recommendation;
}
```

### 1.4 New finding code
Add `KNOWN_PHISHING` to `FindingCode` with `danger` severity. Map this consistently to provider outputs.

---

## 2. Parallel Provider Orchestration

### 2.1 Phase layout (target)
- **Phase 1 (instant)**: address normalization, chain config, input validation.
- **Phase 2 (~500ms, parallel)**: RPC `isContract`, Sourcify verification, Proxy detection, DeFiLlama match.
- **Phase 3 (~1s, parallel)**: GoPlus token security, Etherscan metadata/labels.

### 2.2 Implementation approach
- Create a provider task table with metadata:

```ts
const tasks = [
  { phase: "providers", name: "RPC", run: () => proxy.isContract(...)}
  // ...
];
```

- Use `Promise.allSettled` per phase to avoid one provider failure blocking others.
- Emit `onProgress({ status: "start" | "complete" | "error" })` per provider.
- Collect provider results into a shared `state` object used to build findings.

### 2.3 Early exit flow
- Introduce `earlyExitOnCritical` (default `true` for CLI, `false` for library if you want conservative API).
- When a provider yields `KNOWN_PHISHING`, immediately:
  - Emit a progress event with the finding.
  - Abort pending requests via `AbortController` (best-effort).
  - Return a minimal `AnalysisResult` with critical finding + partial metadata.

### 2.4 Provider changes (abort support)
Update providers to accept `signal?: AbortSignal` and pass it to `fetch`:
- `src/providers/etherscan.ts`
- `src/providers/sourcify.ts`
- `src/providers/defillama.ts`
- `src/providers/goplus.ts`
- `src/providers/proxy.ts`

This enables early exit to cancel in-flight requests.

---

## 3. Streaming CLI Output

### 3.1 UI strategy
- Extend `src/cli/ui.ts` to maintain a per-provider status line.
- Use in-place terminal updates (ANSI control codes) to refresh the progress block.
- When a `finding` arrives, print it immediately below the progress block and keep the block updated.

### 3.2 Progress mapping
- Map `AnalysisProgress` to UI entries:
  - `status: start` → spinner + “running”
  - `status: complete` → success mark + message
  - `status: error` → warning mark + message
  - `cached: true` → append ` (cached)`

### 3.3 Streaming for transaction analysis
- For `analyze-tx`, show:
  - Trace fetch status
  - Per-contract analysis status (contract address + chain)
  - Aggregate summary as each contract completes

---

## 4. Caching Layer

### 4.1 Cache design
- Add `src/cache.ts` with a simple JSON-file cache:
  - Key: `${chain}:${address}`
  - Value: `{ result: AnalysisResult, cachedAt: number }`
  - TTL: default 1 hour (configurable)

### 4.2 Config/Options
- Extend `Config` with:

```ts
cache?: {
  enabled?: boolean;
  ttlMs?: number;
  path?: string;
};
```

- Add `useCache` to analyze/analyzeTransaction options (defaults to `true` in CLI).

### 4.3 Cache flow
- Check cache before Phase 2. If fresh:
  - Emit `onProgress` with `cached: true` and return cached result.
- On completion, store result with `cachedAt`.
- When early exit triggers, store partial result only if `config.cache.storePartial` is explicitly enabled (default `false`).

---

## 5. Call Trace Analysis (`rugscan analyze-tx`)

### 5.1 New module
Create `src/transaction.ts` (or `src/analyze-transaction.ts`) to encapsulate:
- `fetchTransaction(txHash, chain, rpcUrl)`
- `fetchCallTrace(txHash, chain, rpcUrl)`
- `extractContracts(trace)` (dedupe, normalize, filter EOAs)

### 5.2 Trace method
- Use `viem` client with `client.request({ method: "debug_traceTransaction", params: [...] })`.
- Provide a clear error when RPC doesn’t support tracing.

### 5.3 Contract extraction
- Parse trace frames for `to`, `from`, `calls[*].to` addresses.
- Normalize to lowercase, dedupe, and remove zero address.
- Optionally skip the sender EOA unless it is a contract.

### 5.4 Per-contract analysis
- For each contract address:
  - Run `analyze` with cache + early-exit on critical.
  - Parallelize using a bounded concurrency pool (e.g. 4–8) to avoid rate limits.
- Aggregate results:

  - `recommendation = worst(findings)`.

### 5.5 Output
- CLI prints:
  - Transaction summary (to/from/value/chain)
  - Contract list with per-contract findings
  - Aggregate risk + recommendation

---

## 6. Updated CLI Commands

### 6.1 Add `analyze-tx`
Update `src/cli/index.ts`:
- Wire to `analyzeTransaction` with `onProgress` streaming.

### 6.2 Options
- `--no-cache` to disable cache.
- `--no-early-exit` to continue despite critical findings.
- `--concurrency <n>` for transaction analysis.

---

## 7. Tests

### 7.1 Unit tests (fast)
- Analyzer task orchestration:
  - Ensures independent providers run in parallel (use fake timers or stubbed delays).
  - Ensures `onProgress` events fire in the expected order per provider.
- Early exit:
  - When `KNOWN_PHISHING` returned, remaining providers are not awaited and abort is triggered.
- Cache:
  - Cache hit returns stored result and skips provider calls.
  - Expired cache triggers fresh analysis.

### 7.2 Transaction analysis tests
- Trace parsing extracts unique contract addresses from a mocked trace payload.
- Concurrency pool respects max in-flight limit.
- Aggregate risk/recommendation derived correctly.

### 7.3 CLI smoke tests (optional)
- `rugscan analyze <addr>` prints streaming output.
- `rugscan analyze-tx <hash>` produces per-contract output.

---

## 8. File & Touch Points

Planned edits:
- `src/analyzer.ts` - refactor orchestration, phases, early exit, streaming.
- `src/types.ts` - new progress types, new findings, transaction result types.
- `src/providers/*.ts` - optional `AbortSignal` support.
- `src/cache.ts` - new cache module.
- `src/transaction.ts` (new) - call trace fetch + parsing.
- `src/cli/index.ts` - new `analyze-tx` command + flags.
- `src/cli/ui.ts` - streaming UI updates.
- `test/*` - new unit tests for orchestration, cache, trace parsing.
- `README.md` - document new command and caching options.

---

## 9. Implementation Order (TDD-friendly)

1. Define success criteria and add test scaffolding for parallel orchestration + cache.
2. Introduce new progress types and update `analyze` signature.
3. Refactor provider calls into parallel phases + progress events.
4. Add early exit logic with `AbortController` support.
5. Implement caching layer and integrate with `analyze`.
6. Implement `analyzeTransaction` with trace parsing + concurrency pool.
7. Update CLI commands + streaming UI.
8. Add remaining tests + README updates.

If you want strict tests-first, I’ll start with the orchestration and cache tests before touching analyzer logic.
