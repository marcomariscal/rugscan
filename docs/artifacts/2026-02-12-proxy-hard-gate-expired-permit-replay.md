# Assay UX hard-gate proof — interactive proxy replay (expired permit deadline)

Date: 2026-02-12

## Commands run

```bash
# Terminal A (interactive)
bun run src/cli/index.ts proxy \
  --upstream https://eth.llamarpc.com \
  --port 9545 \
  --once \
  --record-dir docs/artifacts/proxy-replay-hard-gate-2026-02-12

# Terminal B
curl -sS -X POST http://127.0.0.1:9545 \
  -H 'content-type: application/json' \
  --data @test/fixtures/txs/permit-off-chain-signature-expired-deadline.json
```

## Interactive CLI transcript (captured)

```text
JSON-RPC proxy listening on http://127.0.0.1:9545
Wallet RPC URL: http://127.0.0.1:9545
Health check: http://127.0.0.1:9545
Upstream: https://eth.llamarpc.com
Mode: default (full coverage)
Threshold: caution
On risk: prompt

Configure your wallet's RPC URL to point at this proxy.

Typed-data signature scan on ethereum

Method: eth_signTypedData_v4
Recommendation: WARNING
Primary type: Permit

- Spender authority: 0x4444444444444444444444444444444444444444
- Allowance amount: 1000000
- Expiry is already expired (deadline 1699999900, now 1770934913).
- Only sign if you trust the spender, token, amount, and expiry settings.

Forward transaction anyway? (recommendation=warning, simulation=ok) [y/N] n
Blocked transaction.
```

## JSON-RPC block response excerpt

```json
{
  "error": {
    "code": 4001,
    "message": "Transaction blocked by assay",
    "data": {
      "recommendation": "warning",
      "typedData": {
        "method": "eth_signTypedData_v4",
        "primaryType": "Permit",
        "deadline": "1699999900",
        "findings": [
          { "code": "PERMIT_SIGNATURE", "severity": "caution" },
          { "code": "PERMIT_EXPIRED_DEADLINE", "severity": "warning" }
        ]
      }
    }
  }
}
```
