# Proxy recordings

This directory is used for *recorded* wallet transactions captured via:

```bash
bun run src/cli/index.ts proxy \
  --upstream https://ethereum.publicnode.com \
  --port 8545 \
  --threshold warning \
  --on-risk block \
  --record-dir test/fixtures/recordings
```

Each intercepted transaction will create a subdirectory containing:
- `rpc.json` – the original JSON-RPC request
- `calldata.json` – normalized calldata fields
- `analyzeResponse.json` – full AnalyzeResponse (if available)
- `rendered.txt` – rendered output (if available)
- `meta.json` – summary metadata

To keep snapshots stable, run the proxy with `NO_COLOR=1`.
