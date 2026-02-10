/**
 * Run async task factories with bounded concurrency.
 * Tasks are dispatched in index order; the returned promise resolves
 * after every task has settled.
 *
 * Because JavaScript is single-threaded, the `nextIndex++` read-increment
 * is atomic between `await` suspension points — no lock needed.
 */
export async function runBounded(
	tasks: ReadonlyArray<() => Promise<void>>,
	concurrency: number,
): Promise<void> {
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < tasks.length) {
			const index = nextIndex++;
			await tasks[index]();
		}
	}

	const workerCount = Math.min(concurrency, tasks.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
