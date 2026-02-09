# assay

Pre-transaction security analysis for EVM contracts. Know what you're signing before you sign it.

> ⚠️ **Disclaimer:** Assay provides informational risk signals only. It is not financial, legal, tax, or investment advice. Use at your own risk.

## Features

- **Contract verification** — Sourcify (free) + Etherscan fallback
- **Proxy detection** — EIP-1967, UUPS, Beacon, minimal proxies (EIP-1167)
- **Token security** — Honeypot, hidden mint, blacklist, tax analysis (via GoPlus)
- **Protocol matching** — DeFiLlama integration for known protocols
- **Approval analysis** — Detect risky approval patterns before signing
- **Phishing detection** — Etherscan labels for known phishing/scam addresses
- **Structured JSON output** — Contract summary, simulation details, and findings for automation

## Install

> Note: assay is not published to npm yet.

For now, run from source:

```bash
git clone https://github.com/marcomariscal/assay.git
cd assay
bun install

# examples below use `assay ...`; when running from source, replace with:
# bun run src/cli/index.ts ...
```

## Quick Start

```bash
# Basic analysis
assay analyze 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

# Approval analysis
assay approval --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --spender 0xE592427A0AEce92De3Edee1F18E0157C05861564 \
  --amount max \
  --expected 0xE592427A0AEce92De3Edee1F18E0157C05861564

# Different chain
assay analyze 0x1234... --chain base
```

## CLI Usage

Run `assay --help` for the full CLI reference.

```bash
assay analyze <address> [options]
assay scan [address] [options]
assay safe <chain> <safeTxHash> [--safe-tx-json <path>] [--offline]
assay approval --token <address> --spender <address> --amount <value> [--expected <address>] [--chain <chain>]
assay proxy [options]
assay mcp
```

### `assay scan`

`assay scan` analyzes either a contract address or an unsigned transaction (calldata) before signing.

Flags:
- `--format text|json|sarif` (default: `text`)
- `--calldata <json|hex|@file|->` — accepts:
  - unsigned tx JSON (Rabby/MetaMask-like)
  - canonical calldata JSON: `{ "to": "0x...", "data": "0x...", "from?": "0x...", "value?": "...", "chain?": "..." }`
  - raw hex calldata (MetaMask "Hex Data")
  - `@file` to read from disk
  - `-` to read from stdin
- `--to/--from/--value` — when `--calldata` is raw hex (or when providing tx fields directly)
- `--no-sim` — disable Anvil simulation
  - By default, assay will try to run an **Anvil fork simulation** for transaction inputs. Simulation success + decoded intent is the primary signal when available.
- `--fail-on <caution|warning|danger>` — set exit threshold (default: `warning`)
- `--output <path|->` (default: `-`)
- `--quiet` — suppress progress/logging

Examples:

```bash
assay scan 0x1234...
assay scan --calldata @tx.json --format json
cat tx.json | assay scan --calldata - --format sarif

# MetaMask "Hex Data" (raw calldata)
assay scan --calldata 0x... --to 0x... --from 0x... --value 0 --format json
```

### `assay proxy`

`assay proxy` runs a local JSON-RPC proxy for wallets. It intercepts send-transaction calls, runs `assay scan`, and blocks or prompts based on risk.

Examples (each command is independent):

```bash
# canonical pattern
assay proxy --upstream <RPC_URL> [--chain ethereum] [--wallet] [--record-dir <dir>]

# minimal explicit upstream
assay proxy --upstream https://... --chain ethereum

# wallet-fast mode
assay proxy --upstream https://... --wallet

# capture recordings for later review
assay proxy --upstream https://... --record-dir ./assay-recordings
```

Notes:
- `--wallet` enables a faster provider mix (keeps simulation, skips slower upstream calls).
- `--record-dir` saves a per-tx bundle (JSON-RPC request, parsed calldata, AnalyzeResponse, rendered output) under the given directory.
- For allowlists, see "Proxy Allowlist" below.

### Shared options (selected)

