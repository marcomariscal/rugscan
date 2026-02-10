import { describe, expect, test } from "bun:test";
import { BENCHMARK_SCENARIOS, summarizeSamples } from "../scripts/bench-cli-latency";

describe("bench-cli-latency helpers", () => {
	test("summarizeSamples computes min/p50/p95/max", () => {
		const stats = summarizeSamples([10, 20, 30, 40, 50]);
		expect(stats.minMs).toBe(10);
		expect(stats.p50Ms).toBe(30);
		expect(stats.p95Ms).toBe(48);
		expect(stats.maxMs).toBe(50);
	});

	test("scenario matrix covers required latency paths", () => {
		const descriptions = BENCHMARK_SCENARIOS.map((scenario) => scenario.description);
		expect(descriptions).toContain("scan known-safe address");
		expect(descriptions).toContain("scan risky/unverified address");
		expect(descriptions).toContain("scan --no-sim with fixture calldata");
		expect(descriptions).toContain("safe offline fixture ingest success");
		expect(descriptions).toContain("safe broken fixture fast-fail");
	});
});
