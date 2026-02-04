#!/usr/bin/env bun
import { analyze } from "../analyzer";
import { analyzeApproval } from "../approval";
import { loadConfig } from "../config";
import { MAX_UINT256 } from "../constants";
import { createJsonRpcProxyServer } from "../jsonrpc/proxy";
import { resolveProvider } from "../providers/ai";
import { resolveScanChain, scanWithAnalysis } from "../scan";
import type { CalldataInput, ScanInput } from "../schema";
import { scanInputSchema } from "../schema";
import type { ApprovalContext, ApprovalTx, Chain, Recommendation } from "../types";
import { formatSarif } from "./formatters/sarif";
import {
	createProgressRenderer,
	renderApprovalBox,
	renderError,
	renderHeading,
	renderResultBox,
} from "./ui";

const VALID_CHAINS: Chain[] = ["ethereum", "base", "arbitrum", "optimism", "polygon"];

function printUsage() {
	console.log(`
rugscan - Pre-transaction security analysis for EVM contracts

Usage:
  rugscan analyze <address> [--chain <chain>] [--ai] [--model <model>]
  rugscan scan [address] [--format json|sarif] [--calldata <json|hex|@file|->] [--to <address>] [--from <address>] [--value <value>] [--fail-on <caution|warning|danger>]
  rugscan approval --token <address> --spender <address> --amount <value> [--expected <address>] [--chain <chain>]
  rugscan proxy --upstream <rpc-url> [--port <port>] [--hostname <host>] [--chain <chain>] [--threshold <caution|warning|danger>] [--on-risk <block|prompt>] [--once]

Options:
  --chain, -c    Chain to analyze on (default: ethereum)
                 Valid: ethereum, base, arbitrum, optimism, polygon
  --format       Output format for scan (json|sarif; default: text)
  --calldata     Unsigned tx JSON (Rabby/MetaMask-like), canonical calldata JSON, raw hex calldata, @file, or - for stdin
  --to           Required when passing raw hex calldata (MetaMask "Hex Data")
  --from         Optional from address (used for simulation/intent when present)
  --value        Optional tx value (decimal or 0x hex)
  --data         Raw hex calldata (alternative to --calldata)
  --no-sim       Disable transaction simulation (Anvil)
  --fail-on      Exit non-zero on recommendation >= threshold (default: warning)
  --output       Output file path or - for stdout (default: -)
  --quiet        Suppress non-essential logs

  Proxy:
  --upstream     Upstream JSON-RPC HTTP URL to forward requests to
  --hostname     Hostname to bind the proxy server (default: 127.0.0.1)
  --port         Port to bind the proxy server (default: 8545)
  --threshold    Treat recommendation >= threshold as risky (default: caution)
  --on-risk      What to do when risky (block|prompt; default: prompt if TTY else block)
  --once         Handle one request then exit (useful for tests)

  --ai           Enable AI risk analysis (requires API key)
  --model        Override AI model or provider:model (ex: openai:gpt-4o)
  --token        Token address for approval analysis
  --spender      Spender address for approval analysis
  --amount       Approval amount (integer or "max")
  --expected     Expected spender address

Environment:
  ETHERSCAN_API_KEY       Etherscan API key (enables full analysis)
  BASESCAN_API_KEY        BaseScan API key
  ARBISCAN_API_KEY        Arbiscan API key
  OPTIMISM_API_KEY        Optimistic Etherscan API key
  POLYGONSCAN_API_KEY     PolygonScan API key
  ANTHROPIC_API_KEY       Anthropic API key (AI analysis)
  OPENAI_API_KEY          OpenAI API key (AI analysis)
  OPENROUTER_API_KEY      OpenRouter API key (AI analysis)

Examples:
  rugscan analyze 0x1234...
  rugscan analyze 0x1234... --chain base
  rugscan analyze 0x1234... --ai
  rugscan analyze 0x1234... --ai --model openrouter:anthropic/claude-3-haiku
  rugscan scan 0x1234... --format json
  # Paste Rabby JSON directly
  rugscan scan --calldata '{"chainId":1,"from":"0x...","to":"0x...","value":"0x0","data":"0x..."}' --format json

  # MetaMask "Hex Data" (raw calldata) + explicit target
  rugscan scan --calldata 0x... --to 0x... --value 0x0 --chain 1 --format json
  rugscan approval --token 0x1234... --spender 0xabcd... --amount max
`);
}

