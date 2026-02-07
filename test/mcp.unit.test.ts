import { describe, expect, test } from "bun:test";

function encodeMessage(payload: unknown): Uint8Array {
	const body = JSON.stringify(payload);
	const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
	return new Uint8Array(Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(body, "utf8")]));
}

async function readMessage(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
	let buffer = Buffer.alloc(0);

	while (true) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd !== -1) {
			const headerRaw = buffer.slice(0, headerEnd).toString("utf8");
			const match = headerRaw.match(/Content-Length:\s*(\d+)/i);
			const length = match ? Number.parseInt(match[1] ?? "", 10) : NaN;
			if (Number.isFinite(length)) {
				const start = headerEnd + 4;
				const end = start + length;
				if (buffer.length >= end) {
					const body = buffer.slice(start, end).toString("utf8");
					const remaining = buffer.slice(end);
					buffer = remaining;
					return JSON.parse(body);
				}
			}
		}

		const next = await reader.read();
		if (next.done) {
			throw new Error("EOF while waiting for MCP message");
		}
		buffer = Buffer.concat([buffer, Buffer.from(next.value)]);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function findAnalyzeResponseInToolResult(result: unknown): { schemaVersion: number } | null {
	if (!isRecord(result)) return null;
	const content = result.content;
	if (!Array.isArray(content)) return null;

	for (const item of content) {
		if (!isRecord(item)) continue;
		const text = item.text;
		if (typeof text !== "string") continue;
		const trimmed = text.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (!isRecord(parsed)) continue;
			const schemaVersion = parsed.schemaVersion;
			if (schemaVersion === 1) return { schemaVersion: 1 };
		} catch {
			// ignore
		}
	}

	return null;
}

