# Embedded HTTP server + HTTP client helpers

Assay includes an embedded Bun HTTP server (single endpoint: `POST /v1/scan`) plus a tiny HTTP client.

This is an **advanced integration mode**. For most local usage, prefer the CLI (`assay scan ...`).

## Server

### Run a local server (from source)

Set an API key (required):

```bash
export ASSAY_API_KEY=dev
```

Start the server:

```bash
bun run scripts/http-server.ts --port 3000
```

Endpoint:
- `POST http://localhost:3000/v1/scan`
- Auth header: `Authorization: Bearer $ASSAY_API_KEY`

Request body must contain exactly one of:
- `{ "address": "0x...", "chain": "ethereum" }`, or
- `{ "calldata": { "to": "0x...", "data": "0x...", "value?": "...", "from?": "...", "chain?": "..." } }`

### Programmatic server (Bun)

```ts
import { createServer } from "../src/server";

const server = createServer({ port: 3000, apiKey: process.env.ASSAY_API_KEY });
console.log(`listening on http://localhost:${server.port}`);
```

## Client helpers

The HTTP client is exported from the package:

```ts
import { scanAddress, scanCalldata } from "assay";

const baseUrl = "http://localhost:3000";
const apiKey = process.env.ASSAY_API_KEY;

const addressResponse = await scanAddress(
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "ethereum",
  { baseUrl, apiKey },
);

const txResponse = await scanCalldata(
  {
    to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    from: "0x1111111111111111111111111111111111111111",
    value: "0",
    data: "0x095ea7b3...",
    chain: "ethereum",
  },
  { baseUrl, apiKey },
);
```

Notes:
- The default base URL is `http://localhost:3000`.
- Requests time out after 10 seconds.
