import { z } from "zod";
import type { AnalyzerDeps } from "../analyzer";
import type { AnalyzeMode } from "../analyzer-policy";
import { renderHeading, renderResultBox } from "../cli/ui";
import { loadConfig } from "../config";
import { scanWithAnalysis } from "../scan";
import { scanInputSchema } from "../schema";
import type { AnalysisResult, Chain, Config } from "../types";
import { encodeStdioMessage, runStdioJsonRpcServer } from "./stdio";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: JsonRpcId;
	method: string;
	params?: unknown;
};

type JsonRpcSuccess = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
};

type JsonRpcFailure = {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: { code: number; message: string; data?: unknown };
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	if (!isRecord(value)) return false;
	if (value.jsonrpc !== "2.0") return false;
	if (typeof value.method !== "string") return false;
	if ("id" in value) {
		const id = value.id;
		if (id !== null && typeof id !== "string" && typeof id !== "number") return false;
	}
	return true;
}

function jsonRpcError(
	id: JsonRpcId,
	code: number,
	message: string,
	data?: unknown,
): JsonRpcFailure {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message,
			...(data === undefined ? {} : { data }),
		},
	};
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
	return { jsonrpc: "2.0", id, result };
}

const analyzeTransactionArgsSchema = z
	.object({
		chain: z.string().min(1),
		to: z.string().min(1),
		data: z.string().min(1),
		from: z.string().optional(),
		value: z.string().optional(),
		noSim: z.boolean().optional(),
		walletMode: z.boolean().optional(),
	})
	.strict();

const analyzeAddressArgsSchema = z
	.object({
		chain: z.string().min(1),
		address: z.string().min(1),
		walletMode: z.boolean().optional(),
	})
	.strict();

function resolveStubDepsFromEnv(): AnalyzerDeps | null {
	if (process.env.ASSAY_MCP_STUB_DEPS !== "1") return null;

	return {
		defillama: {
			matchProtocol: async () => null,
		},
		etherscan: {
			getAddressLabels: async () => null,
			getContractData: async () => null,
		},
		goplus: {
			getTokenSecurity: async () => ({ data: null }),
		},
		proxy: {
			isContract: async () => true,
			detectProxy: async () => ({ is_proxy: false }),
		},
		sourcify: {
			checkVerification: async () => ({ verified: false, verificationKnown: true }),
		},
	};
}

function toolList() {
	return [
		{
			name: "assay.analyzeTransaction",
			description: "Analyze an EVM transaction target + calldata for risk findings.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					chain: { type: "string", description: "Chain name or chain id (ex: ethereum, 1)." },
					to: { type: "string", description: "Target contract address (0x...)." },
					data: { type: "string", description: "Hex calldata (0x...)." },
					from: { type: "string", description: "Optional sender address (0x...)." },
					value: { type: "string", description: "Optional value (decimal or 0x)." },
					noSim: { type: "boolean", description: "Disable transaction simulation." },
					walletMode: {
						type: "boolean",
						description: "Wallet fast mode (tight provider budgets).",
					},
				},
				required: ["chain", "to", "data"],
			},
		},
		{
			name: "assay.analyzeAddress",
			description: "Analyze a contract/address for risk findings.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					chain: { type: "string", description: "Chain name or chain id (ex: ethereum, 1)." },
					address: { type: "string", description: "Contract/address (0x...)." },
					walletMode: {
						type: "boolean",
						description: "Wallet fast mode (tight provider budgets).",
					},
				},
				required: ["chain", "address"],
			},
		},
	];
}

function resolveChain(value: string): Chain {
	const normalized = value.toLowerCase();
	if (normalized === "ethereum" || normalized === "1") return "ethereum";
	if (normalized === "base" || normalized === "8453") return "base";
	if (normalized === "arbitrum" || normalized === "42161") return "arbitrum";
	if (normalized === "optimism" || normalized === "10") return "optimism";
	if (normalized === "polygon" || normalized === "137") return "polygon";
	throw new Error(`Invalid chain: ${value}`);
}

function configWithNoSim(config: Config, noSim: boolean | undefined): Config {
	if (!noSim) return config;
	return {
		...config,
		simulation: {
			...config.simulation,
			enabled: false,
		},
	};
}

function buildRenderedText(options: {
	chain: Chain;
	analysis: AnalysisResult;
	sender?: string;
}): string {
	const heading = renderHeading(`Transaction scan on ${options.chain}`);
	const body = renderResultBox(options.analysis, {
		hasCalldata: true,
		sender: options.sender,
	});
	return `${heading}\n\n${body}\n`;
}

