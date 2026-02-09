# Assay (formerly Rugscan) Code Review

Scope: `src/types.ts`, `src/chains.ts`, `src/analyzer.ts`, `src/providers/*.ts`, `src/cli/index.ts`

Focus: code quality, type safety, error handling, edge cases, API design, and security.

## P0 (Critical)

- Inaccurate safety signals due to “unknown == false” in token security parsing. `src/providers/goplus.ts` converts missing fields to `false` (`toBool(undefined) -> false`), which can suppress danger findings and present “safe” for unknown values. This is a critical risk for a security tool because “unknown” is not safe. Prefer `boolean | undefined` and treat `undefined` as “unknown,” or add explicit “unknown” findings. `src/providers/goplus.ts`

## P1 (High)

- Type safety violations (`as` casts) bypass runtime address validation and can crash or mis-classify. `src/providers/proxy.ts` and `src/cli/index.ts` use `as Address` / `as Chain`. This defeats viem’s type safety and can lead to runtime exceptions or querying invalid addresses, especially since CLI only checks `startsWith("0x")`. Replace with runtime validators (`isAddress`, `isHex`, chain parsing with a guard) and pass validated values forward. `src/providers/proxy.ts`, `src/cli/index.ts`

- Etherscan tx count logic can materially undercount and create false “LOW_ACTIVITY” findings. `src/providers/etherscan.ts` caps results at 10,000 (`offset=10000`) and then uses `result.length` as total. High-activity contracts can be mis-labeled low activity, influencing findings and recommendation. Prefer `txlist` paging with a total count, or use `txlist` + `gettxreceiptstatus` or an alternative endpoint that returns total count. `src/providers/etherscan.ts`

- Beacon proxy handling mislabels `implementation`. For beacon proxies, the stored address is a beacon contract, not the implementation. `detectProxy` sets `implementation` to the beacon address, and the CLI prints it as implementation. That can mislead a user into reviewing the wrong code. Consider returning `beacon` separately and, if possible, resolving the actual implementation from the beacon. `src/providers/proxy.ts`, `src/cli/index.ts`

- Remote API errors are mostly swallowed, reducing transparency and confidence. Providers catch and return `null` with no reason, but the analysis still reports a “high/medium” confidence level without “provider error” context. This hides outages/rate limits and can lead to unsafe conclusions. Bubble up a “provider_error” reason or include per-provider status. `src/providers/*.ts`, `src/analyzer.ts`

## P2 (Medium)

- Address normalization can reduce accuracy for some services and poor input validation in CLI. CLI accepts any `0x` prefix, then normalizes to lowercase. Some APIs accept lowercase, but checksum validation is a best practice for security tools to prevent user mistakes. Add `isAddress` checks and optionally enforce checksum (or warn if not). `src/cli/index.ts`, `src/analyzer.ts`

- No timeouts or retry/backoff policies on network calls. A hung fetch can stall the CLI indefinitely; transient rate limits aren’t retried. Consider timeouts via `AbortController` and basic retry/backoff for rate-limited APIs. `src/providers/*.ts`

- Source code data handling is inconsistent. `sourcify.checkVerification` returns full source content, but `analyze` doesn’t use or sanitize it. If you later log/store this, it can bloat output or expose untrusted data. Consider limiting or omitting `source` for CLI runs unless explicitly requested. `src/providers/sourcify.ts`, `src/analyzer.ts`

- Confidence scoring doesn’t reflect missing provider data (e.g., GoPlus or DeFiLlama failures). Confidence only drops for missing Etherscan key or unverified source. Consider adding reasons for any provider failure or missing data to avoid overstating confidence. `src/analyzer.ts`, `src/providers/*.ts`

- Chain configs are static but not validated; `getChainConfig` assumes any `Chain` is present. If `Chain` expands without updating `CHAINS`, this will throw at runtime. Consider a runtime guard or `never` check to ensure exhaustiveness. `src/chains.ts`, `src/types.ts`

