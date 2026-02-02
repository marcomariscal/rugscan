# Calldata Decoding and Balance Simulation for Pre-Sign Security

Date: 2026-02-02

## Assumptions
- Target: pre-sign security analysis for EVM transactions (wallet or backend).
- Inputs available: chain id, from, to, data, value, and optional access list.
- Goal: explain intent, predict balance deltas, and flag high-risk patterns.

## Deprecation checks (external APIs)
- Alchemy legacy RPC endpoint alchemyapi.io is scheduled to shut down on 2026-01-31. Use g.alchemy.com endpoints if any RPC calls are involved. [^alchemy-changelog]
- No other deprecation notices were found in the official docs reviewed; re-check vendor changelogs before integration.

## Part 1: Calldata decoding

### 1. Function selector decoding
- ABI rules: the function selector is the first 4 bytes of keccak256(functionSignature). The return type is not part of the signature, and arguments begin at byte 5. The ABI encoding is not self-describing, so you need a schema to decode. [^abi-spec]
- Signature databases:
  - 4byte.directory provides an API that maps selectors to text signatures. [^4byte-docs]
  - ethereum-lists/4bytes is a static signature list; it documents collisions and returns multiple matches separated by semicolons. [^4bytes-repo]
  - sig.eth (samczsun) is cited as a signature database alongside 4byte in ecosystem tooling discussions. [^sigeth-blockscout]
  - Etherface references eth.samczsun as a comparable signature database. [^etherface]
  - openchain.xyz signature API has migrated to api.4byte.sourcify.dev (same API). [^openchain]
- Handling unknown selectors:
  - If no match, treat as unknown and show raw calldata plus best-effort heuristics.
  - If multiple matches exist, present all candidates with low confidence. Collisions are explicitly documented in 4bytes lists. [^4bytes-repo]

### 2. Argument decoding without a full ABI
- Because ABI encoding is not self-describing, decoding requires a schema (types). Without a full ABI you can only guess. [^abi-spec]
- Strategy:
  1. Try known ABI from verified source or local cache.
  2. If missing, use selector databases to get candidate signatures.
  3. Decode each candidate and score plausibility (address checksums, reasonable uint sizes, etc).
  4. Surface ambiguity in the UI.
- Common patterns to seed decoding:
  - ERC-20 approve/transfer/transferFrom semantics come from EIP-20. [^eip20]
  - Permit (EIP-2612) is an on-chain method that sets allowance via signature parameters. [^eip2612]
- ABI guessing:
  - Whatsabi can extract selectors from bytecode and attempt ABI inference, but it documents caveats: argument guessing and view/payable detection are unreliable, and event parsing is best-effort. [^whatsabi]

### 3. Nested calls and multicall decoding
- Uniswap V3 Multicall takes a bytes[] of encoded function data for calls to the same contract; decode each element using that contract's ABI. [^uniswap-multicall]
- Multicall3 aggregate uses Call structs that include target and data, enabling per-target ABI decoding for each call. [^multicall3]

### 4. Existing tools and libraries
- viem
  - decodeFunctionData decodes selector + arguments given an ABI. [^viem-decodeFunctionData]
  - decodeAbiParameters decodes argument data given parameter types. [^viem-decodeAbiParameters]
- ethers.js
  - Interface encodes/decodes using ABI fragments; the EVM does not understand ABI, so you must supply one. [^ethers-interface]
- Whatsabi
  - Extracts ABI metadata from bytecode with known caveats. [^whatsabi]
- Signature databases
  - 4byte.directory API and ethereum-lists/4bytes for selector lookups; sig.eth as a community DB. [^4byte-docs] [^4bytes-repo] [^sigeth-blockscout]
- Blowfish and Pocket Universe
  - Blowfish API client scans transactions to return warnings and human-readable simulation results. [^blowfish-api-client]
  - Pocket Universe JS library runs simulations and returns asset changes, handling ERC20/721/1155 and WETH deposit/withdraw events. [^pocket-universe]

### 5. Security-relevant patterns to detect
- Approvals and transfers
  - Detect ERC-20 approve/transfer/transferFrom to surface token flows and permissions. [^eip20]
