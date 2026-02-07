import { Buffer } from "node:buffer";

export type StdioMessageHandler = (message: unknown) => Promise<void> | void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getContentLength(headers: string): number | null {
	const lines = headers.split("\r\n");
	for (const line of lines) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		if (key !== "content-length") continue;
		const value = line.slice(idx + 1).trim();
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
	}
	return null;
}

export function encodeStdioMessage(payload: unknown): Buffer {
	const body = JSON.stringify(payload);
	const length = Buffer.byteLength(body, "utf8");
	const header = `Content-Length: ${length}\r\n\r\n`;
	return Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(body, "utf8")]);
}

export async function runStdioJsonRpcServer(options: {
	onMessage: StdioMessageHandler;
	onParseError?: (error: unknown) => void;
}): Promise<void> {
	let buffer = Buffer.alloc(0);

	for await (const chunk of process.stdin) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		buffer = Buffer.concat([buffer, bytes]);

		while (true) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;

			const headerRaw = buffer.slice(0, headerEnd).toString("utf8");
			const contentLength = getContentLength(headerRaw);
			if (contentLength === null) {
				options.onParseError?.(new Error("Missing Content-Length header"));
				// Discard up to headerEnd+4 to avoid infinite loop.
				buffer = buffer.slice(headerEnd + 4);
				continue;
			}

			const start = headerEnd + 4;
			const end = start + contentLength;
			if (buffer.length < end) break;

			const body = buffer.slice(start, end).toString("utf8");
			buffer = buffer.slice(end);

			let message: unknown;
			try {
				message = JSON.parse(body);
			} catch (error) {
				options.onParseError?.(error);
				continue;
			}

			if (!isRecord(message)) {
				options.onParseError?.(new Error("JSON-RPC message must be an object"));
				continue;
			}

			await options.onMessage(message);
		}
	}
}
