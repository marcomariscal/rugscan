# assay

Pre-sign security analysis for EVM transactions.
Know what you're signing before you sign it.

- Scan a **contract address** or an **unsigned transaction intent** (to/data/value) before signing.
- Flags common drainer/scam signals (unverified code, phishing labels, risky approvals).
- Optional local simulation (Anvil) to preview balance + approval changes.

> ⚠️ **Disclaimer:** Assay provides informational risk signals only. It is not financial, legal, tax, or investment advice. Use at your own risk.

## Install (from source)

```bash
git clone https://github.com/marcomariscal/assay.git
cd assay
bun install
```

## 30-second use

Scan an unsigned tx (example: ERC-20 approve). This disables simulation so it works without Foundry/Anvil:

```bash
cat <<'JSON' | bun run src/cli/index.ts scan --calldata - --no-sim --fail-on caution
{
  "chain": "ethereum",
  "from": "0x1111111111111111111111111111111111111111",
  "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "value": "0",
  "data": "0x095ea7b3000000000000000000000000e592427a0aece92de3edee1f18e0157c058615640000000000000000000000000000000000000000000000000000000000000000"
}
JSON
```

Notes:
- `assay scan` has two modes: **address scan** (`assay scan <address>`) and **transaction scan** (`assay scan --calldata ...`).
- `--fail-on` defaults to `warning`, so `caution` exits **0** by default. For strict gating, use `--fail-on caution`.

## Docs (advanced modes)

- Proxy mode (wallet / JSON-RPC): `docs/guides/proxy.md`
- MCP server: `docs/guides/mcp.md`
- Safe adapter: `docs/guides/safe.md`
- Offline / RPC-only mode: `docs/guides/offline.md`
- Embedded HTTP server + HTTP client helpers: `docs/guides/http.md`

## Development

```bash
bun run check
bun run build
bun test
```
