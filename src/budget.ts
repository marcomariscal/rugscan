export interface TimeBudget {
	totalMs: number;
	startedAtMs: number;
	remainingMs: () => number;
}

export function createTimeBudget(totalMs: number, now: () => number = Date.now): TimeBudget {
	const startedAtMs = now();
	return {
		totalMs,
		startedAtMs,
		remainingMs: () => {
			const elapsed = now() - startedAtMs;
			return Math.max(0, totalMs - elapsed);
		},
	};
}

export type TimeoutOutcome<T> =
	| { ok: true; value: T; elapsedMs: number }
	| { ok: false; reason: "timeout" | "aborted" | "error"; elapsedMs: number; error?: unknown };

export async function runWithTimeout<T>(
	options: {
		timeoutMs: number;
		parentSignal?: AbortSignal;
		now?: () => number;
	},
	fn: (signal: AbortSignal) => Promise<T>,
): Promise<TimeoutOutcome<T>> {
	const now = options.now ?? Date.now;
	const startedAtMs = now();

	if (options.timeoutMs <= 0) {
		return { ok: false, reason: "timeout", elapsedMs: 0 };
	}

	const controller = new AbortController();
	const parent = options.parentSignal;
	if (parent?.aborted) {
		controller.abort();
		return { ok: false, reason: "aborted", elapsedMs: 0 };
	}

	if (parent) {
		parent.addEventListener(
			"abort",
			() => {
				controller.abort();
			},
			{ once: true },
		);
	}

	let didTimeout = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const timeoutPromise = new Promise<TimeoutOutcome<T>>((resolve) => {
		timeoutId = setTimeout(() => {
			didTimeout = true;
			controller.abort();
			resolve({ ok: false, reason: "timeout", elapsedMs: now() - startedAtMs });
		}, options.timeoutMs);
	});

	const taskPromise: Promise<TimeoutOutcome<T>> = fn(controller.signal)
		.then((value) => ({ ok: true, value, elapsedMs: now() - startedAtMs }))
		.catch((error: unknown) => {
			const reason = didTimeout ? "timeout" : controller.signal.aborted ? "aborted" : "error";
			return { ok: false, reason, error, elapsedMs: now() - startedAtMs };
		});

	const outcome = await Promise.race([taskPromise, timeoutPromise]);
	if (timeoutId) clearTimeout(timeoutId);
	return outcome;
}
