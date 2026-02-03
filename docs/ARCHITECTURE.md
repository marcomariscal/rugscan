# Rugscan Target Architecture

This is the desired architecture for the simplified, local-first CLI.

## Component diagram (ASCII)

+-------------------+        +--------------------+
| CLI (check/approval) | ---> | Config Loader       |
+-------------------+        +--------------------+
            |                           |
            v                           v
+----------------------------------------------------+
| Core Analyzer / Orchestrator                       |
| - Provider registry                                |
| - Concurrency + timeouts                           |
| - Cache (memory + optional disk)                   |
+---------------------------+------------------------+
            |               |            |   |
            |               |            |   +------------------+
            v               v            v                      v
  +----------------+  +-------------+  +----------------+  +----------------+
  | RPC Provider   |  | Sourcify    |  | Etherscan      |  | GoPlus         |
  | (chain state)  |  | (verify/ABI)|  | (labels/meta)  |  | (token risk)   |
  +----------------+  +-------------+  +----------------+  +----------------+
            |               |            |                      |
            +---------------+------------+----------------------+
                            |
                            v
                 +-----------------------+
                 | Findings Engine       |
                 | - normalize facts     |
                 | - severity policy     |
                 +-----------+-----------+
                             |
                             v
                 +-----------------------+
                 | Output Renderer       |
                 | - 1-3 line summary    |
                 | - exit code           |
                 +-----------------------+

## Data flow for `rugscan check <address>`

1) CLI parses address + chain; config is loaded from env/file.
2) Orchestrator normalizes address and starts provider calls in parallel:
   - RPC: isContract, proxy detection, on-chain reads if needed.
   - Sourcify: verification + ABI (if required).
   - Etherscan: labels (phish/scam), basic metadata (optional).
   - GoPlus: token security flags.
   - Allowlist: local protocol list (no remote fetch).
3) Provider results are normalized into facts with a confidence score.
4) Findings engine converts facts into findings with severity and codes.
5) Recommendation is derived from findings (danger > warning > ok).
6) Output renderer prints 1-3 highest-severity findings and exits with
   code 0/1/2.

## Provider abstraction (target design)

Providers should be isolated, deterministic, and composable. Suggested shape:

- Provider interface
  - id: string
  - dependsOn?: ProviderId[]
  - fetch(ctx): Promise<ProviderResult<T>>
  - toFindings(result, ctx): Finding[]

- ProviderResult
  - data: T | null
  - error?: string
  - confidence: "high" | "medium" | "low"

- Orchestrator
  - runs providers concurrently with timeouts
  - enforces per-provider retry budgets
  - caches results per address/chain
  - exposes telemetry (timings, error rates)

## Extension points for future work

- New detectors: permit2, proxy admin risk, bytecode selector scans.
- Additional chains: add chain config + allowlist entries.
- Optional payload analysis: minimal calldata decoder for approvals.
- Optional message inspection: EIP-712 and permit signature checks.
- Offline data bundles: known protocol lists, phishing labels, token lists.
- Output adapters: JSON for CI, TUI, or wallet plugin integration.

## Local-first principles

- No network dependency is required for baseline checks (other than RPC).
- All optional remote providers are explicit and can be disabled.
- All datasets used for allowlists or heuristics are versioned locally.
