# rugscan

Pre-transaction security analysis for EVM contracts. Know what you're signing before you sign it.

## Features

- **Contract verification** — Sourcify (free) + Etherscan fallback
- **Proxy detection** — EIP-1967, UUPS, Beacon, minimal proxies (EIP-1167)
- **Token security** — Honeypot, hidden mint, blacklist, tax analysis (via GoPlus)
- **Protocol matching** — DeFiLlama integration for known protocols
- **Approval analysis** — Detect risky approval patterns before signing
- **Phishing detection** — Etherscan labels for known phishing/scam addresses
- **AI risk analysis** — Multi-provider LLM analysis with prompt injection hardening
- **Confidence levels** — Honest about what we can't see

## Install

```bash
bun add rugscan
```

## Quick Start

```bash
# Basic analysis
rugscan analyze 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

# Approval analysis
rugscan approval --token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --spender 0xE592427A0AEce92De3Edee1F18E0157C05861564 \
  --amount max \
  --expected 0xE592427A0AEce92De3Edee1F18E0157C05861564

# With AI analysis
ANTHROPIC_API_KEY=sk-... rugscan analyze 0x1234... --ai

# Different chain
rugscan analyze 0x1234... --chain base
```

## CLI Usage

```bash
rugscan analyze <address> [options]
rugscan approval --token <address> --spender <address> --amount <value> [--expected <address>] [--chain <chain>]

Options:
  --chain, -c    Target chain (default: ethereum)
                 ethereum | base | arbitrum | optimism | polygon
  
  --ai           Enable AI risk analysis (requires API key)
  
  --model        Override AI model or force provider
                 Examples: claude-sonnet-4-20250514
                          openai:gpt-4o
                          openrouter:anthropic/claude-3-haiku

  --token        Token address for approval analysis
  --spender      Spender address for approval analysis
  --amount       Approval amount (integer or "max")
  --expected     Expected spender address
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
│  Confidence: HIGH                                               │
├─────────────────────────────────────────────────────────────────┤
│  Findings:                                                      │
│  ✓ Source code verified: FiatTokenProxy [VERIFIED]              │
│  ⚠️ Upgradeable proxy (eip1967) - code can change [UPGRADEABLE] │
├─────────────────────────────────────────────────────────────────┤
│  AI Analysis (claude-sonnet):                                   │
│  Risk Score: 35/100                                             │
│  Summary: Standard upgradeable proxy pattern with centralized   │
│           upgrade authority...                                  │
│  Concerns:                                                      │
│    MEDIUM [centralization] Upgrade controlled by single admin   │
╰─────────────────────────────────────────────────────────────────╯
```

**Exit codes:**
- `0` — OK (safe to interact)
- `1` — CAUTION/WARNING (proceed with awareness)
- `2` — DANGER (high risk)

## Environment Variables

### Block Explorer Keys (optional, improves coverage)

```bash
export ETHERSCAN_API_KEY=your_key
export BASESCAN_API_KEY=your_key
export ARBISCAN_API_KEY=your_key
export OPTIMISM_API_KEY=your_key
export POLYGONSCAN_API_KEY=your_key
```

Without keys, analysis uses Sourcify only.

### AI Provider Keys (for `--ai` flag)

```bash
# Provider fallback order: Anthropic → OpenAI → OpenRouter
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export OPENROUTER_API_KEY=sk-or-...
```

Only one key is required. The first available provider is used unless you force one with `--model provider:model`.

### Config File (alternative to env vars)

Create `./rugscan.config.json` or `~/.config/rugscan/config.json`:

```json
{
  "ai": {
    "anthropic_api_key": "sk-ant-...",
    "openai_api_key": "sk-...",
    "openrouter_api_key": "sk-or-...",
    "default_model": "claude-sonnet-4-20250514"
  }
}
```

Override location with `RUGSCAN_CONFIG=/path/to/config.json`.

### Proxy Allowlist (v1)

