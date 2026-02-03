# Balance Simulation — Implementation Plan

## Goals
- Show users which assets move when they sign a transaction (native + ERC-20 + ERC-721 + ERC-1155).
- Work without verified ABIs and without paid simulation APIs.
- Handle scam/drainer flows where selectors are unknown or obfuscated.
- Produce a clear, minimal diff: before/after + net change for the user.

## Non-Goals (explicit)
- Full call trace decoding or human-readable intent for every call.
- Guaranteed accuracy for smart-contract wallets (Safe, Argent, etc.).
- Token inventory indexing across the entire chain.
- Gas price prediction beyond what the simulated tx returns.

## Assumptions / Open Decisions
- **EOA-focused**: The primary use case is EOA-signed transactions. If `from` is a contract, results are best-effort and flagged low-confidence.
- **RPC quality**: We have a stable public RPC per chain. If a block number is pinned, the RPC must be archive-capable.
- **Local execution**: We can run anvil locally (Foundry installed) for accurate diffs.
- **No paid APIs**: We do not integrate Tenderly/Alchemy for now.

If any of these assumptions are wrong, confirm before implementation.

## Success Criteria
- A single API can simulate a pre-sign tx and return asset changes for the user.
- ERC-20 changes are shown even when ABI is missing (via logs + balance diffs).
- ERC-721 and ERC-1155 transfers are captured with token IDs and amounts.
- The output includes success/revert status, gas used, and confidence signals.
- If simulation cannot run, we return a clear fallback message and partial results (if any).

---

## Review: Multicall3 Research Summary (Decision Input)
- Multicall3 is **not** reliable for simulating arbitrary user txs because `msg.sender` becomes Multicall3, not the user, which breaks most workflows (allowances, router callbacks, permit flows).
- `eth_call` does not persist state, so before/after diffs are not accurate for balance changes.
- Conclusion: **Multicall3 is only suitable for read-only snapshots**, not transaction simulation.

## Decision: Use Anvil Fork as Primary Path
- **Chosen approach**: Anvil fork simulation with impersonation.
- **Why**: It executes the tx in a real EVM environment with `msg.sender = user`, so balance diffs are accurate even for unknown/obfuscated contracts.
- **Fallback**: If anvil is unavailable, return a best-effort heuristic using calldata decoding + read-only balance snapshots (clearly labeled as estimated).

---

## Architecture Decisions

### 1) Simulation Backend
- **Primary**: Local Anvil fork (`anvil --fork-url <rpc>`)
- **Fallback**: Heuristic-only mode (no fork), using calldata decoding + optional token snapshots.
- **Config knobs**:
  - `simulation.enabled` (default: false)
  - `simulation.backend` = `anvil` | `heuristic`
  - `simulation.anvilPath` (optional override)
  - `simulation.forkBlock` (optional; requires archive RPC)
  - `simulation.rpcUrl` (optional override; default to chain RPC)

### 2) Token Discovery Strategy
We need a minimal but reliable token set to diff:
1. **Post-sim logs** (primary): parse receipt logs for ERC-20/721/1155 events to discover token contracts and assets moved.
2. **Calldata decoding** (secondary): use existing decoder to extract token addresses from direct calls or known multicall patterns.
3. **Curated token list** (fallback): chain-specific list of top tokens for snapshot-only cases.

This avoids chain-wide inventory scans and keeps perf acceptable.

### 3) NFT Handling
- **ERC-721**: use `Transfer(address,address,uint256)` logs; treat `uint256` as `tokenId` when the contract supports ERC-165 `0x80ac58cd`.
- **ERC-1155**: use `TransferSingle` / `TransferBatch` logs to capture token IDs + amounts.
- **Ambiguity**: `Transfer` is shared by ERC-20 and ERC-721. Disambiguate by `supportsInterface` checks; if unknown, default to ERC-20 with low confidence.

### 4) Native Asset Handling
- Compute native balance diff for the user using before/after balances.
- Separate gas cost from net value change (gasUsed * effectiveGasPrice from receipt).

---

## Proposed Code Structure

### New Types (`src/types.ts`)
Add:
```ts
export interface AssetChange {
  assetType: "native" | "erc20" | "erc721" | "erc1155";
  address?: string; // token contract for non-native
  tokenId?: bigint; // NFT ID for 721/1155
  amount?: bigint;  // amount for native/erc20/erc1155
  direction: "in" | "out";
  counterparty?: string;
}

export interface BalanceSimulationResult {
  success: boolean;
  revertReason?: string;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  nativeDiff?: bigint;
  assetChanges: AssetChange[];
  confidence: "high" | "medium" | "low";
  notes: string[];
}
```

