export interface OfflineHttpGuardOptions {
	/**
	 * Explicitly allowed JSON-RPC HTTP(s) endpoints.
	 *
	 * Offline mode is strict: any HTTP(s) fetch that does not target one of these
	 * URLs will throw.
	 */
	allowedRpcUrls: string[];
	/**
	 * Allow fetches to localhost / 127.0.0.1 / ::1 (ex: local Anvil fork).
	 *
	 * Defaults to true because these requests never leave the machine.
	 */
	allowLocalhost?: boolean;
}

export function installOfflineHttpGuard(options: OfflineHttpGuardOptions): () => void {
	const originalFetch = globalThis.fetch;
	const allowLocalhost = options.allowLocalhost ?? true;
	const allowed = options.allowedRpcUrls.map(normalizeHttpUrl);

	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = extractUrlString(input);
		if (url && isHttpUrl(url)) {
			const normalized = normalizeHttpUrl(url);
			if (allowLocalhost && isLocalhostUrl(normalized)) {
				return await originalFetch(input, init);
			}
			if (!allowed.some((candidate) => candidate === normalized)) {
				throw new Error(`offline mode: blocked HTTP request to ${url}`);
			}
		}
		return await originalFetch(input, init);
	};

	return () => {
		globalThis.fetch = originalFetch;
	};
}

function extractUrlString(input: RequestInfo | URL): string | null {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	if (input instanceof Request) return input.url;
	return null;
}

function isHttpUrl(url: string): boolean {
	return url.startsWith("http://") || url.startsWith("https://");
}

function normalizeHttpUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const normalizedPath = parsed.pathname === "/" ? "" : parsed.pathname;
		const normalized = `${parsed.protocol}//${parsed.host}${normalizedPath}${parsed.search}`;
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return url.endsWith("/") ? url.slice(0, -1) : url;
	}
}

function isLocalhostUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname === "127.0.0.1" ||
			parsed.hostname === "localhost" ||
			parsed.hostname === "::1"
		);
	} catch {
		return false;
	}
}
