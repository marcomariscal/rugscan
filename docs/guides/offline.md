# Offline / RPC-only mode (`--offline` / `--rpc-only`)

Offline mode is **strict** and is intended for environments where you want to ensure Assay only talks to explicitly provided JSON-RPC endpoints.

## Semantics (locked)

When `--offline` / `--rpc-only` is enabled:
- Assay allows **only** explicitly configured upstream JSON-RPC URL(s).
- Assay blocks **all other outbound HTTP(s)** calls (Safe Tx Service, Sourcify, Etherscan, GoPlus, DeFiLlama, 4byte, etc).
- There are **no implicit public RPC fallbacks**.

## CLI examples

### `assay scan` (offline)

```bash
assay scan 0x1234... --offline
```

This requires that `rpcUrls.<chain>` exists in your config.

### `assay proxy` (offline)

```bash
assay proxy --upstream <RPC_URL> --offline
```

In proxy mode, the upstream RPC URL you provide is the only allowed non-local HTTP destination.

## Config

Create `./assay.config.json` or `~/.config/assay/config.json`:

```json
{
  "rpcUrls": {
    "ethereum": "https://your.rpc.example"
  }
}
```

If you set `--chain base`, you must set `rpcUrls.base`, etc.