- `--chain, -c` Target chain (default: ethereum): `ethereum | base | arbitrum | optimism | polygon`
- `--offline` / `--rpc-only` Strict offline mode (OPT-IN)
  - Allows **only** explicitly configured upstream JSON-RPC URL(s) (`config.rpcUrls.<chain>` / `--upstream`).
  - Blocks **all other outbound HTTP(s)** calls (Safe Tx Service, Sourcify, Etherscan, GoPlus, DeFiLlama, 4byte, etc).
  - No implicit public RPC fallbacks.
- `--token/--spender/--amount/--expected` Approval analysis inputs

### MCP

Run an MCP server over stdio:

```bash
assay mcp
```

Tools exposed:
- `assay.analyzeTransaction`
- `assay.analyzeAddress`

### Claude Code: MCP vs non-MCP

**Recommended: MCP mode** (tool calls from Claude Code)

Add an MCP server entry in your Claude Code MCP config:

```json
{
  "mcpServers": {
    "assay": {
      "command": "assay",
      "args": ["mcp"]
    }
  }
}
```

Then Claude can call `assay.analyzeTransaction` / `assay.analyzeAddress` directly.

**Fallback: non-MCP mode** (CLI only)

Run Assay from terminal and paste output into Claude:

```bash
# address scan (JSON output)
assay scan 0x1234... --format json

# calldata scan from file
assay scan --calldata @tx.json --format json

# human-readable output
assay scan --calldata @tx.json --format text
```

## Output

```
╭─────────────────────────────────────────────────────────────────╮
│  ⚡ CAUTION                                                      │
├─────────────────────────────────────────────────────────────────┤
│  Contract: FiatTokenProxy                                       │
│  Chain: ethereum                                                │
│  Verified: ✓                                                    │
│  Address: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48            │
│  Proxy: Yes (0x43506849d7c04f9138d1a2050bbf3a0c054402dd)        │
├─────────────────────────────────────────────────────────────────┤
│  💰 BALANCE CHANGES (low confidence)                            │
│  - No balance changes detected                                  │
├─────────────────────────────────────────────────────────────────┤
│  🔐 APPROVALS (high confidence)                                 │
│  ⚠️ Allow 0x0000...8BA3 to spend UNLIMITED USDC (was 0)         │
╰─────────────────────────────────────────────────────────────────╯
```

**Exit codes:**
- `assay analyze` / `assay approval`:
  - `0` — OK per configured checks (no findings at/above the built-in thresholds)
  - `1` — CAUTION/WARNING
  - `2` — DANGER
- `assay scan` (pass/fail style):
  - `0` — pass (risk is below your `--fail-on` threshold)
  - `2` — fail/block (risk meets or exceeds `--fail-on`)
  - `1` — tool/usage error (bad flags or runtime failure)

Example with default threshold (`--fail-on warning`):
- `ok` / `caution` → `0`
- `warning` / `danger` → `2`

## Environment Variables

### Block Explorer Keys (optional, improves coverage)

Etherscan V2 supports a single API key across Etherscan-family chains.
Set `ETHERSCAN_API_KEY` once for all supported chains:

```bash
export ETHERSCAN_API_KEY=your_key
```

Without a key, analysis uses Sourcify only.

### Config File (alternative to env vars)

Create `./assay.config.json` or `~/.config/assay/config.json`:

```json
{
  "rpcUrls": {
    "ethereum": "https://eth.llamarpc.com"
  },
  "allowlist": {
    "to": ["0x..."],
    "spenders": ["0x..."]
  }
}
```

Override location with `ASSAY_CONFIG=/path/to/config.json`.

### Proxy Allowlist

When running `assay proxy`, you can optionally enforce a local allowlist so transactions are blocked unless they only touch trusted endpoints.

Config:

```json
{
  "allowlist": {
    "to": ["0x..."],
    "spenders": ["0x..."]
  }
}
```

Notes:
- `allowlist.to`: allowlisted transaction targets (`tx.to`).
- `allowlist.spenders`: allowlisted approval spenders/operators (from simulation + decoded calldata when available).
- If a transaction is blocked, the JSON-RPC error uses code `4001` and includes details under `error.data`:
  - `error.data.recommendation` + `error.data.simulationSuccess`
  - `error.data.allowlist` (when enabled): violations + `unknownApprovalSpenders`

## Library Usage

