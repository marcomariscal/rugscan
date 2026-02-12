# Assay UX/Safety Score — PR #99 (Post-Merge)

**Date:** 2026-02-11
**Scorer:** Jarvis (TTY pty:true, ANSI color-on, real CLI renders)
**Baseline:** 9.5/10 (prior passes 1–11)

## Final Score: 7.5 / 10

**Delta: −2.0** from 9.5 baseline.

Drop reflects expanded fixture coverage (9 real-world txs + Safe flow) exposing
gaps in amount formatting, plain ETH transfers, and nested-call unpacking that
were invisible in the narrower prior fixture set.

---

## Fixtures Evaluated

| # | Fixture | Protocol ID | Action Quality | Key Issue |
|---|---------|-------------|---------------|-----------|
| 1 | uniswap-v4-universalrouter-eth-swap-873d55dd | ✅ Uniswap | ✅ "V4_SWAP" | — |
| 2 | aave-v3-gateway-deposit-1eth | ✅ Aave V3 | ✅ "Supply ETH to Aave" | — |
| 3 | aave-v3-gateway-borrow | ✅ Aave V3 | ✅ "Borrow ETH from Aave" | Raw wei amount |
| 4 | erc20-approve-usdc-limited | ✅ Circle USDC | ✅ "Approve … to spend" | 500606000 not 500.61 |
| 5 | erc20-transfer-usdc-real | ✅ Circle USDC | ✅ "Transfer … to" | 45980053 not 45.98 |
| 6 | eth-transfer-mainnet-real | ❌ Unknown | ❌ "Unknown action" | No amount, "missing calldata" noise |
| 7 | uniswap-v3-swaprouter-multicall | ✅ Uniswap V3 | ⚠️ "multicall(bytes[])" | Sub-calls invisible |
| 8 | 1inch-v4-uniswapv3swap | ❌ Unknown | ⚠️ raw fn name | 1inch not recognized |
| 9 | gnosis-safe-exec-usdt-approve | ❌ Unknown | ⚠️ raw execTransaction | Inner approve opaque |

**Safe CLI (offline):** Clean summary box, but call targets not resolved to names.

---

## Top 3 Blockers

1. **Raw token amounts** — ERC20 amounts display as raw integers (`500606000`
   not `500.61 USDC`; `115000000000000000` not `0.115 ETH`). Affects 4 of 9
   fixtures. Users cannot interpret values without mental math + knowing decimals.

2. **ETH transfer = "Unknown action"** — Plain ETH send (data=`0x`, value>0)
   renders `Protocol: Unknown / Action: Unknown action`, shows `"missing
   calldata (data)"` noise, and never displays the 0.467 ETH being sent.
   Most common tx type on Ethereum.

3. **Multicall & Safe inner calls opaque** — V3 multicall shows only
   `multicall(bytes[])` (sub-calls invisible). Safe execTransaction shows raw
   positional args; inner USDT→Permit2 approve completely hidden. 1inch not
   recognized as a protocol at all.

---

## Exact Next 3 Code Changes

### Change 1: Decimal-aware token amount formatting
**Where:** `src/intent/templates.ts` (`formatValue`) + `src/cli/ui.ts` (Action line)
**What:** When an ERC20 approve/transfer amount is available alongside a known
token address, look up decimals (6 for USDC/USDT, 18 for WETH, etc.) and format
human-readable: `500.61 USDC` not `500606000`. For native ETH `value` fields,
convert wei→ETH with ≤4 decimal places. Add a small decimals lookup table for
top tokens; fall back to raw for unknowns.

### Change 2: Detect and surface plain ETH transfers
**Where:** `src/cli/ui.ts` (renderResultBox header) + `src/intent/templates.ts`
**What:** When `data` is `0x` (or empty) and `value > 0`:
- Set Action → `"Send {formatted} ETH to {to}"`
- Set Protocol → `"ETH Transfer"` (not "Unknown")
- Suppress `"missing calldata (data)"` hint in balance section
- Suppress `UNVERIFIED`-style contract warnings (target is EOA, not contract)

### Change 3: Unpack multicall / Safe execTransaction inner calls
**Where:** `src/analyzers/calldata/decoder.ts` + `src/intent/templates.ts`
**What:** For known multicall selectors (`0xac9650d8`, `0x5ae401dc`), ABI-decode
the inner `bytes[]` array and display sub-call summary:
`"multicall: exactInputSingle + unwrapWETH9"`. For Safe `execTransaction`
(`0x6a761202`), extract inner `to` + `data` fields and decode the nested call:
`"Safe exec → USDT approve(Permit2, 3.6B)"`. Keep raw fallback for unknown inners.

---

## What's Working Well
- Box layout: consistent sections (Chain/Protocol/Action/Checks/Balance/Approvals/Verdict)
- Color coding: green ✓, yellow ⚠️, red 🚨 — effective hierarchy
- Protocol recognition: strong for Uniswap V4, Aave V3, Circle USDC
- Proxy detection: excellent (FiatTokenProxy → FiatToken V2.2)
- BLOCK (UNVERIFIED) semantics: correct — never rubber-stamps without simulation
- Explorer links: comprehensive with labeled references
- Progress spinner: real-time provider feedback
- Approval-only balance message: "No balance changes expected (approval only)" — excellent
- Safety messaging: recovery guidance always present ("rerun using simulation-capable RPC")

---

## Scoring Method
All renders via `exec pty:true` (TTY + ANSI color-on) against real CLI:
`bun run src/cli/index.ts scan --calldata @<fixture> --no-sim`
No `NO_COLOR`. No snapshot files. User-visible output only.
