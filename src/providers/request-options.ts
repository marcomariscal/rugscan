export interface ProviderRequestOptions {
	/**
	 * Maximum time a provider request is allowed to spend before being aborted.
	 *
	 * Note: individual providers may perform multiple HTTP calls; this value
	 * applies to each fetch unless the provider implements its own budget logic.
	 */
	timeoutMs?: number;
	signal?: AbortSignal;

	/**
	 * When false, bypasses any in-module caching.
	 * Useful for timeboxed / best-effort paths (ex: wallet proxy mode)
	 * to avoid caching transient failures.
	 */
	cache?: boolean;
}
