# Multicall3 Balance Simulation (Pre-sign)

Date: 2026-02-02

## Assumptions
- Goal: show users token/native balance deltas before signing a transaction.
- Constraints: no paid simulation APIs or API keys (no Tenderly/Alchemy).
- Inputs available: from, to, data, value, chain id.
- Access to public RPC endpoints is acceptable.
- Multicall3 is available at `0xcA11bde05977b3631167028862bE2a173976CA11` on most major EVM chains. [^multicall3-address]

## Feasibility assessment
- Verdict: **Partial**.
- You can use Multicall3 + eth_call to batch balance reads in a single request, but it does **not** accurately simulate a user transaction because any calls executed by Multicall3 run with `msg.sender = Multicall3` (not the user). Multicall3 itself warns that calling it from an EOA only works when `msg.sender` does not matter. [^multicall3-msgsender]
- eth_call executes a message call without creating a transaction on-chain, so any state changes are ephemeral and not persisted. [^eth-call-spec]
- Multicall3 is explicitly built for both reads and writes (no functions are `view` and all are payable), so it can *execute* state-changing calls in principle, but that does not solve the `msg.sender` mismatch. [^multicall3-usage]

## Why Multicall3 falls short for tx balance diffs
1. **`msg.sender` mismatch**
   - The transaction you want to simulate is signed by the user, so contracts expect `msg.sender = user`.
   - When you call Multicall3 from an EOA, it uses CALL, so any downstream calls see `msg.sender = Multicall3`. Multicall3 docs explicitly say this makes EOA calls only safe when `msg.sender` does not matter. [^multicall3-msgsender]
   - This breaks common flows (DEX swaps, `transferFrom`, `permit` validations, allowance checks, and router callbacks), meaning the “target tx” often reverts or executes in a different context.

2. **`msg.value` handling**
   - Multicall3 supports per-call value with `aggregate3Value`, but that still sends value from the Multicall3 call context, not from the user. [^multicall3-aggregate3value]

3. **You cannot persist state across calls**
   - `eth_call` does not create a transaction; state changes are not committed. [^eth-call-spec]
   - Even if you batch “before -> target -> after” inside one eth_call, the target runs with the wrong sender, and any state writes are non-persistent.

## Implementation approach (only if you accept limited accuracy)
Use Multicall3 to **batch read-only balance snapshots** at a single block:
- Pre-state balances: ERC-20 `balanceOf` for a curated token set + `getEthBalance` for native token.
- Provide a **best-effort** diff by decoding calldata for direct token transfers, approvals, or known router paths.
- Treat the results as **heuristic** and label as “estimated / not simulated” unless you have a proper trace-based simulation.

This is still valuable for:
- Showing the current balances for tokens likely to be involved.
- Highlighting approvals or direct transfers found in calldata.

## How to identify tokens to check (heuristics)
1. **Direct ERC-20 calls**
   - If `to` is an ERC-20 and calldata selector matches `transfer`, `transferFrom`, or `approve`, the token is the `to` address.

2. **Known router ABIs**
   - For DEX routers, decode calldata and extract token addresses from `path` (Uniswap V2/V3) or route structs.
   - For aggregators, decode nested multicalls if present.

3. **Wallet inventory**
   - Use a local cache of tokens the user already holds (from prior balance scans).

4. **Curated allowlist**
   - Maintain a chain-specific list of common tokens; fall back to this when decoding fails.

## Limitations and edge cases
- **Most swaps will fail in Multicall3** due to `msg.sender` mismatch and allowance checks. [^multicall3-msgsender]
- **Approvals vs transfers**: approvals change allowances, not balances, so balance diffs can miss dangerous approvals.
- **Native token flows**: ETH is moved via `value` and internal calls; without tracing, you cannot reliably determine refunds or fee mechanics.
- **Fee-on-transfer / rebasing tokens**: balance changes can be nonlinear or off by protocol fees.
- **Callback-based transfers** (Uniswap V3, Permit2): these depend on sender context and can’t be simulated via Multicall3 from an EOA.
- **Multi-step transactions**: decoding nested multicalls or delegatecalls is non-trivial without full ABI coverage.