### New modules
- `src/simulations/anvil.ts`
  - spawn/stop anvil, manage child process lifecycle
  - expose a `getClient(chain, config)` that returns a viem test client
- `src/simulations/balance.ts`
  - `simulateBalance(tx, chain, config): Promise<BalanceSimulationResult>`
  - shared logic to run tx, snapshot balances, parse logs, and compute diffs
- `src/simulations/logs.ts`
  - parse receipt logs into ERC-20/721/1155 transfers
  - ERC-165 checks to disambiguate token types

### Touch points
- `src/scan.ts` or a new public API entry to expose simulation output.
- `src/cli/ui.ts` to display balance diffs (if we decide to surface in CLI).
- `src/config.ts` to support new simulation config fields.

---

## Simulation Flow (Anvil)
1. Resolve chain + RPC URL + optional fork block.
2. Ensure `anvil` is available; if not, fall back to heuristic mode.
3. Start (or reuse) anvil fork for the chain.
4. Impersonate `from` address and set a high native balance.
5. Snapshot pre-state:
   - native balance
   - ERC-20 balances for discovered tokens (initially from calldata and/or curated list)
6. Send the unsigned tx via `sendTransaction` as `from`.
7. Wait for receipt and capture logs.
8. Discover tokens/NFTs from logs and expand token set.
9. Re-read balances for discovered ERC-20 tokens; compute diffs.
10. Build NFT changes from logs.
11. Compute native diff and gas cost.
12. Return `BalanceSimulationResult` with confidence + notes.
13. Revert snapshot or reset state for next run; keep anvil alive for reuse.

---

## Edge Cases & Risks
- **Reverted tx**: return `success = false`, include revert reason, and show no asset changes.
- **Smart contract wallets**: impersonation can bypass Safe signature logic; flag low confidence if `from` is a contract.
- **Fee-on-transfer / rebasing tokens**: balance diffs may not align with naive expectations; rely on actual post-state.
- **Tokens without standard events**: they may not appear in logs; use balance diff only for discovered tokens.
- **ERC-20 vs ERC-721 ambiguity**: if ERC-165 check fails or reverts, mark low confidence.
- **RPC rate limits**: fork start and balance calls are bursty; need retries and backoff.
- **Fork freshness**: simulations run on the latest block; if the real tx executes later, results may diverge.

---

## Performance Considerations
- **Fork startup**: starting anvil per request is slow. Prefer a small pool of long-lived anvil instances per chain.
- **Snapshots**: use `evm_snapshot` / `evm_revert` for fast resets between txs.
- **Token balance reads**: batch `balanceOf` calls with multicall on the fork (safe because `msg.sender` doesn’t matter for `balanceOf`).
- **Concurrency**: cap simulations per chain to avoid CPU/memory spikes.

---

## Challenges & Proposed Solutions

### How to know which tokens to check?
- Primary: use receipt logs (Transfer/TransferSingle/TransferBatch) to discover tokens touched.
- Secondary: decode calldata for direct token targets and known router paths.
- Fallback: curated chain token list for a minimal snapshot.

### How to handle NFTs?
- Parse ERC-721 and ERC-1155 transfer logs and build explicit asset changes with token IDs and amounts.
- Avoid enumerating owner token IDs (too expensive).

### Performance (fork startup time)?
- Use a long-lived anvil pool; snapshot/revert per request.
- Allow a lightweight heuristic mode when anvil is unavailable or overloaded.

### Does user need Foundry installed?
- **Yes for anvil**. We should detect `anvil` on PATH and fall back to heuristic mode if missing.
- Optional: document Docker-based anvil as an alternative (not required in v1).

---

## Testing Plan
- Unit tests:
  - Log parsing for ERC-20/721/1155 (known fixtures).
  - ERC-165 detection helpers (true/false/revert cases).
  - AssetChange normalization and diff logic.
- Integration tests:
  - Spin up anvil fork against a local devnet or small chain fork (if available) and simulate a known ERC-20 transfer.
  - If integration tests are too heavy for CI, gate behind an env flag.

---

## Estimated Effort (rough)
- Core simulation runner + types: 3-4 days
- Log parsing + NFT handling: 2-3 days
- Anvil pool + snapshots + config wiring: 2-3 days
- CLI/UI presentation (if needed): 1-2 days
- Tests + docs: 2-3 days

Total: ~2 weeks (one engineer), depending on CI constraints and RPC stability.

---

## Open Questions
- Should balance simulation be part of `analyze()` output or a separate API endpoint?
- Do we want to surface approvals/permits alongside asset changes in the same output?
- Should we store simulation artifacts (logs, traces) for later debugging?
- What is the desired UX when simulation cannot run (fallback vs hard error)?

