import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScanHandler } from "../src/server";
import { createAppendOnlyTelemetryWriter, createProxyTelemetry } from "../src/telemetry";

const fixturePath = "test/fixtures/scan-response.json";

async function readFixture() {
	return JSON.parse(await Bun.file(fixturePath).text());
}

describe("server", () => {
	test("rejects unauthorized requests", async () => {
		const handler = createScanHandler({ apiKey: "test" });
		const response = await handler(
			new Request("http://localhost/v1/scan", { method: "POST", body: "{}" }),
		);
		expect(response.status).toBe(401);
	});

	test("rejects missing input", async () => {
		const handler = createScanHandler({ apiKey: "test" });
		const response = await handler(
			new Request("http://localhost/v1/scan", {
				method: "POST",
				headers: { authorization: "Bearer test", "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		expect(response.status).toBe(400);
	});

	test("rejects invalid address", async () => {
		const handler = createScanHandler({ apiKey: "test" });
		const response = await handler(
			new Request("http://localhost/v1/scan", {
				method: "POST",
				headers: { authorization: "Bearer test", "content-type": "application/json" },
				body: JSON.stringify({ address: "not-an-address" }),
			}),
		);
		expect(response.status).toBe(422);
	});

	test("returns AnalyzeResponse for valid scan", async () => {
		const fixture = await readFixture();
		const handler = createScanHandler({
			apiKey: "test",
			scanFn: async () => fixture,
			config: {},
		});
		const response = await handler(
			new Request("http://localhost/v1/scan", {
				method: "POST",
				headers: { authorization: "Bearer test", "content-type": "application/json" },
				body: JSON.stringify({
					address: "0x1111111111111111111111111111111111111111",
					chain: "1",
				}),
			}),
		);
		const body = await response.json();
		expect(response.status).toBe(200);
		expect(body).toEqual(fixture);
	});

	test("emits telemetry for /v1/scan success", async () => {
		const tmpDir = mkdtempSync(path.join(os.tmpdir(), "assay-server-telemetry-"));
		const filePath = path.join(tmpDir, "events.jsonl");

		try {
			const writer = createAppendOnlyTelemetryWriter({ filePath });
			const telemetry = createProxyTelemetry({
				source: "server",
				env: { ASSAY_TELEMETRY_SALT: "test-salt" },
				writer,
			});
			const fixture = await readFixture();
			const handler = createScanHandler({
				apiKey: "test",
				scanFn: async () => fixture,
				config: {},
				telemetry,
			});

			const response = await handler(
				new Request("http://localhost/v1/scan", {
					method: "POST",
					headers: { authorization: "Bearer test", "content-type": "application/json" },
					body: JSON.stringify({
						address: "0x1111111111111111111111111111111111111111",
						chain: "1",
					}),
				}),
			);
			expect(response.status).toBe(200);

			await telemetry.flush();
			const lines = readFileSync(filePath, "utf-8").trim().split("\n");
			expect(lines.length).toBe(2);
			const started = JSON.parse(lines[0]);
			const result = JSON.parse(lines[1]);
			expect(started.event).toBe("scan_started");
			expect(started.source).toBe("server");
			expect(result.event).toBe("scan_result");
			expect(result.source).toBe("server");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