function isChain(value: string | undefined): value is Chain {
	return typeof value === "string" && VALID_CHAINS.some((chain) => chain === value);
}

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printUsage();
		process.exit(0);
	}

	const command = args[0];
	if (command === "analyze") {
		await runAnalyze(args.slice(1));
		return;
	}
	if (command === "scan") {
		await runScan(args.slice(1));
		return;
	}
	if (command === "approval") {
		await runApproval(args.slice(1));
		return;
	}
	if (command === "proxy") {
		await runProxy(args.slice(1));
		return;
	}

	console.error(`Unknown command: ${command}`);
	printUsage();
	process.exit(1);
}

async function runAnalyze(args: string[]) {
	// Parse arguments
	const address = args[0];
	if (!isValidAddress(address)) {
		console.error(renderError("Error: Please provide a valid contract address"));
		process.exit(1);
	}

	const chain = parseChain(args);

	try {
		const enableAI = args.includes("--ai");
		const modelIndex = args.indexOf("--model");
		const model = modelIndex !== -1 ? args[modelIndex + 1] : undefined;

		if (modelIndex !== -1 && !model) {
			console.error(renderError("Error: --model requires a value"));
			process.exit(1);
		}
		if (model && !enableAI) {
			console.error(renderError("Error: --model requires --ai"));
			process.exit(1);
		}

		const config = await loadConfig();
		if (enableAI) {
			try {
				void resolveProvider(config.ai, model);
			} catch (error) {
				const message = error instanceof Error ? error.message : "No AI API keys found.";
				console.error(renderError(`Error: ${message}`));
				process.exit(1);
			}
			config.aiOptions = {
				enabled: true,
				model,
			};
		}

		console.log(renderHeading(`Analyzing ${address} on ${chain}...`));
		console.log("");

		const renderProgress = createProgressRenderer(process.stdout.isTTY);
		const result = await analyze(address, chain, config, renderProgress);

		console.log("");
		console.log(renderResultBox(result, { hasCalldata: false }));
		console.log("");

		// Exit code based on recommendation
		if (result.recommendation === "danger") {
			process.exit(2);
		}
		if (result.recommendation === "warning" || result.recommendation === "caution") {
			process.exit(1);
		}
	} catch (error) {
		console.error(renderError("Analysis failed:"));
		console.error(error);
		process.exit(1);
	}
}

