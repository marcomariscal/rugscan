# Multi-Interface Design Research for Assay (formerly Rugscan)
Date: 2026-02-02

## Summary
Assay should expose one core analysis engine with four adapters: CLI, REST API, SDK, and MCP. Existing security tools are CLI-first with rich structured outputs (JSON/SARIF) and config files. Wallet-facing security engines emphasize fast pre-sign simulation, balance-change previews, and clear risk signals. Agent-friendly CLIs prioritize machine-readable output, deterministic exit codes, and stdin/stdout workflows.

## Research Findings

### 1) Multi-interface patterns from security tools

**Slither (Trail of Bits)**
- CLI supports config files (`slither.config.json`) for detectors, solc args, remappings, and general options, and supports JSON/SARIF output via CLI flags. This is a strong precedent for keeping CLI behavior configurable without changing code. (Sources: Slither Usage docs, Slither JSON output docs)
- JSON output includes top-level `success`, `error`, and `results`, and can include SARIF output. This shows a stable machine-readable contract that downstream tools can consume. (Source: Slither JSON output docs)

**Mythril**
- CLI supports `-o json` and multiple output formats (`text`, `markdown`, `json`, `jsonv2`). This is a precedent for format negotiation and an easy path to integrate with CI or agent workflows. (Sources: Mythril tutorial, Mythril CLI reference)
- Mythril exits non-zero when it finds issues, which enables automation via exit codes. (Source: Mythril CLI reference)

**Aderyn**
- Outputs Markdown, JSON, and SARIF reports, which indicates a modern baseline for multi-consumer outputs. (Source: Aderyn README)

**Pattern to carry forward:** a single CLI that is human-friendly by default, but can output structured artifacts for automation, with config files for repeatable runs.

### 2) Wallet security scanners and integrations

**Rabby Wallet**
- Rabby emphasizes transaction simulation, balance change previews, and risk alerts during confirmation. This implies wallet integrations expect fast, pre-sign structured results that summarize impact and risk. (Sources: Rabby security check docs; Rabby transaction simulation docs)

**Frame Wallet**
- Frame positions itself as a system-wide wallet that works for browser, command-line, and native apps. This implies wallet integrations may be local and must be fast and reliable in diverse environments. (Sources: Frame docs; Frame README)

**Blowfish**
- Blowfish markets dapp security, transaction/message signing previews with warnings, and uses transaction simulation APIs. This is a direct example of wallet-integrated security checks. (Source: Blowfish site)
- Blowfish documentation is password-protected, so API details may require vendor access. (Source: Blowfish docs landing page)

**Pocket Universe**
- Pocket Universe is a browser extension that pops up before a wallet transaction and shows what you are signing with warnings. This is another pattern: client-side overlays at the approval step. (Source: Pocket Universe Chrome Web Store listing)

**Fireblocks + Blockaid**
- Fireblocks provides transaction simulation and dapp protection using Blockaid; this shows an enterprise-grade pattern for pre-sign security and simulation. (Source: Fireblocks Blockaid integration announcement)
- Fireblocks API uses API keys and signed requests; REST authentication via signed requests is a wallet/custody precedent. (Sources: Fireblocks Quickstart; Fireblocks API communication docs)

**BlockSec**
- BlockSec provides a transaction simulation REST API with API key auth and dedicated endpoints for raw/custom simulation. This is a public reference for wallet-facing simulation APIs. (Source: BlockSec Transaction Simulation API docs)

**Pattern to carry forward:** wallet integrations expect low-latency simulation and risk signals with clear, structured output; enterprise integrations prefer signed requests and API keys; extensions present security overlays at approval time.

### 3) CLI agent-friendly patterns

**Structured outputs and filtering**
- GitHub CLI supports `--json` and post-processing with `--jq` or Go templates, showing a strong precedent for JSON-first output that can be filtered without post-parsing. (Source: gh help formatting)

**Stdin/stdout workflows**
- `gh api` supports `--input -` to read request bodies from stdin, showing a common pattern for piping data into tools. (Source: gh api docs)

**Exit codes**
- `jq` supports `--exit-status` to drive automation based on filter results, reinforcing the importance of deterministic exit codes. (Source: jq manual)
- Mythril exits non-zero when issues are found, enabling CI-style failure conditions. (Source: Mythril CLI reference)

**Pattern to carry forward:** default human-readable output, plus JSON/JSONL and predictable exit codes; accept stdin for agent piping; include small, composable flags (`--format`, `--jq`, `--output`).

### 4) REST API design for wallet integration

**Observed API traits**
- Wallet-facing services expose transaction simulation endpoints, return balance deltas, and provide structured warnings (BlockSec). (Source: BlockSec Transaction Simulation API docs)
- Auth patterns include API keys and request signing (Fireblocks). (Sources: Fireblocks Quickstart; Fireblocks API communication docs)

**Implicit requirements**
- Pre-sign checks must be fast, since they sit on the critical path of a signing flow (Rabby, Blowfish patterns). (Sources: Rabby security check docs; Blowfish site)

### 5) Flexible input (paste-friendly)

Common inputs in this space include:
- Address, tx hash, calldata, raw transaction, or EIP-712 typed data
- Wallet exports (JSON files) or raw JSON-RPC payloads
- Natural language requests ("approve USDC to 0x...")

**Pattern to carry forward:** a single endpoint/CLI entrypoint that auto-detects input type, plus explicit overrides for strict behavior.

### 6) MCP (Model Context Protocol) for AI agents

- MCP is an open protocol that lets AI apps connect to tools/resources and discover them at runtime. (Source: MCP Introduction)
- MCP defines a tool discovery and invocation flow (`tools/list`, `tools/call`) via JSON-RPC, and it expects the client to control human-in-the-loop approval. (Source: MCP Tools spec)

