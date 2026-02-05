# M9: Post Warm-Anvil Latency Fix - Implementation Plan

## Context
M8 shipped the multi-interface foundations.

PR #21 (`fix(proxy): keep Anvil warm + fast reset between simulations`) targets Rabby’s ~5s timeout by keeping a long-lived Anvil fork warm and resetting state between simulations.

M9 is a set of *follow-ups* that make that latency work safer (regression coverage) and faster to iterate on (txHash → fixture/recording generation).

## Goals
- Add a **regression test** that locks in the intended **simulation fork RPC defaulting** behavior:
  - If `simulation.rpcUrl` is not explicitly set, simulations should fork from the **proxy upstream** URL (not the Anvil endpoint, and not a random default).
  - Explicit overrides (`simulation.rpcUrl`, `rpcUrls[chain]`) must still win.
- Add a **txHash → fixture generator** to quickly build deterministic simulation fixtures from real on-chain transactions.
  - Output should match the existing `TxFixture` shape used by e2e suites under `test/fixtures/txs/*`.

## Non-Goals
- Implementing a full `rugscan analyze-tx <txHash>` product surface (that’s a bigger feature; out of scope here).
- Adding new simulation semantics beyond defaults/fixture generation.
- Reworking the Anvil warm-reset design from PR #21.

## Assumptions / Open Decisions
- **Primary target chain** for txHash fixture generation is Ethereum mainnet (chainId `1`) initially; the code should be extendable to other chains.
- The fixture generator can rely on standard JSON-RPC methods:
  - `eth_getTransactionByHash`
  - `eth_getTransactionReceipt` (optional)
  - `eth_getBlockByNumber` (optional)
- For simulation stability we prefer a **fork block strictly before the tx executes**:
  - default `forkBlock = txBlock - 1`
  - record the original `txBlock` in `notes.txBlock`

If any of the above is wrong, confirm before implementation.

## Success Criteria
- `bun run check` passes.
- `bun test` passes.
- New regression test fails on a version that *does not* default simulation fork RPC to the proxy upstream.
- The fixture generator can create a new file under `test/fixtures/txs/` that passes `isTxFixture()` and can be used by existing simulation e2e suites.

---

## 1) Regression test: simulation fork RPC defaults

### 1.1 What we’re asserting
When running in proxy mode (or any mode that provides a proxy upstream URL to the scan/simulation layer):

1) If the user **does not set** `simulation.rpcUrl`, the simulation code should fork from the **proxy upstream** URL.
2) If the user **does set** `simulation.rpcUrl`, that must be used.
3) If the user sets `rpcUrls[chain]`, that should be used when `simulation.rpcUrl` is missing.

### 1.2 Suggested approach
- Add a focused unit/integration test near the config/scan boundary (where the defaulting decision is made).
- Keep it deterministic by **not** requiring Anvil to run.
- Prefer testing the *resolved value* that the simulation layer receives (or the function that resolves it), rather than an end-to-end proxy + simulation run.

### 1.3 Files likely touched
- `src/jsonrpc/proxy.ts` / `src/scan.ts` (where upstream is wired into scan config)
- `src/config.ts` and/or the simulation entrypoints
- New test file, e.g. `test/simulation-config-defaults.test.ts`

### 1.4 Test cases
- `defaults to upstream when simulation.rpcUrl unset`
- `simulation.rpcUrl override wins`
- `rpcUrls[chain] wins when simulation.rpcUrl unset`

---

## 2) txHash → fixture generator

### 2.1 Output format
Generate a JSON file matching the existing fixture schema:

```ts
export interface TxFixture {
  name: string;
  chainId: number;
  forkBlock: number;
  tx: {
    to: string;
    from: string;
    value: string;
    data: string;
  };
  notes?: {
    source?: string;
    txHash?: string;
    txBlock?: number;
    [k: string]: unknown;
  };
}
```

Naming convention: `test/fixtures/txs/<name>.json`, where `<name>` defaults to something like:
- `tx-<first8>` or a user-provided slug, and
- includes the short hash suffix for uniqueness (mirroring existing fixtures).

### 2.2 Suggested CLI shape
Add a script runnable via Bun, for example:

```bash
bun run src/scripts/txhash-fixture.ts \
  --chain 1 \
  --tx-hash 0x... \
  --rpc-url https://ethereum.publicnode.com \
  --out test/fixtures/txs/uniswap-v4-...-873d55dd.json
```

Optional enhancements (nice-to-have, keep minimal in v1):
- `--name <slug>` to control the fixture name
- `--fork-block <n>` override
- `--print` to emit JSON to stdout for quick copy/paste

### 2.3 Implementation notes
- Fetch tx via `eth_getTransactionByHash`.
- Fetch tx block number:
  - Prefer `tx.blockNumber` if present.
  - If missing (pending tx), error with a clear message.
- Set `forkBlock = txBlock - 1` (unless overridden).
- Serialize `value` as a base-10 string (matching existing fixtures).
- Preserve raw `data` hex.

### 2.4 Tests
- Unit test: validate that the generator’s output passes the same shape checks as `isTxFixture()`.
- (Optional) Smoke test: run one existing e2e suite using the generated fixture (but keep it stable; do not add flaky live-RPC dependencies).

---

## Rollout / Sequencing
1) Merge PR #21 (warm Anvil reset + upstream defaulting).
2) Land M9 regression test so the defaulting behavior can’t regress.
3) Land the txHash fixture generator to accelerate collecting new fixtures for e2e coverage.

## Validation checklist
- `bun run check`
- `bun test`
- (Manual) Generate a fixture from a known txHash and run the relevant simulation e2e test locally.