describe("mcp server (unit)", () => {
	test("responds to tools/list and analyzeTransaction", async () => {
		const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", "mcp"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				RUGSCAN_MCP_STUB_DEPS: "1",
				RUGSCAN_CONFIG: "test/fixtures/empty-config.json",
			},
		});

		const reader = proc.stdout.getReader();
		const stdin = proc.stdin;
		if (!stdin) {
			proc.kill();
			throw new Error("Failed to open stdin pipe");
		}

		type NodeLikeStdin = {
			write: (chunk: Uint8Array) => unknown;
			end?: () => unknown;
		};

		type WebLikeStdin = {
			getWriter: () => WritableStreamDefaultWriter<Uint8Array>;
		};

		const hasWrite = (value: unknown): value is NodeLikeStdin => {
			return isRecord(value) && typeof value.write === "function";
		};

		const hasGetWriter = (value: unknown): value is WebLikeStdin => {
			return isRecord(value) && typeof value.getWriter === "function";
		};

		let webWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

		const writeStdin = async (data: Uint8Array) => {
			if (hasWrite(stdin)) {
				stdin.write(data);
				await Bun.sleep(0);
				return;
			}

			if (hasGetWriter(stdin)) {
				if (!webWriter) webWriter = stdin.getWriter();
				await webWriter.write(data);
				return;
			}

			throw new Error("Unsupported stdin pipe type");
		};

		try {
			await writeStdin(
				encodeMessage({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2024-11-05",
						clientInfo: { name: "rugscan-test", version: "0" },
						capabilities: {},
					},
				}),
			);
			const init = await readMessage(reader);
			expect(init).toHaveProperty("result");

			await writeStdin(
				encodeMessage({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/list",
					params: {},
				}),
			);
			const list = await readMessage(reader);
			expect(JSON.stringify(list)).toContain("rugscan.analyzeTransaction");

			await writeStdin(
				encodeMessage({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: {
						name: "rugscan.analyzeTransaction",
						arguments: {
							chain: "ethereum",
							to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
							from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
							data: "0x",
							value: "0",
							noSim: true,
							walletMode: true,
						},
					},
				}),
			);
			const call = await readMessage(reader);

			const result = isRecord(call) ? call.result : undefined;
			const found = findAnalyzeResponseInToolResult(result);
			expect(found?.schemaVersion).toBe(1);
		} finally {
			if (webWriter) {
				try {
					await webWriter.close();
				} catch {
					// ignore
				} finally {
					webWriter.releaseLock();
				}
			} else if (hasWrite(stdin) && typeof stdin.end === "function") {
				try {
					stdin.end();
				} catch {
					// ignore
				}
			}

			proc.kill();
			await proc.exited;
		}
	}, 30_000);

	test("does not respond to notifications (requests without id)", async () => {
		const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", "mcp"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				RUGSCAN_MCP_STUB_DEPS: "1",
				RUGSCAN_CONFIG: "test/fixtures/empty-config.json",
			},
		});

		const reader = proc.stdout.getReader();
		const stdin = proc.stdin;
		if (!stdin) {
			proc.kill();
			throw new Error("Failed to open stdin pipe");
		}

		type NodeLikeStdin = {
			write: (chunk: Uint8Array) => unknown;
			end?: () => unknown;
		};

		type WebLikeStdin = {
			getWriter: () => WritableStreamDefaultWriter<Uint8Array>;
		};

		const hasWrite = (value: unknown): value is NodeLikeStdin => {
			return isRecord(value) && typeof value.write === "function";
		};

		const hasGetWriter = (value: unknown): value is WebLikeStdin => {
			return isRecord(value) && typeof value.getWriter === "function";
		};

		let webWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

		const writeStdin = async (data: Uint8Array) => {
			if (hasWrite(stdin)) {
				stdin.write(data);
				await Bun.sleep(0);
				return;
			}

			if (hasGetWriter(stdin)) {
				if (!webWriter) webWriter = stdin.getWriter();
				await webWriter.write(data);
				return;
			}

			throw new Error("Unsupported stdin pipe type");
		};

		try {
			// Notification: omit id, expect no response.
			await writeStdin(
				encodeMessage({
					jsonrpc: "2.0",
					method: "initialize",
					params: {
						protocolVersion: "2024-11-05",
						clientInfo: { name: "rugscan-test", version: "0" },
						capabilities: {},
					},
				}),
			);

			// Request: should be the first message we receive.
			await writeStdin(
				encodeMessage({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2024-11-05",
						clientInfo: { name: "rugscan-test", version: "0" },
						capabilities: {},
					},
				}),
			);

			const init = await readMessage(reader);
			if (!isRecord(init)) throw new Error("Expected MCP response to be an object");
			expect(init.id).toBe(1);
			expect(init).toHaveProperty("result");
		} finally {
			if (webWriter) {
				try {
					await webWriter.close();
				} catch {
					// ignore
				} finally {
					webWriter.releaseLock();
				}
			} else if (hasWrite(stdin) && typeof stdin.end === "function") {
				try {
					stdin.end();
				} catch {
					// ignore
				}
			}

			proc.kill();
			await proc.exited;
		}
	}, 10_000);

	test("includes zod error details in -32602 for invalid tool arguments", async () => {
		const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", "mcp"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				RUGSCAN_MCP_STUB_DEPS: "1",
				RUGSCAN_CONFIG: "test/fixtures/empty-config.json",
			},
		});

		const reader = proc.stdout.getReader();
		const stdin = proc.stdin;
		if (!stdin) {
			proc.kill();
			throw new Error("Failed to open stdin pipe");
		}

		type NodeLikeStdin = {
			write: (chunk: Uint8Array) => unknown;
			end?: () => unknown;
		};

		type WebLikeStdin = {
			getWriter: () => WritableStreamDefaultWriter<Uint8Array>;
		};

		const hasWrite = (value: unknown): value is NodeLikeStdin => {
			return isRecord(value) && typeof value.write === "function";
		};

		const hasGetWriter = (value: unknown): value is WebLikeStdin => {
			return isRecord(value) && typeof value.getWriter === "function";
		};

		let webWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

		const writeStdin = async (data: Uint8Array) => {
			if (hasWrite(stdin)) {
				stdin.write(data);
				await Bun.sleep(0);
				return;
			}

			if (hasGetWriter(stdin)) {
				if (!webWriter) webWriter = stdin.getWriter();
				await webWriter.write(data);
				return;
			}

			throw new Error("Unsupported stdin pipe type");
		};

		try {
			await writeStdin(
				encodeMessage({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "rugscan.analyzeTransaction",
						arguments: {
							chain: "ethereum",
							// missing required fields like to/data
						},
					},
				}),
			);

			const response = await readMessage(reader);
			if (!isRecord(response)) throw new Error("Expected MCP response to be an object");
			const error = response.error;
			if (!isRecord(error)) throw new Error("Expected MCP error to be an object");
			expect(error.code).toBe(-32602);
			expect(error.message).toBe("Invalid tool arguments");
			const data = error.data;
			if (!isRecord(data)) throw new Error("Expected MCP error.data to be an object");
			expect(data.tool).toBe("rugscan.analyzeTransaction");
			expect(Array.isArray(data.issues)).toBe(true);
		} finally {
			if (webWriter) {
				try {
					await webWriter.close();
				} catch {
					// ignore
				} finally {
					webWriter.releaseLock();
				}
			} else if (hasWrite(stdin) && typeof stdin.end === "function") {
				try {
					stdin.end();
				} catch {
					// ignore
				}
			}

			proc.kill();
			await proc.exited;
		}
	}, 10_000);
});