- Unlimited approvals
  - OpenZeppelin notes that max uint256 allowance is treated as infinite and not decremented by transferFrom. Flag as high risk. [^openzeppelin-erc20]
- Permit signatures
  - Detect EIP-2612 permit calls to surface allowance changes and nonce consumption. [^eip2612]
- Signature phishing
  - Off-chain signatures can be collected and used later; warn when signature flows grant spend authority. [^metamask-signature-phishing]
- Multicall bundles
  - Recursively decode each call and apply the same risk rules. [^uniswap-multicall] [^multicall3]
- Transfers or approvals to suspicious destinations
  - Use address risk lists and domain blocklists to flag known bad destinations or dapp origins (vendor or in-house). Blowfish provides a blocklist library for domain scanning. [^blowfish-blocklist]

## Part 2: Balance simulation

### 1. Simulation providers (summary)
- Tenderly
  - tenderly_simulateTransaction (RPC) returns decoded logs, call trace, asset changes, state changes, balance changes, and more. [^tenderly-sim-rpc]
  - Simulation API and RPC return the same results; API calls are billed in Tenderly Units (TUs). [^tenderly-faq]
  - Transaction Preview docs show wallet integration patterns (asset changes, gas, errors, decoded events). [^tenderly-preview]
- Alchemy
  - alchemy_simulateAssetChanges returns asset changes, gas used, and metadata (asset type, change type, amounts). [^alchemy-asset-changes]
  - simulateExecution returns decoded traces/logs plus error and revertReason. [^alchemy-sim-exec]
  - Asset changes simulation does not run the transaction on-chain. [^alchemy-sim-asset-sdk]
  - Bundle simulation supports up to 3 transactions and includes CU cost notes. [^alchemy-bundle]
- Blowfish
  - API client scans transactions and returns warnings plus human-readable simulation results. [^blowfish-api-client]
- Local fork
  - Hardhat supports forking via a JSON-RPC URL and optional blockNumber. [^hardhat-config]
  - Hardhat mainnet forking requires an archive node for historical state. [^hardhat-forking]
  - Anvil can fork a live network via --fork-url; the CLI supports optional block number in the fork URL syntax. [^anvil-overview] [^anvil-cmd]

### 2. What they return (capabilities)
- Asset in/out
  - Tenderly: assetChanges and balanceChanges are included in simulate results. [^tenderly-sim-rpc]
  - Alchemy: asset changes include asset types (native/ERC20/ERC721/ERC1155), change types (approval/transfer), amounts, and metadata. [^alchemy-asset-changes]
  - Pocket Universe: returns asset changes derived from events. [^pocket-universe]
- State changes and traces
  - Tenderly returns decoded call traces and stateChanges. [^tenderly-sim-rpc]
  - Alchemy simulateExecution returns decoded traces and logs. [^alchemy-sim-exec]
- Gas estimation and reverts
  - Tenderly provides gas usage and error details via simulations. [^tenderly-faq]
  - Alchemy asset changes include gasUsed and an error field; simulateExecution includes error and revertReason. [^alchemy-asset-changes] [^alchemy-sim-exec]

### 3. Integration patterns
- Wallet-style previews
  - Tenderly's Transaction Preview shows how to expose asset/balance changes, gas estimates, errors, and decoded logs to users before signing; it includes a Rabby wallet example. [^tenderly-preview]
- Security APIs
  - Blowfish emphasizes warnings and human-readable results, useful for a pre-sign decision UI. [^blowfish-api-client]
- Lightweight client-side signals
  - Pocket Universe focuses on asset-change extraction and can be used as a secondary signal. [^pocket-universe]

### 4. Limitations and accuracy caveats
- State drift
  - Alchemy notes in its userOperation simulation that results depend on state at simulation time; if state changes before execution, outcomes can differ. This same risk applies to transaction simulations. [^alchemy-userop-warning]
- Private mempool visibility
  - Flashbots Protect transactions are not observable in the public mempool; private flow can change state without appearing in public mempool data, reducing simulation accuracy for pending state assumptions. [^flashbots-status]
- Rate limits and cost
  - Tenderly rate limits and quotas depend on plan; each simulation API call costs 400 TUs. [^tenderly-faq] [^tenderly-pricing]
  - Alchemy bundles have a 3-transaction limit and CU costs; plan limits apply. [^alchemy-bundle]
  - Blowfish pricing starts at paid tiers for production usage. [^blowfish-pricing]
- ABI inference reliability
  - Whatsabi documents limitations in argument guessing and event parsing; unknown selectors remain a best-effort decode. [^whatsabi]

## Technical approach recommendation

### Recommended pipeline (pre-sign)
1. Normalize transaction input (chain, to, data, value, from).
2. Attempt ABI lookup (verified ABI, local cache, known protocol ABIs).
3. If ABI missing:
   - Query signature DBs (4byte, 4bytes list, sig.eth) and attempt candidate decode.
   - If still unknown, fall back to bytecode ABI inference (Whatsabi) with low confidence.
4. Decode calldata and recursively decode multicalls (bytes[] or Call[] patterns).
5. Run simulation:
   - Primary: Tenderly simulateTransaction for rich deltas and traces.
   - Secondary: Alchemy simulateAssetChanges for fast asset deltas.
   - Optional: Blowfish for risk scoring and warnings.
   - Fallback: local fork (Hardhat/Anvil) for custom chains or offline use.
6. Generate risk signals:
   - Unlimited approvals, approvals to new/suspicious destination, permit usage, large asset outflows.
7. Present results with confidence score and explicit uncertainty when ABI or simulation is partial.

## Library and API comparison table

| Tool/Provider | Category | What it gives | Requirements | Notes / tradeoffs |
| --- | --- | --- | --- | --- |
| 4byte.directory | Signature DB | Selector -> text signature | None | API is user-submitted; collisions possible. [^4byte-docs] [^4bytes-repo] |
| ethereum-lists/4bytes | Signature list | Selector -> text signature | None | Collisions documented (semicolon-separated). [^4bytes-repo] |
| sig.eth (samczsun) | Signature DB | Selector search | None | Community database referenced by ecosystem tools. [^sigeth-blockscout] |
| viem decodeFunctionData | Calldata decode | Function + args from ABI | ABI required | Fast, typed, composable. [^viem-decodeFunctionData] |
| ethers Interface | Calldata decode | Encode/decode from ABI | ABI required | EVM does not understand ABI. [^ethers-interface] |
| Whatsabi | ABI inference | ABI from bytecode + proxy resolution | Bytecode access | Known caveats on arg inference. [^whatsabi] |
| Tenderly simulateTransaction | Simulation | Logs, traces, asset/balance/state changes | API key / RPC | Rich output; plan-based limits and TUs. [^tenderly-sim-rpc] [^tenderly-faq] |
| Alchemy simulateAssetChanges | Simulation | Asset changes + gasUsed | API key | Focused on asset deltas. [^alchemy-asset-changes] |
| Alchemy simulateExecution | Simulation | Decoded traces/logs + revertReason | API key | Use alongside asset changes. [^alchemy-sim-exec] |
| Blowfish API | Security / simulation | Warnings + human-readable results | API key | Security-focused output. [^blowfish-api-client] |
| Pocket Universe JS | Client library | Asset changes from events | SDK usage | Event-driven, supports ERC20/721/1155. [^pocket-universe] |
| Hardhat fork | Local simulation | Full EVM execution | RPC archive node | Best control; infra overhead. [^hardhat-config] [^hardhat-forking] |
| Anvil fork | Local simulation | Fast local node + fork | RPC endpoint | Good for dev/ops; fork URL supports block pin. [^anvil-overview] [^anvil-cmd] |

## Implementation complexity estimate (rough)
- Tier 1 (1-2 weeks): selector lookup + basic ERC-20 decode + manual ABI cache + simple risk rules.
- Tier 2 (3-4 weeks): multicall recursion, ABI inference fallback, Tenderly or Alchemy integration, normalization layer.
- Tier 3 (4-6 weeks): multi-provider comparison, caching, scoring, and robust UI explanations + telemetry.

## Suggested milestones
1. Milestone A: Signature lookup + ABI decode
   - Add selector lookup via 4byte + 4bytes list.
   - Decode ERC-20 approve/transfer/transferFrom and EIP-2612 permit.
2. Milestone B: Multicall support
   - Implement recursive decode for bytes[] and Call[] patterns.
3. Milestone C: Simulation integration
   - Tenderly simulateTransaction or Alchemy simulateAssetChanges + simulateExecution.
   - Normalize asset changes into "in/out" summary.
4. Milestone D: Risk engine
   - Unlimited approvals, large outflows, unknown selectors, suspicious destinations.
   - Confidence score and UI copy templates.
5. Milestone E: Fallbacks and reliability
   - Local fork runner (Hardhat/Anvil).
   - Caching, retries, and provider failover.

## References
[^abi-spec]: https://docs.solidity.org/en/latest/abi-spec.html
[^4byte-docs]: https://www.4byte.directory/docs/
[^4bytes-repo]: https://github.com/ethereum-lists/4bytes
[^sigeth-blockscout]: https://github.com/blockscout/blockscout-rs/issues/133
[^etherface]: https://github.com/volsa/etherface
[^openchain]: https://4byte.sourcify.dev/tools/abi/index.html
[^viem-decodeFunctionData]: https://viem.sh/docs/contract/decodeFunctionData
[^viem-decodeAbiParameters]: https://viem.sh/docs/abi/decodeAbiParameters
[^ethers-interface]: https://docs.ethers.org/v5/api/utils/abi/interface/
[^whatsabi]: https://github.com/shazow/whatsabi
[^uniswap-multicall]: https://docs.uniswap.org/contracts/v3/reference/periphery/base/Multicall
[^multicall3]: https://docs.iota.org/developer/iota-evm/tools/multicall
[^eip20]: https://eips.ethereum.org/EIPS/eip-20
[^eip2612]: https://eips.ethereum.org/EIPS/eip-2612
[^openzeppelin-erc20]: https://docs.openzeppelin.com/contracts/4.x/api/token/erc20
[^metamask-signature-phishing]: https://support.metamask.io/stay-safe/protect-yourself/wallet-and-hardware/signature-phishing
[^tenderly-sim-rpc]: https://docs.tenderly.co/node/rpc-reference/immutable/tenderly_simulateTransaction
[^tenderly-faq]: https://docs.tenderly.co/faq/simulations
[^tenderly-preview]: https://docs.tenderly.co/simulations/transaction-preview
[^tenderly-pricing]: https://docs.tenderly.co/node/pricing
[^alchemy-asset-changes]: https://www.alchemy.com/docs/reference/simulation-asset-changes
[^alchemy-sim-asset-sdk]: https://www.alchemy.com/docs/reference/simulateassetchanges-sdk
[^alchemy-sim-exec]: https://www.alchemy.com/docs/data/simulation-apis/transaction-simulation-endpoints/alchemy-simulate-execution
[^alchemy-bundle]: https://www.alchemy.com/docs/reference/simulation-bundle
[^alchemy-userop-warning]: https://www.alchemy.com/docs/node/bundler-api/useroperation-simulation-endpoints/alchemy-simulate-user-operation-asset-changes
[^alchemy-changelog]: https://www.alchemy.com/docs/changelog
[^hardhat-config]: https://hardhat.org/docs/reference/configuration
[^hardhat-forking]: https://hardhat.org/guides/mainnet-forking
[^anvil-overview]: https://getfoundry.sh/anvil/overview
[^anvil-cmd]: https://foundry-rs.github.io/foundry/anvil/cmd/index.html
[^blowfish-api-client]: https://socket.dev/npm/package/@blowfishxyz/api-client
[^blowfish-pricing]: https://blowfish.xyz/pricing
[^pocket-universe]: https://jqphu.github.io/pocket-js/
[^blowfish-blocklist]: https://github.com/blowfishxyz/blocklist
[^flashbots-status]: https://docs.flashbots.net/flashbots-protect/additional-documentation/status-api
