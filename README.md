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
