# assay

Pre-sign security analysis for EVM transactions.
Know what you're signing before you sign it.

- Scan a **contract address** or an **unsigned transaction intent** (to/data/value) before signing.
- Flags common drainer/scam signals (unverified code, phishing labels, risky approvals).
- Optional local simulation (Anvil) to preview balance + approval changes.
- Deterministic pre-sign checks only (no AI/source-code contract vulnerability auditing).

> ⚠️ **Disclaimer:** Assay provides informational risk signals only. It is not financial, legal, tax, or investment advice. Use at your own risk.

## Install (from source)

```bash
git clone https://github.com/marcomariscal/assay.git
cd assay
bun install
```

## 30-second use

Scan an unsigned tx (example: **unlimited USDC approval** to an unknown spender):

```bash
cat <<'JSON' | bun run src/cli/index.ts scan --calldata -
{
  "chain": "ethereum",
  "from": "0x1111111111111111111111111111111111111111",
  "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "value": "0",
  "data": "0x095ea7b3000000000000000000000000beef00000000000000000000000000000000beefffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
}
JSON
```

Notes:
- `assay scan` has two modes: **address scan** (`assay scan <address>`) and **transaction scan** (`assay scan --calldata ...`).
- Simulation is optional; if Anvil isn’t available, Assay continues without it.
- `--fail-on` defaults to `caution`.

<details>
<summary>Example output (malicious approval caught)</summary>

```text
Transaction scan on ethereum

┌────────────────────────────────────────────────────────────────────────────────────────┐
│  Chain: ethereum                                                                       │
│  Protocol: USDC (usdc)                                                                 │
│  Action: Allow 0x9999...9999 to spend up to UNLIMITED USDC (0xa0b8...eb48)             │
│  Contract: USD Coin                                                                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  🎯 RECOMMENDATION: 🚨 DANGER                                                          │
│  Why: Approval target is tied to known drainer activity                                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  🧾 CHECKS                                                                             │
│  Context: verified · age: — · txs: —                                                   │
│  ✓ Source verified                                                                     │
│  ✓ Known protocol: USDC                                                                │
│  🚨 Approval target is tied to known drainer activity [APPROVAL_TO_DANGEROUS_CONTRACT] │
│  ⚠️ Unlimited token approval (max allowance) [UNLIMITED_APPROVAL]                      │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  💰 BALANCE CHANGES                                                                    │
│  - No balance changes detected                                                         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  🔐 APPROVALS                                                                          │
│  ⚠️ Allow 0x9999...9999 to spend UNLIMITED USDC (was 0)                                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  👉 VERDICT: 🚨 DANGER                                                                 │
│  BLOCK — high-risk findings detected.                                                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

</details>

## Docs (advanced modes)

- [Proxy mode (wallet / JSON-RPC)](docs/guides/proxy.md) — intercept wallet RPC and scan what you're about to sign
- [MCP server](docs/guides/mcp.md) — let Claude Code call Assay as tools
- [Safe adapter](docs/guides/safe.md) — analyze Safe multisends and execTransaction flows
- [Offline / RPC-only mode](docs/guides/offline.md) — run without explorers/labels; rely on RPC (and optional simulation)
- [Embedded HTTP server + client helpers](docs/guides/http.md) — run `/v1/scan` locally and call it programmatically

## Development

```bash
bun run check
bun run build
bun test
```