**Pattern to carry forward:** provide an Assay MCP server that exposes primitive scan tools and returns rich structured output; keep workflow logic in the agent, not the tool.

## Recommendations for Assay

### A) One core analysis engine + four adapters
- **Core engine**: pure analysis that returns a stable `ScanResult` schema.
- **Adapters**: CLI, REST API, SDK, MCP should all use the same schema and validation.
- **Profiles**: `wallet-pre-sign`, `ci-audit`, `agent` to tune defaults without branching logic.

### B) CLI (power users + agents)
- Defaults: human-readable tables + summary; deterministic exit codes.
- `--format`: `text | json | jsonl | sarif | markdown` (align with Slither/Mythril/Aderyn precedents).
- `--input` (file or `-` for stdin), `--output` (file or `-`), `--quiet`, `--no-color`.
- `--fail-on`: `warning|danger` to control exit code behavior.
- `--explain`: include remediation suggestions and references.

### C) REST API (wallets)
- **Endpoints**:
  - `POST /v1/scan` (auto-detect input)
  - `POST /v1/scan/tx`, `POST /v1/scan/address`, `POST /v1/scan/contract`
  - `GET /v1/scan/{id}` for async/long-running scans
- **Auth**: API key + signed requests (HMAC/JWT), optional allowlist.
- **Response** should include:
  - `decision` (`allow | warn | block`)
  - `risk_level` (`low | medium | high | critical`)
  - `warnings[]` with code + message
  - `balance_changes[]` + `asset_diffs[]`
  - `simulation` summary + `raw_trace` (optional)
  - `request_id`, `chain_id`, `latency_ms`
- **Latency**: aim for pre-sign responses within a single-digit second budget; offer async fallback for deep analysis.

### D) SDK (developers)
- Typed client that mirrors REST, ships the `ScanResult` schema and validators.
- Helpers: `scanTransaction`, `scanAddress`, `scanContract`, `scanTypedData`.
- Optional local mode that runs the core engine without network calls.

### E) MCP server (agents)
- Tools should be **primitive** and **composable**:
  - `scan_transaction`, `scan_address`, `scan_contract`, `scan_typed_data`, `explain_risks`.
- Return rich JSON in tool responses (full `ScanResult`).
- Provide a `list_chains` / `list_risk_codes` discovery tool.
- Require explicit `approval_mode` (preview only vs. enforce) to enable human-in-loop gating.

### F) Flexible input handling
- Auto-detect input type by shape (hex prefix, length, JSON keys).
- Accept wallet JSON exports and raw JSON-RPC payloads.
- Offer `--type` / `type` override for strict clients.
- Support natural language via optional LLM-based parser (opt-in).

## Proposed M8/M9 Milestones

### M8: Multi-Interface Foundations
- Define `ScanResult` schema and severity taxonomy.
- Implement CLI `--format json|jsonl|sarif|markdown` and deterministic exit codes.
- Implement REST `POST /v1/scan` with auth + idempotency.
- Ship SDK that mirrors REST and validates schema.
- Add fixtures and golden outputs for CLI/REST/SDK parity.

### M9: Wallet + Agent Integration
- Add wallet-pre-sign profile with balance change and approval risk emphasis.
- Add MCP server with tool discovery and rich outputs.
- Implement async scanning workflow and caching for heavy analysis.
- Add policy engine for allow/warn/block decisions.
- Partner integration checklist + latency SLOs + monitoring dashboard.

## Open Questions / Follow-ups
- Request vendor access to Blowfish API docs to confirm payloads and latency expectations.
- Validate Rabby/Frame partner requirements and preferred auth patterns.
- Decide whether to support on-device (offline) scan mode for wallets.

## Sources
- Slither Usage docs: https://github.com/crytic/slither/wiki/Usage
- Slither JSON output docs: https://github.com/crytic/slither/wiki/JSON-output
- Mythril tutorial (output formats): https://mythril-classic.readthedocs.io/en/master/tutorial.html
- Mythril CLI reference: https://github.com/Consensys/mythril-classic/blob/develop/mythril/interfaces/cli.py
- Aderyn README: https://github.com/Cyfrin/aderyn
- Blowfish site: https://blowfish.xyz/
- Blowfish docs landing page (password-protected): https://docs.blowfish.xyz/
- Pocket Universe Chrome Web Store listing: https://chromewebstore.google.com/detail/pocket-universe/iafmceemnfnlcmpmjpncgkhgjeednknn
- Rabby security check docs: https://support.rabby.io/hc/en-us/articles/16966767096193-The-security-check-in-transaction-confirmation
- Rabby transaction simulation docs: https://support.rabby.io/hc/en-us/articles/11496192433041-How-does-Rabby-Wallet-keep-me-safe
- Frame docs: https://docs.frame.sh/docs/intro
- Frame README: https://github.com/floating/frame
- Fireblocks Blockaid integration announcement: https://www.fireblocks.com/blog/fireblocks-integrates-blockaid-for-advanced-transaction-security/
- Fireblocks Quickstart: https://developers.fireblocks.com/reference/quickstart
- Fireblocks API communication docs: https://developers.fireblocks.com/reference/api-communication
- BlockSec Transaction Simulation API docs: https://blocksec.com/docs/transaction-simulation-api
- gh help formatting: https://cli.github.com/manual/gh_help_formatting
- gh api docs: https://cli.github.com/manual/gh_api
- jq manual: https://jqlang.org/manual/
- MCP Introduction: https://modelcontextprotocol.io/introduction
- MCP Tools spec: https://modelcontextprotocol.io/docs/concepts/tools
