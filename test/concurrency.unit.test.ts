import { describe, expect, test } from "bun:test";
import { runBounded } from "../src/concurrency";

describe("runBounded", () => {
	test("executes all tasks and respects bounded concurrency", async () => {
		const order: number[] = [];
		let activeConcurrency = 0;
		let peakConcurrency = 0;

		const tasks = Array.from({ length: 6 }, (_, i) => async () => {
			activeConcurrency++;
			peakConcurrency = Math.max(peakConcurrency, activeConcurrency);
			// Stagger: earlier tasks take longer to flush out ordering issues.
			await new Promise((r) => setTimeout(r, (6 - i) * 10));
			order.push(i);
			activeConcurrency--;
		});

		await runBounded(tasks, 3);

		// All tasks ran
		expect(order).toHaveLength(6);
		expect(new Set(order).size).toBe(6);
		// Concurrency was bounded
		expect(peakConcurrency).toBeLessThanOrEqual(3);
		expect(peakConcurrency).toBeGreaterThanOrEqual(2); // actually used concurrency
	});

	test("handles zero tasks gracefully", async () => {
		await runBounded([], 3);
		// No assertion needed — just must not throw
	});

	test("handles concurrency > task count", async () => {
		const results: number[] = [];
		const tasks = [async () => results.push(1), async () => results.push(2)];

		await runBounded(tasks, 10);
		expect(results).toHaveLength(2);
	});

	test("propagates task errors", async () => {
		const tasks = [
			async () => {},
			async () => {
				throw new Error("boom");
			},
			async () => {},
		];
		await expect(runBounded(tasks, 2)).rejects.toThrow("boom");
	});
});
