# Proxy mode (`assay proxy`)

`assay proxy` runs a local JSON-RPC proxy that forwards requests to an upstream RPC and (optionally) preflights risky transaction submissions.

Use cases:
- Point a wallet (or any JSON-RPC client) at a local endpoint.
- Intercept `eth_sendTransaction` / `eth_sendRawTransaction` and block/prompt on risk.

## Start a proxy

```bash
assay proxy --upstream <RPC_URL>
```

By default it listens on `http://127.0.0.1:8545`.

Useful flags:
- `--hostname <host>` (default: `127.0.0.1`)
- `--port <port>` (default: `8545`)
- `--once` (handle one request then exit)
- `--quiet` (less output)

## Wallet mode (fast)

Wallet mode is intended for interactive pre-sign flows.

```bash
assay proxy --upstream <RPC_URL> --wallet
```

Notes:
- `--wallet` skips slower providers but keeps simulation.
- When scanning is enabled, the proxy attaches a short rendered summary to the JSON-RPC error details when it blocks.

## Allowlist (v1)

You can optionally enforce a local allowlist so transactions are blocked unless they only touch trusted endpoints.

Config example (`assay.config.json` or `~/.config/assay/config.json`):

```json
{
  "allowlist": {
    "to": ["0x..."],
    "spenders": ["0x..."]
  }
}
```

- `allowlist.to`: allowlisted transaction targets (`tx.to`).
- `allowlist.spenders`: allowlisted approval spenders/operators (from simulation + decoded calldata when available).

When a transaction is blocked, the JSON-RPC error uses code `4001` and includes details under `error.data`:
- `error.data.recommendation` + `error.data.simulationSuccess`
- `error.data.allowlist` (when enabled): violations + `unknownApprovalSpenders`

## Offline / RPC-only

See `offline.md` for strict offline semantics when running the proxy (`--offline` / `--rpc-only`).
