export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(
	input: RequestInfo | URL,
	init: RequestInit = {},
	timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const parentSignal = init.signal;

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		if (parentSignal) {
			if (parentSignal.aborted) {
				controller.abort();
			} else {
				parentSignal.addEventListener(
					"abort",
					() => {
						controller.abort();
					},
					{ once: true },
				);
			}
		}

		timeoutId = setTimeout(() => {
			controller.abort();
		}, timeoutMs);

		return await fetch(input, { ...init, signal: controller.signal });
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
