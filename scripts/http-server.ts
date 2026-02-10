#!/usr/bin/env bun

import { createServer } from "../src/server";

function getFlagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index === -1) return undefined;
	return args[index + 1];
}

function parsePort(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
		throw new Error(`Invalid --port value: ${value}`);
	}
	return parsed;
}

const args = process.argv.slice(2);
const port = parsePort(getFlagValue(args, "--port"), 3000);
const apiKey = getFlagValue(args, "--api-key") ?? process.env.ASSAY_API_KEY;

if (!apiKey) {
	console.error("Error: missing API key. Set ASSAY_API_KEY or pass --api-key <key>");
	process.exit(1);
}

const server = createServer({ port, apiKey });
console.log(`assay HTTP server listening on http://localhost:${server.port}`);

// Keep process alive.
await new Promise(() => {});