async function runScan(args: string[]) {
	const format = parseFormat(getFlagValue(args, ["--format"]));
	const output = getFlagValue(args, ["--output"]) ?? "-";
	const quiet = args.includes("--quiet");
	const noSim = args.includes("--no-sim");
	const failOn = parseFailOn(getFlagValue(args, ["--fail-on"]));
	const chainValue = getFlagValue(args, ["--chain", "-c"]);
	const addressFlag = getFlagValue(args, ["--address"]);
	const calldataFlag = getFlagValue(args, ["--calldata"]);
	const toFlag = getFlagValue(args, ["--to"]);
	const fromFlag = getFlagValue(args, ["--from"]);
	const valueFlag = getFlagValue(args, ["--value"]);
	const dataFlag = getFlagValue(args, ["--data"]);
	const positional = getPositionalArgs(args);
	const address = addressFlag ?? positional[0];

	if ((calldataFlag || dataFlag) && address) {
		console.error(renderError("Error: Provide either address or tx input flags (not both)"));
		process.exit(1);
	}

	let calldata: CalldataInput | undefined;
	if (calldataFlag) {
		try {
			calldata = await parseCalldataInput(calldataFlag, {
				to: toFlag,
				from: fromFlag,
				value: valueFlag,
				chain: chainValue,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid calldata";
			console.error(renderError(`Error: ${message}`));
			process.exit(1);
		}
	} else if (dataFlag || toFlag || fromFlag || valueFlag) {
		// MetaMask-style: raw calldata via --data plus explicit --to/--value.
		try {
			calldata = parseTxFlags({
				to: toFlag,
				from: fromFlag,
				data: dataFlag,
				value: valueFlag,
				chain: chainValue,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Invalid tx flags";
			console.error(renderError(`Error: ${message}`));
			process.exit(1);
		}
	}

	const input: ScanInput = address ? { address } : calldata ? { calldata } : {};
	const parsed = scanInputSchema.safeParse(input);
	if (!parsed.success) {
		console.error(renderError("Error: Please provide a valid address or calldata input"));
		process.exit(1);
	}

	const chain = resolveScanChain(chainValue);
	if (!chain) {
		console.error(renderError(`Error: Invalid chain "${chainValue ?? ""}"`));
		console.error(`Valid chains: ${VALID_CHAINS.join(", ")}`);
		process.exit(1);
	}

	try {
		const config = await loadConfig();
		if (noSim) {
			config.simulation = { ...config.simulation, enabled: false };
		}
		const showProgress = format === "text" && !quiet && output === "-";
		const progress = showProgress ? createProgressRenderer(process.stdout.isTTY) : undefined;
		if (format === "text" && !quiet && output === "-") {
			const target = address ?? calldata?.to ?? "input";
			process.stdout.write(`${renderHeading(`Analyzing ${target} on ${chain}...`)}\n\n`);
		}

		const { analysis, response } = await scanWithAnalysis(parsed.data, {
			chain,
			config,
			progress,
		});

		const outputPayload =
			format === "json"
				? JSON.stringify(response, null, 2)
				: format === "sarif"
					? JSON.stringify(formatSarif(response), null, 2)
					: renderResultBox(analysis, { hasCalldata: Boolean(parsed.data.calldata) });

		await writeOutput(output, outputPayload, format === "text");

		const exitCode = recommendationToExitCode(response.scan.recommendation, failOn);
		process.exit(exitCode);
	} catch (error) {
		console.error(renderError("Scan failed:"));
		console.error(error);
		process.exit(1);
	}
}

async function runApproval(args: string[]) {
	const token = getFlagValue(args, ["--token"]);
	const spender = getFlagValue(args, ["--spender"]);
	const amountRaw = getFlagValue(args, ["--amount"]);
	const expected = getFlagValue(args, ["--expected"]);

	if (!isValidAddress(token)) {
		console.error(renderError("Error: --token must be a valid address"));
		process.exit(1);
	}
	if (!isValidAddress(spender)) {
		console.error(renderError("Error: --spender must be a valid address"));
		process.exit(1);
	}
	if (expected && !isValidAddress(expected)) {
		console.error(renderError("Error: --expected must be a valid address"));
		process.exit(1);
	}

	const amount = parseAmount(amountRaw);
	if (amount === null) {
		console.error(renderError('Error: --amount must be an integer or "max"'));
		process.exit(1);
	}

	const chain = parseChain(args);

	try {
		const config = await loadConfig();
		const tx: ApprovalTx = {
			token,
			spender,
			amount,
		};
		const context: ApprovalContext = {};
		if (expected) {
			context.expectedSpender = expected;
		}

		console.log(renderHeading(`Analyzing approval for ${spender} on ${chain}...`));
		console.log("");

		const result = await analyzeApproval(tx, chain, context, config);

		console.log(renderApprovalBox(tx, chain, context, result));
		console.log("");

		if (result.recommendation === "danger") {
			process.exit(2);
		}
		if (result.recommendation === "warning" || result.recommendation === "caution") {
			process.exit(1);
		}
	} catch (error) {
		console.error(renderError("Approval analysis failed:"));
		console.error(error);
		process.exit(1);
	}
}

async function runProxy(args: string[]) {
	const upstreamUrl = getFlagValue(args, ["--upstream"]);
	if (!upstreamUrl) {
		console.error(renderError("Error: --upstream is required"));
		process.exit(1);
	}

	const hostname = getFlagValue(args, ["--hostname"]) ?? "127.0.0.1";
	const port = parsePort(getFlagValue(args, ["--port"]) ?? "8545");
	const chain = getFlagValue(args, ["--chain", "-c"]);
	const threshold = parseProxyThreshold(getFlagValue(args, ["--threshold"]));
	const onRisk = parseOnRisk(getFlagValue(args, ["--on-risk"]));
	const once = args.includes("--once");
	const quiet = args.includes("--quiet");

	const config = await loadConfig();

	const defaultOnRisk = process.stdin.isTTY && process.stdout.isTTY ? "prompt" : "block";
	const server = createJsonRpcProxyServer({
		upstreamUrl,
		hostname,
		port,
		chain,
		once,
		quiet,
		config,
		policy: {
			threshold,
			onRisk: onRisk ?? defaultOnRisk,
		},
	});

	if (!quiet) {
		console.log(renderHeading(`JSON-RPC proxy listening on http://${hostname}:${server.port}`));
		console.log(`Upstream: ${upstreamUrl}`);
		console.log(`Threshold: ${threshold}`);
		console.log(`On risk: ${onRisk ?? defaultOnRisk}`);
		console.log("");
		console.log("Configure your wallet's RPC URL to point at this proxy.");
	}

	// Keep process alive.
	await new Promise(() => {});
}

function parseChain(args: string[]): Chain {
	let chain: Chain = "ethereum";
	const chainIndex = args.findIndex((arg) => arg === "--chain" || arg === "-c");
	if (chainIndex !== -1 && args[chainIndex + 1]) {
		const requestedChain = args[chainIndex + 1];
		if (!isChain(requestedChain)) {
			console.error(`Error: Invalid chain "${requestedChain}"`);
			console.error(`Valid chains: ${VALID_CHAINS.join(", ")}`);
			process.exit(1);
		}
		chain = requestedChain;
	}
	return chain;
}

function parseFormat(value: string | undefined): "text" | "json" | "sarif" {
	if (!value) return "text";
	const normalized = value.toLowerCase();
	if (normalized === "json" || normalized === "sarif" || normalized === "text") {
		return normalized;
	}
	console.error(renderError(`Error: Invalid format "${value}"`));
	process.exit(1);
}

function parseFailOn(value: string | undefined): Recommendation {
	if (!value) return "warning";
	const normalized = value.toLowerCase();
	if (normalized === "caution" || normalized === "warning" || normalized === "danger") {
		return normalized;
	}
	console.error(renderError(`Error: Invalid --fail-on value "${value}"`));
	process.exit(1);
}

function parseProxyThreshold(value: string | undefined): Recommendation {
	if (!value) return "caution";
	const normalized = value.toLowerCase();
	if (normalized === "caution" || normalized === "warning" || normalized === "danger") {
		return normalized;
	}
	console.error(renderError(`Error: Invalid --threshold value "${value}"`));
	process.exit(1);
}

function parseOnRisk(value: string | undefined): "block" | "prompt" | undefined {
	if (!value) return undefined;
	const normalized = value.toLowerCase();
	if (normalized === "block" || normalized === "prompt") {
		return normalized;
	}
	console.error(renderError(`Error: Invalid --on-risk value "${value}"`));
	process.exit(1);
}

function parsePort(value: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
		console.error(renderError(`Error: Invalid --port value "${value}"`));
		process.exit(1);
	}
	return parsed;
}

function getFlagValue(args: string[], flags: string[]): string | undefined {
	const index = args.findIndex((arg) => flags.includes(arg));
	if (index === -1) return undefined;
	return args[index + 1];
}

function getPositionalArgs(args: string[]): string[] {
	const argsWithValues = new Set([
		"--format",
		"--calldata",
		"--to",
		"--from",
		"--value",
		"--data",
		"--chain",
		"-c",
		"--address",
		"--fail-on",
		"--output",
		"--upstream",
		"--hostname",
		"--port",
		"--threshold",
		"--on-risk",
	]);
	const positional: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (argsWithValues.has(arg)) {
			i += 1;
			continue;
		}
		if (arg === "--quiet") {
			continue;
		}
		if (arg.startsWith("-")) {
			continue;
		}
		positional.push(arg);
	}
	return positional;
}

type TxFlags = {
	to?: string;
	from?: string;
	value?: string;
	data?: string;
	chain?: string;
};

async function parseCalldataInput(value: string, flags: TxFlags): Promise<CalldataInput> {
	const raw = (await readInput(value)).trim();

	// Allow raw hex calldata (MetaMask "Hex Data")
	if (isHexString(raw)) {
		return parseTxFlags({ ...flags, data: raw });
	}

	const parsed = safeJsonParse(raw);
	if (!parsed) {
		throw new Error("Invalid tx input (expected JSON or 0x hex calldata)");
	}

	const normalized = normalizeWalletTx(parsed, flags.chain);
	const result = scanInputSchema.safeParse({ calldata: normalized });
	if (!result.success || !result.data.calldata) {
		throw new Error("Invalid calldata/tx shape");
	}
	return result.data.calldata;
}

function parseTxFlags(flags: TxFlags): CalldataInput {
	if (!isValidAddress(flags.to)) {
		throw new Error("--to is required and must be a valid address");
	}
	const data = flags.data?.trim();
	if (!data || !isHexString(data)) {
		throw new Error("--data (or raw --calldata hex) is required and must be 0x hex");
	}
	const candidate: CalldataInput = {
		to: flags.to,
		from: isValidAddress(flags.from) ? flags.from : undefined,
		data,
		value: flags.value,
		chain: flags.chain,
	};
	const result = scanInputSchema.safeParse({ calldata: candidate });
	if (!result.success || !result.data.calldata) {
		throw new Error("Invalid tx flags");
	}
	return result.data.calldata;
}

function normalizeWalletTx(input: unknown, chainOverride?: string): unknown {
	if (!isRecord(input)) return input;

	const direct = coerceTxObject(input);
	if (!direct) return input;

	const chain =
		(typeof direct.chain === "string" ? direct.chain : undefined) ??
		parseChainId(direct.chainId) ??
		chainOverride;

	return {
		to: direct.to,
		from: direct.from,
		data: direct.data,
		value: direct.value,
		chain,
	};
}

type TxObject = {
	to?: string;
	from?: string;
	data?: string;
	value?: string;
	chain?: unknown;
	chainId?: unknown;
};

function coerceTxObject(record: Record<string, unknown>): TxObject | null {
	// Rabby often provides a flat eth_sendTransaction-style payload.
	// Some tools nest under tx/txParams.
	const candidates: Array<Record<string, unknown>> = [record];
	const tx = record.tx;
	if (isRecord(tx)) candidates.push(tx);
	const txParams = record.txParams;
	if (isRecord(txParams)) candidates.push(txParams);
	const params = record.params;
	if (Array.isArray(params)) {
		for (const param of params) {
			if (isRecord(param)) candidates.push(param);
		}
	}

	for (const obj of candidates) {
		const to = getString(obj, "to");
		const data = getString(obj, "data");
		if (typeof to === "string" && typeof data === "string") {
			return {
				to,
				from: getString(obj, "from"),
				data,
				value: getString(obj, "value"),
				chain: getString(obj, "chain"),
				chainId: obj.chainId,
			};
		}
	}

	return null;
}

function parseChainId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("0x")) {
		const parsed = safeParseHexToInt(trimmed);
		return parsed ? String(parsed) : undefined;
	}
	if (/^[0-9]+$/.test(trimmed)) return trimmed;
	return undefined;
}