When running `rugscan proxy`, you can optionally enforce a local allowlist so transactions are blocked unless they only touch trusted endpoints.

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
- If a transaction is blocked, the JSON-RPC error includes details under `error.data.allowlist` (violations + any unknowns).

## Library Usage

```typescript
import { analyze, analyzeApproval } from "rugscan";

const result = await analyze("0x1234...", "ethereum", {
  etherscanKeys: {
    ethereum: process.env.ETHERSCAN_API_KEY,
  },
  ai: {
    anthropic_api_key: process.env.ANTHROPIC_API_KEY,
  },
  aiOptions: {
    enabled: true,
    model: "claude-sonnet-4-20250514",
  },
});

// Result shape
console.log(result.recommendation); // "ok" | "caution" | "warning" | "danger"
console.log(result.findings);       // Finding[]
console.log(result.confidence);     // { level: "high" | "medium" | "low", reasons: string[] }
console.log(result.ai);             // AIAnalysis | undefined

const approvalResult = await analyzeApproval(
  {
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    spender: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    amount: 1_000_000n,
  },
  "ethereum",
  {
    expectedSpender: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  },
);

console.log(approvalResult.recommendation); // "ok" | "caution" | "warning" | "danger"
console.log(approvalResult.findings);       // Finding[]
console.log(approvalResult.spenderAnalysis); // AnalysisResult
```

## AI Analysis

When `--ai` is enabled, rugscan sends contract data to an LLM for deeper analysis:

**What's analyzed:**
- Contract metadata (age, tx count, verification status)
- Proxy architecture and implementation
- Token security flags from GoPlus
- Source code (if verified)
- Existing findings from static checks

**Output:**
- Risk score (0-100)
- Summary explanation
- Specific concerns with severity and category

**Security hardening:**
- Schema enforcement via Zod (structured output only)
- Source code sanitization (comments stripped, unicode normalized)
- Adversarial prompt detection
- Output anomaly detection

**Provider defaults:**
| Provider | Default Model |
|----------|---------------|
| Anthropic | claude-sonnet-4-20250514 |
| OpenAI | gpt-4o |
| OpenRouter | anthropic/claude-3-haiku |

## Supported Chains

| Chain | Explorer Key Env Var |
|-------|---------------------|
| Ethereum | `ETHERSCAN_API_KEY` |
| Base | `BASESCAN_API_KEY` |
| Arbitrum | `ARBISCAN_API_KEY` |
| Optimism | `OPTIMISM_API_KEY` |
| Polygon | `POLYGONSCAN_API_KEY` |

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
| `AI_WARNING` | info | AI analysis flagged anomaly |
| `VERIFIED` | safe | Source code verified |
| `KNOWN_PROTOCOL` | safe | Matched known protocol on DeFiLlama |

## Design Philosophy

1. **Any contract, not just tokens** — Works on all EVM contracts
2. **Unverified = danger** — If we can't see the code, that's a red flag
3. **Sourcify first** — Free, decentralized, no API key required
4. **Honest confidence** — We tell you when data is missing
5. **Findings, not scores** — Concrete facts with severity, not magic numbers
6. **BYOK for AI** — Bring your own API keys, no hosted tier, you control costs

## Development

GitHub Actions runs two tiers of CI:
- **Tier 1 (PR gating)**: default `bun test` (skips live-network + fork/anvil e2e suites)
- **Tier 2 (comprehensive)**: enables live-network + fork/anvil e2e suites

```bash
# Install deps
bun install

# Tier 1 (default): fast + deterministic (no live-network or fork e2e tests)
bun test

# Tier 2 (optional): run tests that hit live provider APIs (Sourcify/GoPlus/DeFiLlama/etc)
RUGSCAN_LIVE_TESTS=1 bun test

# Tier 2 (optional): run fork/anvil e2e suites (requires Foundry's `anvil`)
RUGSCAN_FORK_E2E=1 bun test

# Run everything
RUGSCAN_LIVE_TESTS=1 RUGSCAN_FORK_E2E=1 bun test

# Build
bun run build

# Lint + typecheck
bun run check
```

## License

MIT