```typescript
import { scanAddress, scanCalldata } from "assay";

const response = await scanAddress("0x1234...", "ethereum", {
  baseUrl: "http://localhost:3000",
  apiKey: process.env.ASSAY_API_KEY,
});

console.log(response.scan.recommendation); // "ok" | "caution" | "warning" | "danger"
console.log(response.scan.contract.confidence); // "high" | "medium" | "low"
console.log(response.scan.simulation?.balances.confidence); // "high" | "medium" | "low" | "none"

const txResponse = await scanCalldata({
  to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  from: "0x1111111111111111111111111111111111111111",
  data: "0x095ea7b3...",
  chain: "ethereum",
});

console.log(txResponse.scan.simulation?.approvals.changes);
```


## Supported Chains

| Chain | Explorer Key Env Var |
|-------|---------------------|
| Ethereum | `ETHERSCAN_API_KEY` |
| Base | `ETHERSCAN_API_KEY` |
| Arbitrum | `ETHERSCAN_API_KEY` |
| Optimism | `ETHERSCAN_API_KEY` |
| Polygon | `ETHERSCAN_API_KEY` |

## Finding Codes

| Code | Level | Meaning |
|------|-------|---------|
| `UNVERIFIED` | danger | No source code available |
| `HONEYPOT` | danger | Can buy, can't sell |
| `HIDDEN_MINT` | danger | Owner can mint unlimited tokens |
| `SELFDESTRUCT` | danger | Contract can self-destruct |
| `OWNER_DRAIN` | danger | Owner can modify balances |
| `APPROVAL_TARGET_MISMATCH` | danger | Approval target doesn't match expected spender |
| `APPROVAL_TO_EOA` | danger | Approval spender is not a contract |
| `POSSIBLE_TYPOSQUAT` | danger | Spender resembles a known router address |
| `APPROVAL_TO_DANGEROUS_CONTRACT` | danger | Spender has danger findings |
| `KNOWN_PHISHING` | danger | Address flagged as phishing/scam |
| `BLACKLIST` | warning | Has blacklist functionality |
| `HIGH_TAX` | warning | Transfer tax > 10% |
| `NEW_CONTRACT` | warning | < 7 days old |
| `UPGRADEABLE` | warning | Proxy contract, code can change |
| `UNLIMITED_APPROVAL` | warning | Unlimited token approval |
| `APPROVAL_TO_UNVERIFIED` | warning | Spender contract is unverified |
| `APPROVAL_TO_NEW_CONTRACT` | warning | Spender contract is newly deployed |
| `LOW_ACTIVITY` | info | < 100 transactions |
| `VERIFIED` | safe | Source code verified |
| `KNOWN_PROTOCOL` | safe | Matched known protocol on DeFiLlama |

## Design Philosophy

1. **Any contract, not just tokens** — Works on all EVM contracts
2. **Unverified = danger** — If we can't see the code, that's a red flag
3. **Sourcify first** — Free, decentralized, no API key required
4. **Honest confidence** — We tell you when data is missing
5. **Findings, not scores** — Concrete facts with severity, not magic numbers

## Development

GitHub Actions runs two tiers of CI:
- **Tier 1 (PR gating)**: `.github/workflows/ci.yml` runs default `bun test` (skips live-network + fork/anvil e2e suites)
- **Tier 2 (comprehensive)**: `.github/workflows/ci-comprehensive.yml` runs nightly + manual (`workflow_dispatch`) with `ASSAY_LIVE_TESTS=1` and `ASSAY_FORK_E2E=1`

```bash
# Install deps
bun install

# Tier 1 (default): fast + deterministic (no live-network or fork e2e tests)
bun test

# Tier 2 (optional): run tests that hit live provider APIs (Sourcify/GoPlus/DeFiLlama/etc)
ASSAY_LIVE_TESTS=1 bun test

# Tier 2 (optional): run fork/anvil e2e suites (requires Foundry's `anvil`)
ASSAY_FORK_E2E=1 bun test

# Run everything
ASSAY_LIVE_TESTS=1 ASSAY_FORK_E2E=1 bun test

# Build
bun run build

# Lint + typecheck
bun run check
```

## License

This project is licensed under the [MIT License](./LICENSE).