## Alternative approaches (no API keys)
1. **Local fork simulation (best accuracy without external APIs)**
   - Run a local fork (anvil/Hardhat/Foundry) against a public RPC, then execute the transaction as the user and read balances before/after.
   - This gives accurate state diffs because the fork commits the tx locally.

2. **Self-hosted node with tracing or eth_simulateV1**
   - Geth exposes `eth_simulateV1` to simulate multiple blocks/transactions without creating on-chain transactions, with options like `traceTransfers` for ETH movements. [^geth-eth-simulate]
   - Erigon/Nethermind/Geth debug tracing can return call traces and state diffs, but require running your own node.

3. **State override + call tracing**
   - Some clients let you override balances/allowances for a single call; combine with tracing to extract transfers.
   - Still requires a trace-capable node and custom logic.

## viem examples

### 1) Batch balance reads with Multicall3 (read-only snapshot)
```ts
import { createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult } from 'viem'
import { mainnet } from 'viem/chains'

const multicall3Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

const multicall3Abi = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
])

const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
])

const client = createPublicClient({
  chain: mainnet,
  transport: http('https://rpc.ankr.com/eth'),
})

const user = '0x0000000000000000000000000000000000000000'
const token = '0x0000000000000000000000000000000000000000'

const callData = encodeFunctionData({
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [user],
})

const results = await client.readContract({
  address: multicall3Address,
  abi: multicall3Abi,
  functionName: 'aggregate3',
  args: [[{ target: token, allowFailure: false, callData }]],
})

const [first] = results
if (first && first.success) {
  const balance = decodeFunctionResult({
    abi: erc20Abi,
    functionName: 'balanceOf',
    data: first.returnData,
  })
  console.log(balance)
}
```

### 2) Local fork simulation (accurate diffs, no API keys)
```ts
import { createTestClient, http, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'
import { publicActions, walletActions } from 'viem/actions'

const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
])

const client = createTestClient({
  chain: mainnet,
  mode: 'anvil',
  transport: http('http://127.0.0.1:8545'),
})
  .extend(publicActions)
  .extend(walletActions)

const user = '0x0000000000000000000000000000000000000000'
const token = '0x0000000000000000000000000000000000000000'

await client.impersonateAccount({ address: user })
await client.setBalance({ address: user, value: 10_000_000_000_000_000n })

const before = await client.readContract({
  address: token,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [user],
})

const hash = await client.sendTransaction({
  account: user,
  to: '0x0000000000000000000000000000000000000000',
  data: '0x',
  value: 0n,
})

await client.waitForTransactionReceipt({ hash })

const after = await client.readContract({
  address: token,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [user],
})

console.log({ before, after, diff: after - before })
```

## Recommendation
- **Do not rely on Multicall3 to simulate arbitrary user transactions.** It is great for batched reads, but the `msg.sender` mismatch makes it unsuitable for accurate pre-sign balance diffs. [^multicall3-msgsender]
- If you need accurate balance changes without API keys, run a **local fork** and compute diffs there.
- If you can operate your own node, consider **eth_simulateV1** or trace-based approaches for better transfer detection. [^geth-eth-simulate]

## References
[^multicall3-usage]: https://github.com/plumenetwork/multicall3
[^multicall3-msgsender]: https://github.com/plumenetwork/multicall3
[^multicall3-aggregate3value]: https://docs.iota.org/developer/iota-evm/tools/multicall
[^multicall3-address]: https://docs.iota.org/developer/iota-evm/tools/multicall
[^eth-call-spec]: https://anukul.js.org/execution-apis/docs/reference/eth_call/
[^geth-eth-simulate]: https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth
