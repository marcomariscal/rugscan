# Pre-sign transaction security scanner UX patterns

Research date: 2026-02-02
Scope: wallet pre-sign UX, security tools, CLI input patterns, and integration models for Assay (formerly Rugscan).

## Executive takeaways
- Wallets rarely expose a full JSON export of unsigned transactions; the most common advanced view is raw hex (often hidden behind an advanced toggle). Copy/export is usually manual select/copy, not a dedicated button.
- The best pre-sign security UX today is either wallet-native (API integrated) or a browser extension that intercepts requests and shows a simulation summary before the wallet prompt.
- Extensions minimize integration effort but miss mobile and introduce user install friction; wallet plugins provide the cleanest UX but require wallet partnership and review.
- RPC proxy models cover desktop and mobile but lose dapp context (domain, UI intent) and require high-friction RPC configuration.
- For CLI ergonomics, accept multiple input formats and map them to a canonical internal JSON; provide a copy-paste path from wallets (raw hex, calldata + to + value) and from dev tools (JSON-RPC payloads, ABI + args).

## 1) Wallet copy/export UX (pre-sign)

Notes:
- Most wallets prioritize human-readable summaries (token in/out, approvals, gas). Raw data is usually hidden.
- Copy/export is inconsistent. In many cases users must manually copy from a raw data panel or use a block explorer after broadcast.

| Wallet | Pre-sign detail visibility | Copy/export capability | Format exposed | Evidence |
| --- | --- | --- | --- | --- |
| MetaMask | Raw hex data is hidden by default and can be shown by enabling "Show Hex Data" in Advanced settings (extension). | No official pre-sign export flow documented; users can copy tx hash after broadcast. | Hex data field (calldata) when enabled; human-readable otherwise. | MetaMask support doc on enabling hex data; tx hash copy after send. |
| Rabby | Pre-transaction simulation and security scan are core features; transaction preview includes data views (Data/ABI/Hex in UI per community reports). | No official export flow documented. | Data/ABI/Hex tabs reported (decoded ABI + raw hex implied). | Rabby product site; community report referencing Data/ABI/Hex tabs. |
| Frame | Transaction request UI includes a "Raw Transaction" view when clicking "Calling Contract"; address copy via click; tx hash copy available after broadcast. | Copy address via click; tx hash via "View Details" after broadcast. | Raw transaction data shown in a dedicated view (format not specified in docs). | Frame docs (Swapping ETH guide). |
| Rainbow | Review screens focus on human-readable swap/bridge details (network, min received, fees, slippage, gas) with editable gas. | No raw data export mentioned in support docs. | Human-readable summary fields. | Rainbow support docs for swap/bridge review screens. |
| Coinbase Wallet / Base app | Official docs emphasize network fee customization (max fee, priority fee, gas limit). | No raw data export mentioned in official docs. | Human-readable summary + gas fee customization. | Coinbase Help docs for adjusting network fees. |

Implications for Assay:
- Do not rely on wallets to give you a ready JSON export. Offer multiple input paths: raw hex, calldata + to/value, or JSON-RPC payload.
- Provide a one-click "copy for Assay" in your own UI if you build a wallet plugin/extension.

## 2) Existing pre-sign security tools

| Tool | Integration model | How it works (user flow) | UX pattern highlights | Evidence |
| --- | --- | --- | --- | --- |
| Blowfish | Wallet-native API integration + optional UI components; also offered a browser extension in the past. | Wallet sends unsigned tx/message to Blowfish API -> returns human-readable simulation results + warnings; wallet renders summary and warnings inline before signing. | Strong pattern: risk scoring + human-readable state changes + warnings. Supports domain scanning and message scanning. | Blowfish API client docs on scanTransactions; Blowfish blog on wallet integration; Blowfish UI package. |
| Pocket Universe | Browser extension. | Extension pops up before wallet to show what assets move + warnings; no wallet connection required. | Pre-wallet interstitial with clear warnings; covers common scams; easy install. | Chrome Web Store listing; Firefox add-on listing. |
| Wallet Guard | Browser extension + MetaMask Snap. | Extension injects web3 API, simulates/inspects requests, then passes to wallet; no wallet access. | Intermediary layer with phishing detection + transaction simulation; open-source extension; warns before signing. | Wallet Guard site + GitHub repo; MetaMask Snap page. |
| Fire | Browser extension (community-documented). | Intercepts signature requests, runs simulation, shows what will enter/exit before wallet prompt; works with existing wallet. | Similar to Pocket Universe: pre-wallet popover with simulation outcome. | Sandbox Game docs list Fire as an extension that intercepts signature requests; Product Hunt description. |

Notes:
- Wallet Guard extension has a sunset notice in the Chrome Web Store listing, which suggests relying on it as a long-term extension may be risky.
- Fire has less official documentation in public sources; treat its claims as community/third-party reported.

## 3) CLI input patterns (and how other tools do it)

### Patterns in the ecosystem
- `cast send` (Foundry) accepts raw hex data via `--data`, or ABI signature + args, with flags for `--rpc-url`, `--chain`, `--value`, gas options, etc. This is a clear multi-input model that favors flags and optional raw hex overrides.
- `slither` is path-based (analyze a project or file) rather than transaction-input driven. Its CLI shows a "single command with options" pattern for security tooling, not JSON payloads.

### Recommended CLI inputs for Assay
Support multiple formats and normalize internally to a single canonical schema:

1) JSON (stdin or file)
- Accept an `eth_sendTransaction`-shaped object with common fields: `from`, `to`, `value`, `data`, `chainId`, `gas`, `maxFeePerGas`, `maxPriorityFeePerGas`, `nonce`, `type`, `accessList`.
- Allow either hex strings or decimal strings; normalize to hex internally.
- Accept a JSON-RPC request blob and extract `params[0]`.

2) Flags
- Provide `--to`, `--value`, `--data`, `--chain-id`, `--from` plus gas flags.
- Mirror `cast send` naming where possible for familiarity (`--rpc-url`, `--gas`, `--gas-price`, `--priority-gas-price`).

3) Raw hex
- Accept a raw signed tx (`0x...`) or unsigned calldata-only hex, with `--to` + `--value`.

4) ABI + args
- Optional: accept `--abi` + `--sig` + args, encode calldata internally.

### Ergonomics for wallet users
- If a wallet exposes only raw hex calldata, allow: `rugscan --to 0x... --value 0 --data 0x... --chain-id 1`.
- If a wallet exposes decoded ABI, allow: `rugscan --to 0x... --sig "approve(address,uint256)" 0xSpender 0xffff...`.
- If a dapp can provide the JSON-RPC request, allow `rugscan --json` via stdin: `cat tx.json | rugscan --json`.

## 4) Browser extension vs RPC proxy vs wallet plugin

### Browser extension (request interceptor)
Pros:
- Works with most browser wallets without partnerships.
- Can show results before wallet prompt (best moment to stop a bad sign).
- Can include domain phishing detection.

Cons:
- Requires user install; adds extension attack surface.
- Limited on mobile.
- Inter-extension comms are restricted; data capture is brittle across wallet updates.

Implementation requirements:
- Content script + injection layer to intercept `window.ethereum` and/or `wallet_requestPermissions`.
- Simulation backend + fast UI popover.
- Domain reputation scanning and caching.

### RPC proxy (custom RPC endpoint)
Pros:
- Works across desktop and mobile wallets that support custom RPCs.
- No browser extension required.
- Centralized policy control (blocklist, rate limits, logging).

Cons:
- High user friction to change RPC; not all wallets allow it for every chain.
- Limited context (no domain/intent); only raw tx data.
- Privacy and latency concerns.

Implementation requirements:
- RPC gateway that can safely simulate and/or block txs.
- TLS, auth, and rate limiting.
- Clear fallback behavior when simulation fails.

### Wallet plugin (Snap / native integration)
Pros:
- Best UX (inline within wallet confirm screen).
- Minimal friction for users once installed.
- Access to wallet context (chain, account, signing method).

Cons:
- Requires wallet partnership, review, or limited to a single wallet ecosystem.
- Distribution gated by wallet store policies.

Implementation requirements:
- Wallet-specific SDK (e.g., MetaMask Snaps).
- UI components that match wallet design system.
- Secure key handling (never touch keys) and strict perf budgets.

## 5) Recommended UX flow (personas)

### Persona: Developer
Goal: maximum transparency and copyability.
Flow:
1) Provide raw tx details (to, data, value, chainId, gas) + decoded ABI.
2) Offer "Copy for CLI" button (JSON + flags) and "Copy raw calldata".
3) Show simulation diff of state changes and warnings with precise call graph.
4) Allow advanced toggles: show access list, type, nonce, blob data.

### Persona: Trader / DeFi power user
Goal: fast risk signal with minimal friction.
Flow:
1) Show "asset in/out" summary + approvals + risk score.
2) Highlight red flags (new spender, unlimited approvals, suspicious domains).
3) One-click expand for calldata and contract details.
4) If risky, show recommended safe action (reduce allowance, cancel).

### Persona: Normie
Goal: avoid scams without overload.
Flow:
1) Simple verdict: Safe / Risky / Unknown.
2) 2-3 plain-English reasons (e.g., "This approves unlimited spending").
3) CTA: "Back" or "Proceed anyway" with friction (hold-to-sign).
4) Optional learn-more panel for details, hidden by default.

### Minimize friction while maximizing coverage
- Run simulation in <1s where possible; show loading skeleton with timeout and fallbacks.
- Treat "unknown" as high-risk but do not hard-block unless severe risk.
- Cache contract metadata and ABI to reduce delays.
- Always show raw to/data/value for expert audit.

## 6) Suggested canonical input schema (internal)

Use a single normalized object regardless of input format:

- chainId (number)
- from (address)
- to (address or null for create)
- value (hex string)
- data (hex string)
- type (0, 1, 2, 3, 4) if present
- gas (hex string)
- maxFeePerGas / maxPriorityFeePerGas (hex strings)
- nonce (hex string)
- accessList (EIP-2930)
- blob fields if present
- origin (domain if known)

This schema allows easy mapping from JSON-RPC, wallet UI, or CLI flags.

## 7) Gaps / open questions
- Rabby, Rainbow, and Coinbase Wallet do not document a dedicated "copy unsigned tx" export; verify by manual UX test.
- Fire lacks strong official documentation; verify extension source and supported chains before formal partnership.
- Wallet Guard extension sunset notice suggests reassessing long-term dependency.

## Sources
- https://support.metamask.io/transactions-and-gas/how-to-display-transaction-hex-data-in-metamask/
- https://support.metamask.io/transactions-and-gas/how-to-get-a-transaction-hash-id/
- https://rabby.io/
- https://www.reddit.com/r/ethdev/comments/13mtqaf/rabby_wallet_that_doesnt_increase_the_gas_fee/jkwz7wp/
- https://support.frame.sh/en/articles/10111839-swapping-eth
- https://support.rainbow.me/en/articles/6613531-bridge-and-swap-tokens
- https://help.coinbase.com/en/wallet/other-topics/adjusting-network-fees-in-legacy-base-app
- https://www.npmjs.com/package/@blowfishxyz/api-client
- https://www.npmjs.com/package/@blowfishxyz/ui
- https://blowfish.xyz/blog/timeless-wallet-secured-by-blowfish
- https://chromewebstore.google.com/detail/pocket-universe/ppflmfafgaakknncdnddhojdnkpppblf
- https://addons.mozilla.org/en-US/firefox/addon/pocket-universe/
- https://walletguard.app/
- https://github.com/wallet-guard/wallet-guard-extension
- https://snaps.metamask.io/snap/npm/wallet-guard/
- https://chromewebstore.google.com/detail/wallet-guard-extension/ihjajgokompncjllhaaoobobloocnfaa
- https://docs.sandbox.game/en/assets/security-tool/
- https://www.producthunt.com/products/fire-9
- https://getfoundry.sh/cast/reference/cast-send
- https://github.com/crytic/slither