function safeParseHexToInt(value: string): number | null {
	try {
		return Number.parseInt(value, 16);
	} catch {
		return null;
	}
}

function isHexString(value: string): boolean {
	return /^0x[0-9a-fA-F]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

async function readInput(value: string): Promise<string> {
	if (value === "-") {
		return await new Response(process.stdin).text();
	}
	if (value.startsWith("@")) {
		const path = value.slice(1);
		return await Bun.file(path).text();
	}
	return value;
}

function safeJsonParse(value: string): unknown | null {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function recommendationToExitCode(recommendation: Recommendation, failOn: Recommendation): number {
	const order: Recommendation[] = ["ok", "caution", "warning", "danger"];
	const recommendationIndex = order.indexOf(recommendation);
	const failOnIndex = order.indexOf(failOn);
	if (recommendationIndex === -1 || failOnIndex === -1) {
		return 1;
	}
	return recommendationIndex >= failOnIndex ? 2 : 0;
}

async function writeOutput(target: string, payload: string, addNewline: boolean) {
	const output = addNewline ? `${payload}\n` : payload;
	if (target === "-") {
		process.stdout.write(output);
		return;
	}
	await Bun.write(target, output);
}

function parseAmount(value: string | undefined): bigint | null {
	if (!value) return null;
	if (value.toLowerCase() === "max") {
		return MAX_UINT256;
	}
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function isValidAddress(value: string | undefined): value is string {
	return typeof value === "string" && value.startsWith("0x") && value.length === 42;
}

main();