export async function runMcpServer(): Promise<void> {
	const config = await loadConfig();
	const stubDeps = resolveStubDepsFromEnv();

	await runStdioJsonRpcServer({
		onMessage: async (message) => {
			if (!isJsonRpcRequest(message)) return;

			const isNotification = !("id" in message);
			const id = "id" in message ? (message.id ?? null) : null;
			const method = message.method;

			const send = (payload: JsonRpcSuccess | JsonRpcFailure) => {
				if (isNotification) return;
				process.stdout.write(encodeStdioMessage(payload));
			};

			try {
				if (method === "initialize") {
					const result = {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "assay", version: "0.1.0" },
					};
					send(jsonRpcResult(id, result));
					return;
				}

				if (method === "tools/list") {
					send(
						jsonRpcResult(id, {
							tools: toolList(),
						}),
					);
					return;
				}

				if (method === "tools/call") {
					if (!isRecord(message.params)) {
						send(jsonRpcError(id, -32602, "Invalid params"));
						return;
					}

					const name = message.params.name;
					if (typeof name !== "string") {
						send(jsonRpcError(id, -32602, "Missing tool name"));
						return;
					}

					const args = message.params.arguments;

					if (name === "assay.analyzeTransaction") {
						const parsed = analyzeTransactionArgsSchema.safeParse(args);
						if (!parsed.success) {
							send(
								jsonRpcError(id, -32602, "Invalid tool arguments", {
									tool: name,
									issues: parsed.error.issues,
									flattened: parsed.error.flatten(),
								}),
							);
							return;
						}

						const chain = resolveChain(parsed.data.chain);
						const input = {
							calldata: {
								to: parsed.data.to,
								from: parsed.data.from,
								data: parsed.data.data,
								value: parsed.data.value,
								chain: parsed.data.chain,
							},
						};
						const validated = scanInputSchema.safeParse(input);
						if (!validated.success || !validated.data.calldata) {
							send(jsonRpcError(id, -32602, "Invalid transaction input"));
							return;
						}

						const nextConfig = configWithNoSim(config, parsed.data.noSim);
						const mode: AnalyzeMode = parsed.data.walletMode ? "wallet" : "default";
						const analyzeOptions = {
							mode,
							deps: stubDeps ?? undefined,
						};
						const depsEnabled = analyzeOptions.deps !== undefined;
						const options = depsEnabled
							? { chain: String(chain), config: nextConfig, analyzeOptions }
							: {
									chain: String(chain),
									config: nextConfig,
									analyzeOptions: { mode: analyzeOptions.mode },
								};

						const { analysis, response } = await scanWithAnalysis(validated.data, options);
						const renderedText = buildRenderedText({
							chain,
							analysis,
							sender: response.scan.input.calldata?.from,
						});

						send(
							jsonRpcResult(id, {
								content: [
									{ type: "text", text: renderedText },
									{ type: "text", text: JSON.stringify(response, null, 2) },
								],
							}),
						);
						return;
					}

					if (name === "assay.analyzeAddress") {
						const parsed = analyzeAddressArgsSchema.safeParse(args);
						if (!parsed.success) {
							send(
								jsonRpcError(id, -32602, "Invalid tool arguments", {
									tool: name,
									issues: parsed.error.issues,
									flattened: parsed.error.flatten(),
								}),
							);
							return;
						}

						const chain = resolveChain(parsed.data.chain);
						const input = { address: parsed.data.address };
						const validated = scanInputSchema.safeParse(input);
						if (!validated.success || !validated.data.address) {
							send(jsonRpcError(id, -32602, "Invalid address input"));
							return;
						}

						const mode: AnalyzeMode = parsed.data.walletMode ? "wallet" : "default";
						const analyzeOptions = {
							mode,
							deps: stubDeps ?? undefined,
						};
						const depsEnabled = analyzeOptions.deps !== undefined;
						const options = depsEnabled
							? { chain: String(chain), config, analyzeOptions }
							: {
									chain: String(chain),
									config,
									analyzeOptions: { mode: analyzeOptions.mode },
								};

						const { response } = await scanWithAnalysis(validated.data, options);
						send(
							jsonRpcResult(id, {
								content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
							}),
						);
						return;
					}

					send(jsonRpcError(id, -32601, `Unknown tool: ${name}`));
					return;
				}

				if (id !== null) {
					send(jsonRpcError(id, -32601, `Method not found: ${method}`));
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "Internal error";
				send(jsonRpcError(id, -32000, message));
			}
		},
		onParseError: (error) => {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`assay mcp parse error: ${message}\n`);
		},
	});
}
