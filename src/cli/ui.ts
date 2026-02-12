import pc from "picocolors";
import { decodeKnownCalldata } from "../analyzers/calldata/decoder";
import { KNOWN_SPENDERS } from "../approvals/known-spenders";
import { getChainConfig } from "../chains";
import { MAX_UINT160, MAX_UINT256 } from "../constants";
import { buildIntent } from "../intent";
import { getKnownTokenMetadata } from "../tokens/known";
import type {
	AnalysisResult,
	ApprovalAnalysisResult,
	ApprovalContext,
	ApprovalTx,
	AssetChange,
	BalanceSimulationResult,
	Chain,
	Finding,
	Recommendation,
	SimulationConfidenceLevel,
} from "../types";

const COLORS = {
	ok: pc.green,
	warning: pc.yellow,
	danger: pc.red,
	// For now: force high-contrast output. Using dim/gray is unreadable on many terminal themes.
	// If we later want a subtle in-between, add a --low-contrast flag.
	dim: pc.white,
};

type ProviderStatus = "start" | "success" | "error";

export interface ProviderEvent {
	provider: string;
	status: ProviderStatus;
	message?: string;
}

export interface ProgressRendererOptions {
	suppressLowSignalSuccess?: boolean;
}

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
const NATIVE_SYMBOLS: Record<Chain, string> = {
	ethereum: "ETH",
	base: "ETH",
	arbitrum: "ETH",
	optimism: "ETH",
	polygon: "MATIC",
};

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const BALANCE_AMOUNT_FRACTION_DIGITS = 4;
const MIN_BOX_WIDTH_FOR_BORDERS = 56;

type KnownProtocolApprovalEntity = {
	protocol: string;
	entity: string;
};

const KNOWN_PROTOCOL_APPROVAL_ENTITIES: Partial<
	Record<Chain, Record<string, KnownProtocolApprovalEntity>>
> = {
	ethereum: {
		"0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": {
			protocol: "Aave V3",
			entity: "Pool",
		},
	},
};

type RenderMode = "default" | "wallet";

function stripAnsi(input: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
	return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function cleanLabel(input: string): string {
	// Fix common output issues:
	// - carriage returns from provider responses (e.g., Sourcify names)
	// - newlines/tabs breaking box layouts
	return input
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function visibleLength(input: string): number {
	return stripAnsi(input).length;
}

function padRight(input: string, width: number): string {
	const length = visibleLength(input);
	if (length >= width) return input;
	return `${input}${" ".repeat(width - length)}`;
}

/**
 * Clip an ANSI-colored string to at most `maxVisible` visible columns.
 * Inserts a reset at the clip boundary.
 */
function clipVisible(input: string, maxVisible: number): string {
	if (visibleLength(input) <= maxVisible) return input;
	let vis = 0;
	let i = 0;
	while (i < input.length && vis < maxVisible) {
		if (input[i] === "\x1b") {
			const tail = input.slice(i);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
			const m = tail.match(/^\x1b\[[0-9;]*m/);
			if (m) {
				i += m[0].length;
				continue;
			}
		}
		vis++;
		i++;
	}
	return `${input.slice(0, i)}\x1b[0m`;
}

/**
 * Fit a content line into a box row: pad if narrow, clip if too wide.
 */
function fitBoxContent(input: string, width: number): string {
	const length = visibleLength(input);
	if (length <= width) return padRight(input, width);
	return clipVisible(input, width);
}

class Spinner {
	private timer: ReturnType<typeof setInterval> | null = null;
	private frameIndex = 0;
	private lastLineLength = 0;
	private text = "";

	constructor(private enabled: boolean) {}

	start(text: string) {
		this.stop();
		this.text = text;
		if (!this.enabled) {
			process.stdout.write(`${text}\n`);
			return;
		}
		this.render();
		this.timer = setInterval(() => this.render(), 80);
	}

	succeed(text: string) {
		this.stop();
		this.writeLine(text, true);
	}

	fail(text: string) {
		this.stop();
		this.writeLine(text, true);
	}

	private stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private render() {
		const frame = SPINNER_FRAMES[this.frameIndex % SPINNER_FRAMES.length];
		this.frameIndex += 1;
		// Keep spinner high-contrast; dim spinner frames are hard to see.
		this.writeLine(`${COLORS.warning(frame)} ${this.text}`, false);
	}

	private writeLine(line: string, newline: boolean) {
		if (!this.enabled) {
			process.stdout.write(line + (newline ? "\n" : ""));
			return;
		}

		const length = visibleLength(line);
		const clear = this.lastLineLength > length ? " ".repeat(this.lastLineLength - length) : "";
		process.stdout.write(`\r${line}${clear}${newline ? "\n" : ""}`);
		this.lastLineLength = newline ? 0 : length;
	}
}

function isSkippedProgressMessage(message: string | undefined): boolean {
	if (!message) return false;
	// Providers sometimes report a "success" status even when a check was skipped due to flags,
	// missing inputs, or unsupported chains. Make those visually distinct from true successes.
	return message.toLowerCase().includes("skipped");
}

function isLowSignalSuccessMessage(message: string | undefined): boolean {
	if (!message) return false;
	const normalized = message.toLowerCase();
	return (
		normalized === "checked" ||
		normalized === "no match" ||
		normalized === "no data" ||
		normalized === "metadata fetched" ||
		normalized === "manual only" ||
		normalized === "no proxy" ||
		normalized.includes("skipped")
	);
}

function activeProvidersLabel(activeProviders: string[]): string {
	if (activeProviders.length === 0) {
		return "Running checks...";
	}
	const [first, ...rest] = activeProviders;
	if (!first) {
		return "Running checks...";
	}
	if (rest.length === 0) {
		return `Checking ${first}...`;
	}
	return `Checking ${first} (+${rest.length} more)...`;
}

export function createProgressRenderer(enabled: boolean, options?: ProgressRendererOptions) {
	const spinner = new Spinner(enabled);
	const activeProviders: string[] = [];
	const suppressLowSignalSuccess = options?.suppressLowSignalSuccess ?? false;

	const addActiveProvider = (provider: string) => {
		if (activeProviders.includes(provider)) return;
		activeProviders.push(provider);
	};

	const removeActiveProvider = (provider: string) => {
		const index = activeProviders.indexOf(provider);
		if (index === -1) return;
		activeProviders.splice(index, 1);
	};

	const restartSpinnerIfNeeded = () => {
		if (!enabled) return;
		if (activeProviders.length === 0) return;
		spinner.start(activeProvidersLabel(activeProviders));
	};

	return (event: ProviderEvent) => {
		const provider = event.provider;
		const message = typeof event.message === "string" ? cleanLabel(event.message) : undefined;
		switch (event.status) {
			case "start":
				addActiveProvider(provider);
				restartSpinnerIfNeeded();
				break;
			case "success": {
				removeActiveProvider(provider);
				if (suppressLowSignalSuccess && isLowSignalSuccessMessage(message)) {
					restartSpinnerIfNeeded();
					break;
				}
				const detail = message ? ` ${COLORS.dim(`(${message})`)}` : "";
				if (isSkippedProgressMessage(message)) {
					spinner.succeed(`${COLORS.warning("⏭")} ${provider}${detail}`);
					restartSpinnerIfNeeded();
					break;
				}
				spinner.succeed(`${COLORS.ok("✓")} ${provider}${detail}`);
				restartSpinnerIfNeeded();
				break;
			}
			case "error": {
				removeActiveProvider(provider);
				const detail = message ? ` ${COLORS.dim(`(${message})`)}` : "";
				spinner.fail(`${COLORS.danger("✗")} ${provider}${detail}`);
				restartSpinnerIfNeeded();
				break;
			}
		}
	};
}

function recommendationStyle(recommendation: Recommendation) {
	switch (recommendation) {
		case "danger":
			return { label: "DANGER", icon: "🚨", color: COLORS.danger };
		case "warning":
			return { label: "WARNING", icon: "⚠️", color: COLORS.warning };
		case "caution":
			return { label: "CAUTION", icon: "⚡", color: COLORS.warning };
		default:
			return { label: "OK", icon: "✅", color: COLORS.ok };
	}
}

function simulationCoverageBlockStyle() {
	return { label: "BLOCK (UNVERIFIED)", icon: "⛔", color: COLORS.warning };
}

function simulationCoverageAction(mode: RenderMode): string {
	if (mode === "wallet") {
		return "rerun without --wallet for full coverage before signing";
	}
	return "rerun using a simulation-capable RPC (supports debug_traceCall), then rescan before signing";
}

function simulationCoverageNextStepLine(mode: RenderMode): string {
	return `Next step: ${simulationCoverageAction(mode)}.`;
}

const UNLIMITED_APPROVAL_MITIGATION_LINE =
	"Mitigation: prefer exact allowance and revoke existing approvals when appropriate.";

const APPROVAL_ONLY_BALANCE_LINE = "No balance changes expected (approval only).";

const CHECKS_FINDINGS_CAP = 4;

const FINDING_CODE_PRIORITY: Partial<Record<Finding["code"], number>> = {
	KNOWN_PHISHING: 0,
	HONEYPOT: 1,
	OWNER_DRAIN: 2,
	HIDDEN_MINT: 3,
	SELFDESTRUCT: 4,
	UNVERIFIED: 5,
	APPROVAL_TARGET_MISMATCH: 6,
	APPROVAL_TO_DANGEROUS_CONTRACT: 7,
	APPROVAL_TO_EOA: 8,
	POSSIBLE_TYPOSQUAT: 9,
	UPGRADEABLE: 10,
	NEW_CONTRACT: 11,
	UNLIMITED_APPROVAL: 12,
	SIM_UNLIMITED_APPROVAL_UNKNOWN_SPENDER: 13,
	SIM_APPROVAL_FOR_ALL_UNKNOWN_OPERATOR: 14,
	SIM_MULTIPLE_OUTBOUND_TRANSFERS: 15,
	LOW_ACTIVITY: 16,
};

function findingLevelPriority(level: Finding["level"]): number {
	if (level === "danger") return 0;
	if (level === "warning") return 1;
	if (level === "info") return 2;
	return 3;
}

function compareFindingsBySignal(a: Finding, b: Finding): number {
	const levelDiff = findingLevelPriority(a.level) - findingLevelPriority(b.level);
	if (levelDiff !== 0) return levelDiff;

	const aPriority = FINDING_CODE_PRIORITY[a.code] ?? 999;
	const bPriority = FINDING_CODE_PRIORITY[b.code] ?? 999;
	if (aPriority !== bPriority) return aPriority - bPriority;

	return a.code.localeCompare(b.code);
}

function formatFindingLine(finding: Finding): string {
	const style =
		finding.level === "danger"
			? { icon: "🚨", color: COLORS.danger }
			: finding.level === "warning"
				? { icon: "⚠️", color: COLORS.warning }
				: finding.level === "safe"
					? { icon: "✓", color: COLORS.ok }
					: { icon: "ℹ️", color: COLORS.dim };

	const message = `${style.icon} ${cleanLabel(finding.message)}`;
	const code = COLORS.dim(`[${finding.code}]`);
	return `${style.color(message)} ${code}`.trimEnd();
}

/**
 * Word-wrap a single line to fit within maxWidth visible columns.
 * Preserves ANSI escape sequences across the break by tracking the last active
 * color code and re-applying it on continuation lines.
 *
 * Continuation lines are indented slightly deeper than the original leading
 * whitespace to visually signal they belong to the same logical line.
 */
function wrapBoxLine(input: string, maxWidth: number): string[] {
	if (maxWidth <= 0 || visibleLength(input) <= maxWidth) return [input];

	const stripped = stripAnsi(input);
	const leadingSpaces = stripped.length - stripped.trimStart().length;
	// Continuation indent: 3 more than the original, but never more than half the width
	const contIndent = " ".repeat(Math.min(leadingSpaces + 3, Math.floor(maxWidth / 2)));

	const lines: string[] = [];
	let remaining = input;

	// Safety: limit iterations to prevent infinite loops when a single token
	// exceeds maxWidth (the continuation indent can make the remainder grow).
	const maxIterations =
		Math.ceil(visibleLength(remaining) / Math.max(maxWidth - contIndent.length, 1)) + 10;
	let iterations = 0;

	while (visibleLength(remaining) > maxWidth) {
		iterations++;
		if (iterations > maxIterations) break;

		let visPos = 0;
		let lastSpaceByte = -1;
		let activeAnsi = "";
		let i = 0;

		while (i < remaining.length && visPos < maxWidth) {
			// Skip ANSI escape sequences (zero visible width)
			if (remaining[i] === "\x1b") {
				const tail = remaining.slice(i);
				// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence
				const m = tail.match(/^\x1b\[[0-9;]*m/);
				if (m) {
					const seq = m[0];
					// Treat full reset (\x1b[0m) and default-foreground (\x1b[39m) as "no color"
					activeAnsi = seq === "\x1b[0m" || seq === "\x1b[39m" ? "" : seq;
					i += seq.length;
					continue;
				}
			}
			if (remaining[i] === " ") lastSpaceByte = i;
			visPos++;
			i++;
		}

		// If no space found, force a hard break at i to avoid infinite loop
		const breakByte = lastSpaceByte > 0 ? lastSpaceByte : i;
		const skipByte = lastSpaceByte > 0 ? lastSpaceByte + 1 : i;

		// Don't break if we made zero progress (shouldn't happen but safety check)
		if (skipByte === 0) break;

		// Close any open ANSI sequence on this fragment
		lines.push(`${remaining.slice(0, breakByte)}\x1b[0m`);
		// Re-open the active ANSI color on the next fragment
		remaining = `${contIndent}${activeAnsi}${remaining.slice(skipByte)}`;
	}

	if (remaining.length > 0) lines.push(remaining);
	return lines;
}

/**
 * Apply wrapBoxLine to every line in an array, returning a flat result.
 * When maxContentWidth is undefined, lines pass through unchanged (backwards-compatible).
 */
function wrapAllLines(lines: string[], maxContentWidth: number | undefined): string[] {
	if (maxContentWidth === undefined) return lines;
	return lines.flatMap((line) => wrapBoxLine(line, maxContentWidth));
}

function shouldUsePlainLayout(maxWidth?: number): boolean {
	return maxWidth !== undefined && maxWidth < MIN_BOX_WIDTH_FOR_BORDERS;
}

function plainDivider(maxWidth?: number): string {
	const target = maxWidth ?? 48;
	const width = Math.max(12, Math.min(target, 48));
	return "─".repeat(width);
}

function renderPlainSections(
	headerLines: string[],
	sections: string[][],
	maxWidth?: number,
): string {
	const wrappedHeaders = wrapAllLines(headerLines, maxWidth);
	const wrappedSections = sections.map((section) => wrapAllLines(section, maxWidth));
	const lines: string[] = [...wrappedHeaders];
	const divider = plainDivider(maxWidth);

	for (const section of wrappedSections) {
		lines.push(divider);
		lines.push(...section);
	}

	return lines.join("\n");
}

function renderBox(title: string, sections: string[][], maxWidth?: number): string {
	if (shouldUsePlainLayout(maxWidth)) {
		return renderPlainSections([title], sections, maxWidth);
	}

	// Box chrome takes 4 visible columns: "│ " (2) + " │" (2)
	const contentMax = maxWidth !== undefined ? maxWidth - 4 : undefined;

	const wrappedTitle = contentMax ? wrapBoxLine(title, contentMax) : [title];
	const wrappedSections = sections.map((s) => wrapAllLines(s, contentMax));

	const allLines = [...wrappedTitle, ...wrappedSections.flat()];
	const naturalWidth = allLines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
	const width = contentMax !== undefined ? Math.min(naturalWidth, contentMax) : naturalWidth;
	const horizontal = "─".repeat(width + 2);

	const top = `┌${horizontal}┐`;
	const bottom = `└${horizontal}┘`;
	const divider = `├${horizontal}┤`;

	const lines: string[] = [top];
	for (const t of wrappedTitle) {
		lines.push(`│ ${fitBoxContent(t, width)} │`);
	}
	wrappedSections.forEach((section, index) => {
		lines.push(divider);
		for (const line of section) {
			lines.push(`│ ${fitBoxContent(line, width)} │`);
		}
		if (index === wrappedSections.length - 1) {
			return;
		}
	});
	lines.push(bottom);
	return lines.join("\n");
}

function renderUnifiedBox(headerLines: string[], sections: string[][], maxWidth?: number): string {
	if (shouldUsePlainLayout(maxWidth)) {
		return renderPlainSections(headerLines, sections, maxWidth);
	}

	// Box chrome takes 4 visible columns: "│ " (2) + " │" (2)
	const contentMax = maxWidth !== undefined ? maxWidth - 4 : undefined;

	const wrappedHeaders = wrapAllLines(headerLines, contentMax);
	const wrappedSections = sections.map((s) => wrapAllLines(s, contentMax));

	const allLines = [...wrappedHeaders, ...wrappedSections.flat()];
	const naturalWidth = allLines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
	const width = contentMax !== undefined ? Math.min(naturalWidth, contentMax) : naturalWidth;
	const horizontal = "─".repeat(width + 2);

	const top = `┌${horizontal}┐`;
	const bottom = `└${horizontal}┘`;
	const divider = `├${horizontal}┤`;

	const lines: string[] = [top];
	for (const line of wrappedHeaders) {
		lines.push(`│ ${fitBoxContent(line, width)} │`);
	}
	wrappedSections.forEach((section) => {
		lines.push(divider);
		for (const line of section) {
			lines.push(`│ ${fitBoxContent(line, width)} │`);
		}
	});
	lines.push(bottom);
	return lines.join("\n");
}

function protocolFromKnownProtocolFinding(findings: Finding[]): string | null {
	for (const finding of findings) {
		if (finding.code !== "KNOWN_PROTOCOL") continue;

		if (isRecord(finding.details)) {
			const name = finding.details.name;
			if (typeof name === "string" && cleanLabel(name).length > 0) {
				return cleanLabel(name);
			}
		}

		const message = cleanLabel(finding.message);
		for (const prefix of ["Recognized protocol:", "Known protocol:"]) {
			if (!message.startsWith(prefix)) continue;
			const parsed = cleanLabel(message.slice(prefix.length));
			if (parsed.length > 0) {
				return parsed;
			}
		}
	}

	return null;
}

function formatProtocolDisplay(result: AnalysisResult): string {
	if (result.protocolMatch?.name) return cleanLabel(result.protocolMatch.name);

	const fromFinding = protocolFromKnownProtocolFinding(result.findings);
	if (fromFinding) return fromFinding;

	if (!result.protocol) return "Unknown";
	const protocol = cleanLabel(result.protocol);
	const separator = " — ";
	const index = protocol.indexOf(separator);
	return index === -1 ? protocol : protocol.slice(0, index);
}

function normalizeProtocolKey(protocol: string): string {
	return protocol.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function formatEntityAddressPreview(address: string): string {
	if (!isAddress(address)) return address;
	const normalized = address.toLowerCase();
	return `${normalized.slice(0, 6)}…${normalized.slice(-3)}`;
}

function resolveContractProtocolLabel(result: AnalysisResult): string | null {
	const value = Reflect.get(result.contract, "protocol");
	if (typeof value !== "string") return null;
	const cleaned = cleanLabel(value);
	return cleaned.length > 0 ? cleaned : null;
}

function protocolResolutionCandidates(result: AnalysisResult): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const add = (value: string | null | undefined) => {
		if (!value) return;
		const cleaned = cleanLabel(value);
		if (cleaned.length === 0) return;
		const key = normalizeProtocolKey(cleaned);
		if (key.length === 0 || seen.has(key)) return;
		seen.add(key);
		candidates.push(cleaned);
	};

	add(result.protocolMatch?.name);
	add(protocolFromKnownProtocolFinding(result.findings));
	add(result.protocol);
	add(resolveContractProtocolLabel(result));

	if (candidates.length === 0) {
		const fallback = formatProtocolDisplay(result);
		if (fallback !== "Unknown") {
			add(fallback);
		}
	}

	return candidates;
}

function resolveKnownProtocolApprovalEntity(
	result: AnalysisResult,
	address: string,
): string | null {
	const chainBook = KNOWN_PROTOCOL_APPROVAL_ENTITIES[result.contract.chain];
	if (!chainBook) return null;
	if (!isAddress(address)) return null;

	const entry = chainBook[address.toLowerCase()];
	if (!entry) return null;

	const entryProtocolKey = normalizeProtocolKey(entry.protocol);
	const protocolMatches = protocolResolutionCandidates(result).some(
		(candidate) => normalizeProtocolKey(candidate) === entryProtocolKey,
	);
	if (!protocolMatches) return null;

	return `${entry.protocol}: ${entry.entity}`;
}

function formatContractLabel(contract: AnalysisResult["contract"]): string {
	const address = contract.address;
	if (contract.is_proxy && contract.proxy_name) {
		const proxyName = cleanLabel(contract.proxy_name);
		const proxyLabel = `${proxyName} (${address})`;
		const implementationName = contract.implementation_name
			? cleanLabel(contract.implementation_name)
			: undefined;
		const implementationLabel = implementationName
			? contract.implementation
				? `${implementationName} (${contract.implementation})`
				: implementationName
			: (contract.implementation ?? "implementation");
		return `${proxyLabel} → ${implementationLabel}`;
	}
	if (contract.name) {
		return `${cleanLabel(contract.name)} (${address})`;
	}
	return address;
}

function resolveActionLabel(result: AnalysisResult): string {
	const base = result.intent ?? findDecodedSignature(result.findings) ?? "Unknown action";
	const improvedApproval = improveApprovalIntentFromSimulation(result, base);
	if (improvedApproval) return improvedApproval;

	const improvedSwap = improveSwapIntentFromSimulation(result, base);
	if (improvedSwap) return improvedSwap;

	return base;
}

function isPlainEthTransferResult(result: AnalysisResult): boolean {
	if (result.protocol !== "ETH Transfer") return false;
	if (typeof result.intent !== "string") return false;
	return result.intent.toLowerCase().startsWith("send ");
}

type DecodedCallContext = {
	signature?: string;
	selector?: string;
	functionName?: string;
	args?: unknown;
	argNames?: string[];
};

function findDecodedCallContext(findings: Finding[]): DecodedCallContext | null {
	for (const finding of findings) {
		if (finding.code !== "CALLDATA_DECODED") continue;
		if (!finding.details || !isRecord(finding.details)) continue;

		const details = finding.details;
		const context: DecodedCallContext = {};

		if (typeof details.signature === "string" && details.signature.length > 0) {
			context.signature = details.signature;
		}
		if (typeof details.selector === "string" && details.selector.length > 0) {
			context.selector = details.selector;
		}
		if (typeof details.functionName === "string" && details.functionName.length > 0) {
			context.functionName = details.functionName;
		}
		if ("args" in details) {
			context.args = details.args;
		}
		if (Array.isArray(details.argNames)) {
			const argNames: string[] = [];
			for (const name of details.argNames) {
				if (typeof name === "string" && name.length > 0) {
					argNames.push(name);
				}
			}
			if (argNames.length > 0) {
				context.argNames = argNames;
			}
		}

		if (
			context.signature ||
			context.selector ||
			context.functionName ||
			context.args !== undefined
		) {
			return context;
		}
	}
	return null;
}

/**
 * Turn raw Solidity-style signatures (e.g. "execute(bytes,bytes[],uint256)")
 * into human-friendly labels (e.g. "Execute"). Used for Safe multisend per-call
 * rows where intent templates didn't match.
 */
function humanizeActionLabel(label: string): string {
	// Already a human sentence (contains a space) — keep as-is
	if (label.includes(" ")) return label;
	// Raw selector like "0xa9059cbb" — no useful info
	if (/^0x[0-9a-fA-F]+$/.test(label)) return "Contract call";
	// Solidity signature: "functionName(args...)" — extract and title-case the name
	const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\(/.exec(label);
	if (match?.[1]) {
		const name = match[1];
		// Title-case: "swapExactTokens" → "Swap exact tokens"
		const spaced = name
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/_/g, " ")
			.toLowerCase();
		return spaced.charAt(0).toUpperCase() + spaced.slice(1);
	}
	// camelCase without parens: "swapExactTokens" → "Swap exact tokens"
	if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label)) {
		const spaced = label
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/_/g, " ")
			.toLowerCase();
		return spaced.charAt(0).toUpperCase() + spaced.slice(1);
	}
	return label;
}

function improveApprovalIntentFromSimulation(result: AnalysisResult, base: string): string | null {
	if (!result.simulation?.success) return null;
	if (!base.toLowerCase().startsWith("approve")) return null;

	const approval = result.simulation.approvals.changes.find(
		(a) => (a.standard === "erc20" || a.standard === "permit2") && a.scope !== "all",
	);
	if (!approval) return null;

	const spenderLabel = formatSpenderLabel(approval.spender, result.contract.chain, result);
	const tokenLabel = formatTokenLabel(approval.token, approval.symbol);
	const amountLabel = formatApprovalAmountLabel(approval);

	return `${approval.standard === "permit2" ? "PERMIT2 " : ""}Allow ${spenderLabel} to spend up to ${amountLabel} ${tokenLabel}`;
}

function improveSwapIntentFromSimulation(result: AnalysisResult, base: string): string | null {
	if (!result.simulation?.success) return null;
	// We don't try to outsmart intent labels like "Approve"; for everything else, prefer
	// simulation-derived net in/out when it looks like a simple swap.
	if (base.toLowerCase().startsWith("approve")) return null;

	const changes = buildBalanceChangeItems(result.simulation, result.contract.chain);
	const ordered = orderBalanceChanges(changes);
	const negatives = ordered.filter((line) => line.trim().startsWith("-"));
	const positives = ordered.filter((line) => line.trim().startsWith("+"));
	if (negatives.length !== 1 || positives.length !== 1) return null;

	const sent = negatives[0]?.trim().replace(/^[-+]\s*/, "") ?? "";
	const received = positives[0]?.trim().replace(/^[-+]\s*/, "") ?? "";
	if (!sent || !received) return null;

	return `Swap ${sent} → ${received}`;
}

function findDecodedSignature(findings: Finding[]): string | null {
	for (const finding of findings) {
		if (finding.code !== "CALLDATA_DECODED") continue;
		if (!finding.details) continue;
		const details = finding.details;
		if (!isRecord(details)) continue;
		const signature = details.signature;
		if (typeof signature === "string" && signature.length > 0) {
			return signature;
		}
		const functionName = details.functionName;
		if (typeof functionName === "string" && functionName.length > 0) {
			return functionName;
		}
	}
	return null;
}

function isAddress(value: string): boolean {
	return ADDRESS_REGEX.test(value);
}

function formatCompactTokenLabel(token: string, symbol?: string): string {
	if (symbol && symbol.trim().length > 0) {
		return `${cleanLabel(symbol)} (${shortenAddress(token)})`;
	}
	return shortenAddress(token);
}

function formatCompactSpenderLabel(spender: string, chain: Chain, result?: AnalysisResult): string {
	if (result) {
		const protocolEntity = resolveKnownProtocolApprovalEntity(result, spender);
		if (protocolEntity) {
			return `${protocolEntity} (${formatEntityAddressPreview(spender)})`;
		}
	}

	const known = (KNOWN_SPENDERS[chain] ?? []).find(
		(entry) => entry.address.toLowerCase() === spender.toLowerCase(),
	);
	if (known) {
		return `${known.name} (${shortenAddress(spender)})`;
	}
	return shortenAddress(spender);
}

function parseBigIntValue(value: unknown): bigint | null {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		return BigInt(Math.trunc(value));
	}
	if (typeof value !== "string") return null;
	if (value.length === 0) return null;
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function findDecodedArgValue(context: DecodedCallContext, name: string): unknown {
	const args = context.args;
	if (isRecord(args)) {
		return args[name];
	}
	if (!Array.isArray(args)) return undefined;
	if (!context.argNames) return undefined;
	const index = context.argNames.indexOf(name);
	if (index === -1) return undefined;
	return args[index];
}

function decodedCallLooksLikeApproval(context: DecodedCallContext): boolean {
	const signature = context.signature?.toLowerCase() ?? "";
	const functionName = context.functionName?.toLowerCase() ?? "";
	return (
		signature.startsWith("approve(") ||
		signature.startsWith("permit(") ||
		functionName.startsWith("approve") ||
		functionName.startsWith("permit")
	);
}

function buildReadableApprovalActionLabel(
	result: AnalysisResult,
	decoded: DecodedCallContext | null,
): string | null {
	const simulationApproval = result.simulation?.approvals.changes.find(
		(approval) =>
			(approval.standard === "erc20" || approval.standard === "permit2") &&
			approval.scope !== "all",
	);
	const signature = decoded?.signature;
	const callSuffix = signature ? ` · call: ${signature}` : "";

	if (simulationApproval) {
		const tokenLabel = formatCompactTokenLabel(simulationApproval.token, simulationApproval.symbol);
		const spenderLabel = formatCompactSpenderLabel(
			simulationApproval.spender,
			result.contract.chain,
			result,
		);
		const amountLabel = formatApprovalAmountLabel(simulationApproval);
		const verb = simulationApproval.standard === "permit2" ? "Permit2 approve" : "Approve";
		return `${verb} · token: ${tokenLabel} · spender: ${spenderLabel} · amount: ${amountLabel}${callSuffix}`;
	}

	if (!decoded || !decodedCallLooksLikeApproval(decoded)) return null;
	const spenderValue = findDecodedArgValue(decoded, "spender");
	const amountValue =
		findDecodedArgValue(decoded, "amount") ?? findDecodedArgValue(decoded, "value");
	const spenderLabel =
		typeof spenderValue === "string" && isAddress(spenderValue)
			? formatCompactSpenderLabel(spenderValue, result.contract.chain, result)
			: "unknown";
	const amount = parseBigIntValue(amountValue);
	const knownToken = getKnownTokenMetadata(result.contract.address);
	const amountLabel =
		amount === null
			? "UNKNOWN"
			: amount === MAX_UINT160 || amount === MAX_UINT256
				? "UNLIMITED"
				: formatTokenAmount(amount, knownToken?.decimals);
	const tokenSymbol = knownToken?.symbol ?? result.contract.name;
	const tokenLabel = formatCompactTokenLabel(result.contract.address, tokenSymbol);
	const verb = decoded.functionName?.toLowerCase().startsWith("permit") ? "Permit" : "Approve";
	return `${verb} · token: ${tokenLabel} · spender: ${spenderLabel} · amount: ${amountLabel}${callSuffix}`;
}

function resolveReadableActionLabel(result: AnalysisResult): string {
	const decoded = findDecodedCallContext(result.findings);
	const readableApproval = buildReadableApprovalActionLabel(result, decoded);
	if (readableApproval) return readableApproval;
	return resolveActionLabel(result);
}

function decodedArgEntries(context: DecodedCallContext): Array<[string, unknown]> {
	if (context.args === undefined) return [];
	if (isRecord(context.args)) {
		return Object.entries(context.args);
	}
	if (!Array.isArray(context.args)) return [];

	const entries: Array<[string, unknown]> = [];
	for (let index = 0; index < context.args.length; index += 1) {
		const value = context.args[index];
		const name = context.argNames?.[index] ?? `arg${index}`;
		entries.push([name, value]);
	}
	return entries;
}

type DecodedPreviewContext = {
	contractAddress?: string;
};

function decodedArgLooksLikeAmount(argName: string): boolean {
	const normalized = argName.toLowerCase();
	return normalized.includes("amount") || normalized === "value" || normalized === "wad";
}

function formatDecodedAmountWithKnownToken(
	value: unknown,
	argName: string,
	context: DecodedPreviewContext,
): string | null {
	if (!decodedArgLooksLikeAmount(argName)) return null;
	const amount = parseBigIntValue(value);
	if (amount === null) return null;
	if (amount === MAX_UINT256 || amount === MAX_UINT160) return "MAX_UINT256";
	const metadata = getKnownTokenMetadata(context.contractAddress);
	if (!metadata) return null;
	return `${formatTokenAmount(amount, metadata.decimals)} ${metadata.symbol}`;
}

function summarizeDecodedArgValue(
	value: unknown,
	argName: string,
	context: DecodedPreviewContext,
): string | null {
	const tokenAmount = formatDecodedAmountWithKnownToken(value, argName, context);
	if (tokenAmount) {
		return tokenAmount;
	}

	if (typeof value === "string") {
		if (isAddress(value)) {
			return shortenAddress(value);
		}
		const cleaned = cleanLabel(value);
		if (cleaned.length === 0) return null;
		return cleaned.length > 24 ? `${cleaned.slice(0, 21)}…` : cleaned;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return null;
		return value.toString();
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}
	if (Array.isArray(value)) {
		return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
	}
	if (isRecord(value)) {
		return "{…}";
	}
	return null;
}

function formatDecodedArgsPreview(
	decoded: DecodedCallContext,
	context: DecodedPreviewContext,
	maxArgs = 3,
): string | null {
	const entries = decodedArgEntries(decoded);
	if (entries.length === 0) return null;

	const preview: string[] = [];
	for (const [name, value] of entries) {
		if (preview.length >= maxArgs) break;
		const summarized = summarizeDecodedArgValue(value, name, context);
		if (!summarized) continue;
		preview.push(`${name}=${summarized}`);
	}
	if (preview.length === 0) return null;
	if (entries.length > preview.length) {
		preview.push(`+${entries.length - preview.length} more`);
	}
	return preview.join(", ");
}

function formatDecodedCallContextLine(
	decoded: DecodedCallContext | null,
	context: DecodedPreviewContext,
): string | null {
	if (!decoded) return null;

	const parts: string[] = [];
	const signature = decoded.signature ?? decoded.functionName;
	if (signature) {
		parts.push(signature);
	}

	const argsPreview = formatDecodedArgsPreview(decoded, context);
	if (argsPreview) {
		parts.push(`args: ${argsPreview}`);
	}

	if (decoded.selector) {
		parts.push(`selector ${decoded.selector}`);
	}

	if (parts.length === 0) return null;
	return ` Decoded: ${parts.join(" · ")}`;
}

function cleanReasonPhrase(input: string): string {
	return cleanLabel(input).replace(/[.]+$/g, "");
}

function summarizeHexReasonData(data: string): string {
	if (data.length <= 34) return data;
	return `${data.slice(0, 18)}…${data.slice(-8)}`;
}

function knownErrorSelectorLabel(selector: string): string | null {
	const normalized = selector.toLowerCase();
	if (normalized === "0x4e487b71") return "panic(uint256)";
	if (normalized === "0x08c379a0") return "error(string)";
	return null;
}

function formatSelectorDetail(errorData: string): string {
	const normalized = errorData.toLowerCase();
	if (normalized.length <= 2) {
		return "selector unavailable";
	}

	const selector = normalized.slice(0, 10);
	const label = knownErrorSelectorLabel(selector);
	if (normalized.length === 10) {
		if (!label) return `selector ${selector}`;
		return `${label}, selector ${selector}`;
	}

	const data = summarizeHexReasonData(normalized);
	if (!label) return `selector ${selector}, data ${data}`;
	return `${label}, selector ${selector}, data ${data}`;
}

function userFacingSimulationFailureReason(reason: string): string {
	const normalized = cleanLabel(reason);
	if (!normalized) return normalized;
	if (/^anvil exited with code/i.test(normalized)) {
		return "Local simulation backend was unavailable.";
	}
	if (/timed out waiting for anvil rpc to start/i.test(normalized)) {
		return "Local simulation backend timed out.";
	}

	const executionRevertedCustomError = normalized.match(
		/^execution reverted:\s*custom error\s*(0x[a-f0-9]*)$/i,
	);
	if (executionRevertedCustomError) {
		const selector = executionRevertedCustomError[1];
		return `execution reverted due to a contract error (${formatSelectorDetail(selector)})`;
	}

	const customError = normalized.match(/^custom error\s*:?[\s]*(0x[a-f0-9]*)$/i);
	if (customError) {
		const selector = customError[1];
		return `contract reverted with a custom error (${formatSelectorDetail(selector)})`;
	}

	const executionRevertedHex = normalized.match(/^execution reverted:\s*(0x[a-f0-9]{8,})$/i);
	if (executionRevertedHex) {
		return `execution reverted with encoded error data (${summarizeHexReasonData(executionRevertedHex[1])})`;
	}

	if (/^0x[a-f0-9]{8,}$/i.test(normalized)) {
		return `contract reverted with encoded error data (${summarizeHexReasonData(normalized)})`;
	}

	return normalized;
}

function isSwapSpecificHint(reason: string): boolean {
	return reason.toLowerCase().includes("swaps often require non-zero eth value");
}

function decodedCallLooksLikeSwap(context: DecodedCallContext): boolean {
	const signature = context.signature?.toLowerCase() ?? "";
	const functionName = context.functionName?.toLowerCase() ?? "";
	return (
		signature.includes("swap") ||
		functionName.includes("swap") ||
		functionName.includes("exactinput") ||
		functionName.includes("exactoutput")
	);
}

function resultLooksLikeSwapAction(result: AnalysisResult): boolean {
	if (typeof result.intent === "string" && result.intent.toLowerCase().includes("swap")) {
		return true;
	}
	const decoded = findDecodedCallContext(result.findings);
	if (!decoded) return false;
	return decodedCallLooksLikeSwap(decoded);
}

function shouldIncludeSimulationReason(reason: string, result: AnalysisResult): boolean {
	if (!isSwapSpecificHint(reason)) return true;
	return resultLooksLikeSwapAction(result);
}

function collectDetailedInconclusiveReasons(result: AnalysisResult): string[] {
	const simulation = result.simulation;
	if (!simulation) return [];

	const reasons: string[] = [];
	const seen = new Set<string>();
	const addReason = (reason: string) => {
		const surfaced = userFacingSimulationFailureReason(reason);
		const cleaned = cleanReasonPhrase(surfaced);
		if (!cleaned) return;
		if (!shouldIncludeSimulationReason(cleaned, result)) return;
		const key = cleaned.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		reasons.push(cleaned);
	};

	for (const note of simulation.notes) {
		const normalized = cleanLabel(note);
		if (!normalized) continue;

		if (normalized.startsWith("Hint:")) {
			addReason(normalized.replace(/^Hint:\s*/, ""));
			continue;
		}
		if (normalized.startsWith("Unable to read pre-transaction")) {
			addReason(normalized);
			continue;
		}
		if (normalized.startsWith("Failed to read ERC-20")) {
			addReason(normalized);
			continue;
		}
		if (normalized.includes("budget")) {
			addReason(normalized);
			continue;
		}
		if (normalized.startsWith("Approval diff stage failed")) {
			addReason(normalized);
		}
	}

	if (simulation.balances.confidence !== "high") {
		addReason("balance coverage incomplete");
	}
	if (approvalCoverageIncomplete(result)) {
		addReason("approval coverage incomplete");
	}

	return reasons;
}

function extractCoverageReasons(result: AnalysisResult): string[] {
	const simulation = result.simulation;
	if (!simulation) return ["simulation data unavailable"];

	const reasons: string[] = [];
	if (!simulation.success) {
		const failureReason =
			typeof simulation.revertReason === "string" && simulation.revertReason.length > 0
				? userFacingSimulationFailureReason(simulation.revertReason)
				: "";
		reasons.push(`simulation didn't complete${failureReason ? ` (${failureReason})` : ""}`);
	}
	if (simulation.balances.confidence !== "high") {
		reasons.push("balance coverage incomplete");
	}
	if (approvalCoverageIncomplete(result)) {
		reasons.push("approval coverage incomplete");
	}
	if (reasons.length === 0) {
		reasons.push("simulation data incomplete");
	}
	return reasons;
}

function formatInconclusiveReason(result: AnalysisResult): string {
	const reasons = [...extractCoverageReasons(result)];
	const extras = collectDetailedInconclusiveReasons(result).filter(
		(reason) =>
			!reasons.some((coverageReason) => coverageReason.toLowerCase() === reason.toLowerCase()),
	);
	const details = [...reasons, ...extras].slice(0, 3);
	return details.join("; ");
}

function formatSimulationCoverageBlockReason(result: AnalysisResult): string {
	const coverage = extractCoverageReasons(result).join("; ");
	const notes = collectDetailedInconclusiveReasons(result)
		.filter(
			(reason) =>
				reason.toLowerCase() !== "balance coverage incomplete" &&
				reason.toLowerCase() !== "approval coverage incomplete",
		)
		.slice(0, 2);
	const suffix = notes.length > 0 ? ` Contributing notes: ${notes.join("; ")}.` : "";
	return `BLOCK — simulation coverage incomplete (${coverage}).${suffix}`;
}

function formatBalanceChangeLine(changes: string[]): string {
	const normalized = changes.map((change, index) => {
		const trimmed = change.trim();
		if (index === 0 && (trimmed.startsWith("- ") || trimmed.startsWith("+ "))) {
			return trimmed.slice(2);
		}
		return trimmed;
	});
	const first = changes[0]?.trim() ?? "";
	const bullet = first.startsWith("+") ? "+" : "-";
	return ` ${bullet} ${normalized.join(" / ")}`;
}

function orderBalanceChanges(changes: string[]): string[] {
	const negative = changes.filter((item) => item.trim().startsWith("-"));
	const positive = changes.filter((item) => item.trim().startsWith("+"));
	const other = changes.filter(
		(item) => !item.trim().startsWith("-") && !item.trim().startsWith("+"),
	);
	return [...negative, ...positive, ...other];
}

function sectionCoverageSuffix(level: SimulationConfidenceLevel | undefined): string {
	if (!level || level === "high") return "";
	if (level === "none") return " (data unavailable)";
	return " (incomplete)";
}

function balanceSectionCoverageSuffix(
	level: SimulationConfidenceLevel | undefined,
	approvalOnlyAction: boolean,
): string {
	const suffix = sectionCoverageSuffix(level);
	if (approvalOnlyAction && suffix === " (incomplete)") {
		return "";
	}
	return suffix;
}

function approvalDeltaFullyDecoded(
	approval: BalanceSimulationResult["approvals"]["changes"][number],
): boolean {
	if (approval.scope === "all") {
		return approval.previousApproved !== undefined;
	}
	if (approval.standard === "erc20" || approval.standard === "permit2") {
		return approval.amount !== undefined && approval.previousAmount !== undefined;
	}
	if (approval.tokenId !== undefined) {
		return approval.previousSpender !== undefined;
	}
	return false;
}

function approvalCoverageIncomplete(result: AnalysisResult): boolean {
	const simulation = result.simulation;
	if (!simulation || !simulation.success) return true;
	if (simulation.approvals.confidence === "high") return false;
	if (simulation.approvals.confidence === "none") return true;

	const approvalChanges = simulation.approvals.changes;
	if (approvalChanges.length === 0) return true;
	return !approvalChanges.every((approval) => approvalDeltaFullyDecoded(approval));
}

function approvalsSectionCoverageSuffix(result: AnalysisResult): string {
	const simulation = result.simulation;
	if (!simulation) {
		return approvalCoverageIncomplete(result) ? " (incomplete)" : "";
	}

	const confidenceSuffix = sectionCoverageSuffix(simulation.approvals.confidence);
	if (confidenceSuffix !== " (incomplete)") {
		return confidenceSuffix;
	}

	return approvalCoverageIncomplete(result) ? confidenceSuffix : "";
}

function isApprovalOnlyAction(result: AnalysisResult, hasCalldata: boolean): boolean {
	if (!hasCalldata) return false;
	const decoded = findDecodedCallContext(result.findings);
	if (decoded && decodedCallLooksLikeApproval(decoded)) return true;

	if (typeof result.intent === "string") {
		const normalizedIntent = result.intent.toLowerCase();
		if (normalizedIntent.startsWith("approve") || normalizedIntent.includes("approval")) {
			return true;
		}
	}

	const simulation = result.simulation;
	if (!simulation) return false;
	if (simulation.approvals.changes.length === 0) return false;
	if (simulation.nativeDiff !== undefined && simulation.nativeDiff !== 0n) return false;
	const hasNonZeroBalanceChanges =
		buildBalanceChangeItems(simulation, result.contract.chain).length > 0;
	return !hasNonZeroBalanceChanges;
}

function simulationIsUncertain(result: AnalysisResult, hasCalldata: boolean): boolean {
	if (!hasCalldata) return false;
	const simulation = result.simulation;
	if (!simulation || !simulation.success) return true;
	if (simulation.balances.confidence !== "high") return true;
	if (simulation.approvals.confidence !== "high") return true;
	return false;
}

function renderBalanceSection(
	result: AnalysisResult,
	hasCalldata: boolean,
	actorLabel: "You" | "Sender",
): string[] {
	const lines: string[] = [];
	const confidence = result.simulation?.balances.confidence;
	const approvalOnlyAction = isApprovalOnlyAction(result, hasCalldata);
	lines.push(` 💰 BALANCE CHANGES${balanceSectionCoverageSuffix(confidence, approvalOnlyAction)}`);

	if (!hasCalldata) {
		lines.push(COLORS.dim(" - Not available (no calldata)"));
		return lines;
	}
	if (!result.simulation) {
		if (approvalOnlyAction) {
			lines.push(COLORS.dim(` - ${APPROVAL_ONLY_BALANCE_LINE}`));
			return lines;
		}
		lines.push(COLORS.warning(" - Simulation data unavailable — treat with extra caution."));
		return lines;
	}
	if (!result.simulation.success) {
		const failureReason =
			typeof result.simulation.revertReason === "string"
				? userFacingSimulationFailureReason(result.simulation.revertReason)
				: "";
		const detail = failureReason ? ` (${failureReason})` : "";
		lines.push(COLORS.warning(` - Simulation didn't complete${detail}`));
		const hints = extractSimulationHints(result.simulation.notes, result);
		for (const hint of hints) {
			lines.push(COLORS.warning(` - ${hint}`));
		}
		const partialChanges = buildBalanceChangeItems(result.simulation, result.contract.chain);
		if (partialChanges.length > 0) {
			const ordered = orderBalanceChanges(partialChanges);
			lines.push(COLORS.warning(" - Partial estimates:"));
			lines.push(COLORS.warning(formatBalanceChangeLine(ordered)));
			return lines;
		}
		if (approvalOnlyAction) {
			lines.push(COLORS.dim(` - ${APPROVAL_ONLY_BALANCE_LINE}`));
			return lines;
		}
		lines.push(COLORS.warning(" - Balance changes unknown"));
		return lines;
	}

	const changes = buildBalanceChangeItems(result.simulation, result.contract.chain);
	if (changes.length === 0) {
		if (result.simulation.balances.confidence === "high") {
			lines.push(COLORS.dim(" - No net balance change detected"));
		} else if (approvalOnlyAction) {
			lines.push(COLORS.dim(` - ${APPROVAL_ONLY_BALANCE_LINE}`));
		} else {
			lines.push(
				COLORS.warning(" - Balance changes couldn't be fully verified — treat with extra caution."),
			);
		}
		return lines;
	}

	const ordered = orderBalanceChanges(changes);
	for (const item of ordered) {
		const trimmed = item.trim();
		if (trimmed.startsWith("-")) {
			lines.push(` - ${actorLabel} sent ${trimmed.replace(/^[-]\s*/, "")}`);
			continue;
		}
		if (trimmed.startsWith("+")) {
			lines.push(` - ${actorLabel} received ${trimmed.replace(/^[+]\s*/, "")}`);
			continue;
		}
		lines.push(` - ${trimmed}`);
	}

	return lines;
}

type RenderedApprovalItem = {
	text: string;
	detail?: string;
	isWarning: boolean;
	source: "calldata" | "simulation";
	isUnlimitedApproval?: boolean;
	key: string;
};

function buildApprovalItems(result: AnalysisResult): RenderedApprovalItem[] {
	const items = new Map<string, RenderedApprovalItem>();
	const simulation = result.simulation;

	if (simulation && simulation.approvals.changes.length > 0) {
		for (const approval of simulation.approvals.changes) {
			const item = formatSimulationApproval(result, approval);
			items.set(item.key.toLowerCase(), { ...item, source: "simulation" });
		}
	}

	if (items.size > 0) {
		return Array.from(items.values());
	}

	const tokenFallback = result.contract.name ?? result.contract.address;
	for (const finding of result.findings) {
		if (finding.code !== "UNLIMITED_APPROVAL") continue;
		const details = finding.details;
		const spender = details && typeof details.spender === "string" ? details.spender : undefined;
		const spenderLabel = spender
			? formatSpenderLabel(spender, result.contract.chain, result)
			: "unknown";
		const key = `${tokenFallback.toLowerCase()}|${spenderLabel.toLowerCase()}|calldata`;
		items.set(key, {
			text: `Allow ${spenderLabel} to spend UNLIMITED ${tokenFallback}`,
			isWarning: true,
			source: "calldata",
			isUnlimitedApproval: true,
			key,
		});
	}

	return Array.from(items.values());
}

function formatApprovalAmount(amount: bigint, decimals?: number): string {
	const dec = decimals ?? 18;
	const divisor = 10n ** BigInt(dec);
	const whole = amount / divisor;
	if (whole > 1_000_000_000n) return `${(Number(whole) / 1e9).toFixed(1)}B`;
	if (whole > 1_000_000n) return `${(Number(whole) / 1e6).toFixed(1)}M`;
	if (whole > 1_000n) return `${(Number(whole) / 1e3).toFixed(1)}K`;
	return whole.toString();
}

function renderApprovalsSection(result: AnalysisResult, hasCalldata: boolean): string[] {
	const lines: string[] = [];
	lines.push(` 🔐 APPROVALS${approvalsSectionCoverageSuffix(result)}`);
	if (!hasCalldata) {
		lines.push(COLORS.dim(" - Not available (no calldata)"));
		return lines;
	}

	const approvals = buildApprovalItems(result);
	const approvalsIncomplete = approvalCoverageIncomplete(result);
	if (approvals.length === 0) {
		if (approvalsIncomplete) {
			lines.push(COLORS.warning(" - Couldn't verify approvals — treat with extra caution."));
			return lines;
		}
		lines.push(COLORS.dim(" - None detected"));
		return lines;
	}

	if (approvalsIncomplete) {
		lines.push(COLORS.warning(" - Some approvals detected, but others may be missing:"));
	}

	for (const approval of approvals) {
		const prefix = approval.isWarning ? "⚠️" : "✓";
		const line = `${prefix} ${approval.text}`;
		lines.push(approval.isWarning ? ` ${COLORS.warning(line)}` : ` ${COLORS.ok(line)}`);
		if (approval.detail) {
			lines.push(`   ${COLORS.warning(`(${approval.detail})`)}`);
		}
	}

	if (approvals.some((approval) => approval.isUnlimitedApproval)) {
		lines.push(` ${COLORS.warning(UNLIMITED_APPROVAL_MITIGATION_LINE)}`);
	}
	return lines;
}

function contractVerificationState(result: AnalysisResult): "verified" | "unverified" | "unknown" {
	if (result.contract.verified) return "verified";
	const hasUnverifiedFinding = result.findings.some((finding) => finding.code === "UNVERIFIED");
	return hasUnverifiedFinding ? "unverified" : "unknown";
}

function formatChecksContextLine(result: AnalysisResult, mode: RenderMode): string {
	const verificationState = contractVerificationState(result);
	const ageDays = result.contract.age_days;
	const txCount = result.contract.tx_count;
	const ageMissing = ageDays === undefined;
	const txCountMissing = txCount === undefined;
	const ageLabel = ageMissing ? "age: —" : `age: ${ageDays}d`;
	const txCountLabel = txCountMissing
		? "txs: —"
		: `txs: ${new Intl.NumberFormat("en-US").format(txCount)}`;

	let metadataReason = "";
	if (ageMissing || txCountMissing) {
		if (mode === "wallet") {
			metadataReason = " · metadata: skipped in fast mode for latency";
		} else if (ageMissing && txCountMissing) {
			metadataReason = " · metadata: contract age/tx history unavailable from providers";
		} else if (ageMissing) {
			metadataReason = " · metadata: contract age unavailable from providers";
		} else {
			metadataReason = " · metadata: tx history unavailable from providers";
		}
	}

	return ` Context: ${verificationState} · ${ageLabel} · ${txCountLabel}${metadataReason}`;
}

function isChecksNoiseFinding(finding: Finding): boolean {
	return (
		finding.code === "CALLDATA_DECODED" ||
		finding.code === "CALLDATA_UNKNOWN_SELECTOR" ||
		finding.code === "CALLDATA_SIGNATURES" ||
		finding.code === "CALLDATA_EMPTY" ||
		finding.code === "VERIFIED" ||
		finding.code === "KNOWN_PROTOCOL"
	);
}

function hasProxyUpgradeableSignal(result: AnalysisResult): boolean {
	if (result.contract.is_proxy) return true;
	return result.findings.some(
		(finding) => finding.code === "PROXY" || finding.code === "UPGRADEABLE",
	);
}

function collectChecksFindings(result: AnalysisResult): Finding[] {
	const deduped = new Map<string, Finding>();
	const showProxyLine = hasProxyUpgradeableSignal(result);
	const plainEthTransfer = isPlainEthTransferResult(result);
	for (const finding of result.findings) {
		if (isChecksNoiseFinding(finding)) continue;
		if (plainEthTransfer && finding.code === "LOW_ACTIVITY") continue;
		if (showProxyLine && (finding.code === "PROXY" || finding.code === "UPGRADEABLE")) {
			continue;
		}
		const existing = deduped.get(finding.code);
		if (!existing || compareFindingsBySignal(finding, existing) < 0) {
			deduped.set(finding.code, finding);
		}
	}
	return Array.from(deduped.values()).sort(compareFindingsBySignal);
}

function renderChecksSection(
	result: AnalysisResult,
	verboseFindings: boolean,
	mode: RenderMode,
): string[] {
	const lines: string[] = [];
	lines.push(" 🧾 CHECKS");

	const contextLine = formatChecksContextLine(result, mode);
	const verificationState = contractVerificationState(result);
	if (verificationState === "verified" || isPlainEthTransferResult(result)) {
		lines.push(COLORS.dim(contextLine));
	} else {
		lines.push(COLORS.warning(contextLine));
	}

	if (isPlainEthTransferResult(result)) {
		lines.push(COLORS.ok(" ✓ Recipient is an EOA (native transfer)"));
	} else if (result.contract.verified) {
		lines.push(COLORS.ok(" ✓ Source verified"));
	} else {
		lines.push(COLORS.warning(" ⚠️ Source not verified (or unknown)"));
	}

	if (hasProxyUpgradeableSignal(result)) {
		lines.push(COLORS.warning(" ⚠️ Proxy / upgradeable (code can change)"));
	}

	if (result.protocolMatch?.name) {
		lines.push(COLORS.ok(` ✓ Known protocol: ${cleanLabel(result.protocolMatch.name)}`));
	}

	const ordered = collectChecksFindings(result);
	const visible = verboseFindings ? ordered : ordered.slice(0, CHECKS_FINDINGS_CAP);

	for (const finding of visible) {
		lines.push(` ${formatFindingLine(finding)}`);
	}

	if (!verboseFindings && ordered.length > visible.length) {
		const hiddenCount = ordered.length - visible.length;
		lines.push(COLORS.dim(` +${hiddenCount} more (use --verbose)`));
	}

	return lines;
}

type ExplorerLinkAccumulator = {
	labels: Set<string>;
	rank: number;
};

function addExplorerLink(
	links: Map<string, ExplorerLinkAccumulator>,
	address: string,
	label: string,
	rank: number,
): void {
	if (!isAddress(address)) return;
	const normalizedAddress = address.toLowerCase();
	const normalizedLabel = cleanLabel(label);
	if (normalizedLabel.length === 0) return;
	const existing = links.get(normalizedAddress);
	if (existing) {
		existing.labels.add(normalizedLabel);
		existing.rank = Math.min(existing.rank, rank);
		return;
	}
	links.set(normalizedAddress, {
		labels: new Set([normalizedLabel]),
		rank,
	});
}

function collectAddressValues(value: unknown, collector: Set<string>): void {
	if (typeof value === "string") {
		if (isAddress(value)) {
			collector.add(value);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectAddressValues(item, collector);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const item of Object.values(value)) {
		collectAddressValues(item, collector);
	}
}

function decodedArgRoleLabel(argName: string): string {
	const normalized = argName.toLowerCase();
	if (normalized.includes("spender")) return "Action spender";
	if (normalized.includes("token")) return "Action token";
	if (normalized.includes("recipient") || normalized === "to") return "Action recipient";
	if (normalized.includes("operator")) return "Action operator";
	if (normalized.includes("owner") || normalized.includes("from")) return "Action owner";
	return `Action ${argName}`;
}

function collectDecodedActionLinks(
	links: Map<string, ExplorerLinkAccumulator>,
	decoded: DecodedCallContext,
): void {
	if (decoded.args === undefined) return;

	if (isRecord(decoded.args)) {
		for (const [argName, value] of Object.entries(decoded.args)) {
			const found = new Set<string>();
			collectAddressValues(value, found);
			for (const address of found) {
				addExplorerLink(links, address, decodedArgRoleLabel(argName), 4);
			}
		}
		return;
	}

	if (!Array.isArray(decoded.args)) return;
	for (let index = 0; index < decoded.args.length; index += 1) {
		const value = decoded.args[index];
		const argName = decoded.argNames?.[index] ?? `arg${index}`;
		const found = new Set<string>();
		collectAddressValues(value, found);
		for (const address of found) {
			addExplorerLink(links, address, decodedArgRoleLabel(argName), 4);
		}
	}
}

function buildExplorerLinkEntries(
	result: AnalysisResult,
	policy?: PolicySummary,
): Array<{
	address: string;
	labels: string[];
}> {
	const links = new Map<string, ExplorerLinkAccumulator>();

	addExplorerLink(links, result.contract.address, "Contract", 0);
	if (result.contract.implementation) {
		addExplorerLink(links, result.contract.implementation, "Implementation", 1);
	}
	if (result.contract.beacon) {
		addExplorerLink(links, result.contract.beacon, "Beacon", 1);
	}

	for (const approval of result.simulation?.approvals.changes ?? []) {
		addExplorerLink(links, approval.token, "Token", 2);
		addExplorerLink(links, approval.spender, "Spender", 3);
	}

	for (const change of result.simulation?.balances.changes ?? []) {
		if (change.address) {
			addExplorerLink(links, change.address, "Balance token", 5);
		}
	}

	for (const finding of result.findings) {
		if (!finding.details || !isRecord(finding.details)) continue;
		if (finding.code === "UNLIMITED_APPROVAL") {
			const spender = finding.details.spender;
			if (typeof spender === "string") {
				addExplorerLink(links, spender, "Spender", 3);
			}
		}
	}

	const decoded = findDecodedCallContext(result.findings);
	if (decoded) {
		collectDecodedActionLinks(links, decoded);
	}

	for (const endpoint of policy?.allowlisted ?? []) {
		addExplorerLink(links, endpoint.address, `Allowlisted ${endpoint.role}`, 6);
	}
	for (const endpoint of policy?.nonAllowlisted ?? []) {
		addExplorerLink(links, endpoint.address, `Non-allowlisted ${endpoint.role}`, 6);
	}

	return Array.from(links.entries())
		.map(([address, value]) => ({
			address,
			labels: Array.from(value.labels),
			rank: value.rank,
		}))
		.sort((a, b) => {
			if (a.rank !== b.rank) {
				return a.rank - b.rank;
			}
			return a.address.localeCompare(b.address);
		})
		.map(({ address, labels }) => ({ address, labels }));
}

function renderExplorerLinksSection(
	result: AnalysisResult,
	hasCalldata: boolean,
	policy?: PolicySummary,
): string[] {
	if (!hasCalldata) return [];
	const links = buildExplorerLinkEntries(result, policy);
	if (links.length === 0) return [];

	const explorerBase = getChainConfig(result.contract.chain).etherscanUrl;
	const lines: string[] = [" 🔗 EXPLORER LINKS"];
	for (const link of links) {
		lines.push(` - ${link.labels.join(", ")}: ${explorerBase}/address/${link.address}`);
	}
	return lines;
}

type EffectivePolicyDecision = {
	decision: PolicyDecision;
	reason?: string;
};

function resolvePolicyDecision(
	result: AnalysisResult,
	hasCalldata: boolean,
	policy: PolicySummary,
): EffectivePolicyDecision {
	if (simulationIsUncertain(result, hasCalldata)) {
		return { decision: "BLOCK", reason: "simulation incomplete" };
	}
	if (policy.decision) {
		return { decision: policy.decision };
	}
	const nonAllowlisted = policy.nonAllowlisted ?? [];
	if (nonAllowlisted.length > 0) {
		return { decision: policy.mode === "wallet" ? "BLOCK" : "PROMPT" };
	}
	return { decision: "ALLOW" };
}

function resolveNextActionDecision(
	result: AnalysisResult,
	hasCalldata: boolean,
	policy?: PolicySummary,
): PolicyDecision {
	if (simulationIsUncertain(result, hasCalldata)) {
		return "BLOCK";
	}
	if (policy) {
		const effectivePolicy = resolvePolicyDecision(result, hasCalldata, policy);
		if (effectivePolicy.decision !== "ALLOW") {
			return effectivePolicy.decision;
		}
	}
	if (result.recommendation === "danger") {
		return "BLOCK";
	}
	if (result.recommendation === "warning" || result.recommendation === "caution") {
		return "PROMPT";
	}
	return "ALLOW";
}

function recommendationForDisplay(
	result: AnalysisResult,
	hasCalldata: boolean,
	policy?: PolicySummary,
): Recommendation {
	const nextAction = resolveNextActionDecision(result, hasCalldata, policy);
	if (nextAction === "BLOCK") {
		return "danger";
	}
	if (simulationIsUncertain(result, hasCalldata) && result.recommendation === "ok") {
		return "caution";
	}
	return result.recommendation;
}

function topCoverageBlocker(result: AnalysisResult): string {
	const blocker = extractCoverageReasons(result)[0] ?? "simulation data incomplete";
	return cleanReasonPhrase(blocker);
}

function buildRecommendationWhy(
	result: AnalysisResult,
	hasCalldata: boolean,
	mode: RenderMode,
	policy?: PolicySummary,
): string {
	const simulationUncertain = simulationIsUncertain(result, hasCalldata);
	if (simulationUncertain) {
		const blocker = topCoverageBlocker(result);
		return `Simulation coverage incomplete (top blocker: ${blocker}). Action: ${simulationCoverageAction(mode)}.`;
	}

	if (policy) {
		const effectivePolicy = resolvePolicyDecision(result, hasCalldata, policy);
		const hasNonAllowlisted = (policy.nonAllowlisted?.length ?? 0) > 0;
		if (effectivePolicy.decision === "BLOCK" && hasNonAllowlisted) {
			return "Policy blocked a non-allowlisted endpoint in this transaction.";
		}
		if (effectivePolicy.decision === "PROMPT" && hasNonAllowlisted) {
			return "Policy requires confirmation for a non-allowlisted endpoint.";
		}
	}

	if (result.contract.is_proxy) {
		return "Proxy / upgradeable contract detected — code can change post-deploy, so trust assumptions matter.";
	}

	const topFinding = collectChecksFindings(result)[0];
	if (topFinding) {
		if (topFinding.code === "UPGRADEABLE") {
			return "Upgradeable proxy detected — code can change post-deploy, so trust assumptions matter.";
		}
		return cleanLabel(topFinding.message);
	}

	const displayedRecommendation = recommendationForDisplay(result, hasCalldata, policy);
	if (displayedRecommendation === "ok") {
		return hasCalldata
			? "No high-risk findings; simulation and intent checks look consistent."
			: "No high-risk findings in the available contract checks.";
	}
	if (displayedRecommendation === "caution") {
		return "Some risky patterns were detected and should be verified before signing.";
	}
	if (displayedRecommendation === "warning") {
		return "Multiple risk signals need manual confirmation before signing.";
	}
	return "High-risk signals were detected in this transaction.";
}

function renderRecommendationSection(
	result: AnalysisResult,
	hasCalldata: boolean,
	mode: RenderMode,
	policy?: PolicySummary,
): string[] {
	const simulationUncertain = simulationIsUncertain(result, hasCalldata);
	const displayedRecommendation = recommendationForDisplay(result, hasCalldata, policy);
	const style = simulationUncertain
		? simulationCoverageBlockStyle()
		: recommendationStyle(displayedRecommendation);
	const lines: string[] = [];
	lines.push(` 🎯 RECOMMENDATION: ${style.color(`${style.icon} ${style.label}`)}`);
	lines.push(` Why: ${buildRecommendationWhy(result, hasCalldata, mode, policy)}`);
	return lines;
}

function renderPolicySection(
	result: AnalysisResult,
	hasCalldata: boolean,
	policy: PolicySummary,
): string[] {
	const lines: string[] = [];
	lines.push(" 🛡️ POLICY / ALLOWLIST");

	const allowlisted = policy.allowlisted ?? [];
	const nonAllowlisted = policy.nonAllowlisted ?? [];

	if (policy.allowedProtocol?.name) {
		const soft = policy.allowedProtocol.soft !== false;
		const softLabel = soft ? " (soft)" : "";
		lines.push(
			COLORS.ok(` ✓ Allowed protocol${softLabel}: ${cleanLabel(policy.allowedProtocol.name)}`),
		);
	}

	for (const endpoint of allowlisted) {
		const address = endpoint.address;
		const label = endpoint.label ? `${cleanLabel(endpoint.label)} (${address})` : address;
		lines.push(COLORS.ok(` ✓ Allowlisted ${endpoint.role}: ${label}`));
	}

	for (const endpoint of nonAllowlisted) {
		const address = endpoint.address;
		const label = endpoint.label ? `${cleanLabel(endpoint.label)} (${address})` : address;
		lines.push(COLORS.warning(` ⚠️ Non-allowlisted ${endpoint.role}: ${label}`));
	}

	const effectiveDecision = resolvePolicyDecision(result, hasCalldata, policy);
	const decisionLine = ` Policy decision: ${effectiveDecision.decision}${effectiveDecision.reason ? ` (${effectiveDecision.reason})` : ""}`;
	if (effectiveDecision.decision === "ALLOW") {
		lines.push(COLORS.ok(decisionLine));
	} else if (effectiveDecision.decision === "PROMPT") {
		lines.push(COLORS.warning(decisionLine));
	} else if (effectiveDecision.reason === "simulation incomplete") {
		lines.push(COLORS.warning(decisionLine));
	} else {
		lines.push(COLORS.danger(decisionLine));
	}

	return lines;
}

function renderVerdictSection(
	result: AnalysisResult,
	hasCalldata: boolean,
	mode: RenderMode,
	policy?: PolicySummary,
): string[] {
	const simulationUncertain = simulationIsUncertain(result, hasCalldata);
	const displayedRecommendation = recommendationForDisplay(result, hasCalldata, policy);
	const recommendation = simulationUncertain
		? simulationCoverageBlockStyle()
		: recommendationStyle(displayedRecommendation);
	const lines: string[] = [];
	lines.push(
		` 👉 VERDICT: ${recommendation.color(`${recommendation.icon} ${recommendation.label}`)}`,
	);

	const actionLine = buildNextActionLine(result, hasCalldata, policy);
	const shouldRenderInconclusiveLine =
		simulationUncertain && !actionLine.startsWith("BLOCK — simulation coverage incomplete");
	if (shouldRenderInconclusiveLine) {
		lines.push(COLORS.warning(` ⚠️ INCONCLUSIVE: ${formatInconclusiveReason(result)}`));
	}
	if (actionLine.includes("BLOCK")) {
		const blockColor = simulationUncertain ? COLORS.warning : COLORS.danger;
		lines.push(blockColor(` ${actionLine}`));
		if (simulationUncertain) {
			lines.push(COLORS.warning(` ${simulationCoverageNextStepLine(mode)}`));
		}
	} else if (actionLine.includes("PROMPT")) {
		lines.push(COLORS.warning(` ${actionLine}`));
	} else {
		lines.push(COLORS.ok(` ${actionLine}`));
	}

	return lines;
}

function buildNextActionLine(
	result: AnalysisResult,
	hasCalldata: boolean,
	policy?: PolicySummary,
): string {
	if (simulationIsUncertain(result, hasCalldata)) {
		return formatSimulationCoverageBlockReason(result);
	}

	if (policy) {
		const effectivePolicy = resolvePolicyDecision(result, hasCalldata, policy);
		if (effectivePolicy.decision === "BLOCK") {
			return "BLOCK — policy rules did not allow this transaction.";
		}
		if (effectivePolicy.decision === "PROMPT") {
			return "PROMPT + verify non-allowlisted spender/recipient before signing.";
		}
	}

	if (result.recommendation === "danger") {
		return "BLOCK — high-risk findings detected.";
	}
	if (result.recommendation === "warning") {
		return "PROMPT + verify spender/recipient and approval scope before signing.";
	}
	if (result.recommendation === "caution") {
		return "PROMPT + verify spender and amount before signing.";
	}
	return "SAFE to continue.";
}

// renderNextActionSection removed — merged into renderVerdictSection

type PolicyEndpointRole = "to" | "recipient" | "spender" | "operator";

type PolicyDecision = "ALLOW" | "PROMPT" | "BLOCK";

export interface PolicySummary {
	mode?: "wallet" | "cli";
	allowedProtocol?: {
		name: string;
		soft?: boolean;
	};
	allowlisted?: Array<{ role: PolicyEndpointRole; address: string; label?: string }>;
	nonAllowlisted?: Array<{ role: PolicyEndpointRole; address: string; label?: string }>;
	decision?: PolicyDecision;
}

/**
 * Clean assessment: everything is OK, no actionable findings, simulation is
 * conclusive. Under Marco's UX principle, clean assessments get compact output
 * (what's happening + verdict). Degraded assessments get full detail.
 */
function isCleanAssessment(result: AnalysisResult, hasCalldata: boolean): boolean {
	if (result.recommendation !== "ok") return false;
	if (simulationIsUncertain(result, hasCalldata)) return false;
	if (collectChecksFindings(result).length > 0) return false;
	return true;
}

export function renderResultBox(
	result: AnalysisResult,
	context?: {
		hasCalldata?: boolean;
		sender?: string;
		policy?: PolicySummary;
		mode?: RenderMode;
		verbose?: boolean;
		/** When set, long lines word-wrap to fit within this terminal width. */
		maxWidth?: number;
	},
): string {
	const hasCalldata = context?.hasCalldata ?? false;
	const actorLabel: "You" | "Sender" = context?.sender ? "You" : "Sender";
	const protocol = formatProtocolDisplay(result);
	const verboseFindings = context?.verbose ?? false;
	const renderMode: RenderMode =
		context?.mode === "wallet" || context?.policy?.mode === "wallet" ? "wallet" : "default";
	const protocolSuffix =
		result.protocolMatch?.slug && result.protocolMatch.slug !== protocol
			? COLORS.dim(` (${result.protocolMatch.slug})`)
			: "";
	const action = hasCalldata
		? renderMode === "wallet"
			? resolveReadableActionLabel(result)
			: resolveActionLabel(result)
		: "N/A";
	const decodedLine = hasCalldata
		? formatDecodedCallContextLine(findDecodedCallContext(result.findings), {
				contractAddress: result.contract.address,
			})
		: null;
	const contractLabel = formatContractLabel(result.contract);

	const headerLines = [
		...(renderMode === "wallet"
			? [COLORS.warning(" ⚡ FAST MODE — reduced provider coverage (Etherscan, GoPlus skipped)")]
			: []),
		` Chain: ${result.contract.chain}`,
		` Protocol: ${protocol}${protocolSuffix}`,
		...(hasCalldata ? [` Action: ${action}`] : []),
		...(decodedLine ? [decodedLine] : []),
		` Contract: ${contractLabel}`,
	];

	// Progressive disclosure: concise when assessment is strong, detailed when degraded.
	const compact = isCleanAssessment(result, hasCalldata) && !verboseFindings;

	if (compact) {
		const sections: string[][] = [];

		// Balance changes — only when there are actual changes to report
		if (hasCalldata && result.simulation?.success) {
			const changes = buildBalanceChangeItems(result.simulation, result.contract.chain);
			if (changes.length > 0) {
				sections.push(renderBalanceSection(result, hasCalldata, actorLabel));
			}
		}

		// Approvals — only when there are actual approval changes
		if (hasCalldata && buildApprovalItems(result).length > 0) {
			sections.push(renderApprovalsSection(result, hasCalldata));
		}

		const explorerLinks = renderExplorerLinksSection(result, hasCalldata, context?.policy);
		if (explorerLinks.length > 0) {
			sections.push(explorerLinks);
		}

		// Compact verdict: just the answer, no section header
		const verdictLabel = hasCalldata ? "SAFE to continue." : "No issues found.";
		sections.push([COLORS.ok(` ✅ ${verdictLabel}`)]);

		return renderUnifiedBox(headerLines, sections, context?.maxWidth);
	}

	// Full detail: assessment quality is degraded or --verbose requested
	const explorerLinks = renderExplorerLinksSection(result, hasCalldata, context?.policy);
	const sections = hasCalldata
		? [
				renderRecommendationSection(result, hasCalldata, renderMode, context?.policy),
				renderChecksSection(result, verboseFindings, renderMode),
				...(explorerLinks.length > 0 ? [explorerLinks] : []),
				...(context?.policy ? [renderPolicySection(result, hasCalldata, context.policy)] : []),
				renderBalanceSection(result, hasCalldata, actorLabel),
				renderApprovalsSection(result, hasCalldata),
				renderVerdictSection(result, hasCalldata, renderMode, context?.policy),
			]
		: [
				renderRecommendationSection(result, hasCalldata, renderMode, context?.policy),
				renderChecksSection(result, verboseFindings, renderMode),
				...(context?.policy ? [renderPolicySection(result, hasCalldata, context.policy)] : []),
				renderVerdictSection(result, hasCalldata, renderMode, context?.policy),
			];

	return renderUnifiedBox(headerLines, sections, context?.maxWidth);
}

function buildBalanceChangeItems(simulation: BalanceSimulationResult, chain: Chain): string[] {
	const items: string[] = [];
	if (simulation.nativeDiff && simulation.nativeDiff !== 0n) {
		const nativeItem = formatSignedAmount(simulation.nativeDiff, 18, nativeSymbol(chain));
		if (nativeItem) {
			items.push(nativeItem);
		}
	}

	const erc20Net = aggregateErc20(simulation.balances.changes);
	for (const change of erc20Net) {
		const symbol = change.symbol ?? change.address;
		const item = formatSignedAmount(change.amount, change.decimals, symbol);
		if (item) {
			items.push(item);
		}
	}

	for (const change of simulation.balances.changes) {
		if (change.assetType === "erc20") continue;
		const item = formatNftChange(change);
		if (item) {
			items.push(item);
		}
	}

	return items;
}

function aggregateErc20(
	changes: AssetChange[],
): { address: string; amount: bigint; symbol?: string; decimals?: number }[] {
	const net = new Map<string, { amount: bigint; symbol?: string; decimals?: number }>();
	for (const change of changes) {
		if (change.assetType !== "erc20") continue;
		if (!change.address || !change.amount) continue;
		const address = change.address.toLowerCase();
		const delta = change.direction === "out" ? -change.amount : change.amount;
		const existing = net.get(address);
		if (existing) {
			existing.amount += delta;
			if (!existing.symbol && change.symbol) {
				existing.symbol = change.symbol;
			}
			if (existing.decimals === undefined && change.decimals !== undefined) {
				existing.decimals = change.decimals;
			}
		} else {
			net.set(address, {
				amount: delta,
				symbol: change.symbol,
				decimals: change.decimals,
			});
		}
	}
	const results: { address: string; amount: bigint; symbol?: string; decimals?: number }[] = [];
	for (const [address, value] of net.entries()) {
		if (value.amount !== 0n) {
			results.push({
				address,
				amount: value.amount,
				symbol: value.symbol,
				decimals: value.decimals,
			});
		}
	}
	return results;
}

function formatSimulationApproval(
	result: AnalysisResult,
	approval: BalanceSimulationResult["approvals"]["changes"][number],
): {
	text: string;
	detail?: string;
	isWarning: boolean;
	isUnlimitedApproval?: boolean;
	key: string;
} {
	const spenderLabel = formatSpenderLabel(approval.spender, result.contract.chain, result);
	const tokenLabel = approval.symbol
		? `${cleanLabel(approval.symbol)} (${approval.token})`
		: approval.token;
	const prefix = approval.standard === "permit2" ? "PERMIT2 " : "";

	if (approval.scope === "all") {
		const approved = approval.approved !== false;
		const previous =
			approval.previousApproved === undefined
				? undefined
				: approval.previousApproved
					? "enabled"
					: "disabled";
		const action = approved
			? `${prefix}Grant ${spenderLabel} operator access for ALL ${tokenLabel}`
			: `${prefix}Revoke ${spenderLabel} operator access for ALL ${tokenLabel}`;
		return {
			text: previous ? `${action} (was ${previous})` : action,
			detail: previous === undefined ? "previous operator approval unknown" : undefined,
			isWarning: approved,
			key: `${approval.token.toLowerCase()}|${approval.spender.toLowerCase()}|all|${approved}`,
		};
	}

	if (
		approval.tokenId !== undefined &&
		approval.standard !== "erc20" &&
		approval.standard !== "permit2"
	) {
		const revoking = isZeroAddress(approval.spender);
		const previousSpender = approval.previousSpender
			? formatSpenderLabel(approval.previousSpender, result.contract.chain, result)
			: undefined;
		const action = revoking
			? `${prefix}Revoke ${tokenLabel} #${approval.tokenId.toString()} approval`
			: `${prefix}Approve ${tokenLabel} #${approval.tokenId.toString()} for ${spenderLabel}`;
		return {
			text: previousSpender ? `${action} (was ${previousSpender})` : action,
			detail: previousSpender ? undefined : "previous approved spender unknown",
			isWarning: !revoking,
			key: `${approval.token.toLowerCase()}|${approval.spender.toLowerCase()}|${approval.tokenId.toString()}`,
		};
	}

	const amount = approval.amount;
	const previousAmount = approval.previousAmount;
	const amountLabel = formatApprovalAmountLabel(approval);
	const previousLabel =
		previousAmount === undefined
			? undefined
			: formatAllowanceAmountLabel(approval.standard, previousAmount, approval.decimals);

	if (amount === undefined) {
		const action = `${prefix}Allow ${spenderLabel} to spend UNKNOWN ${tokenLabel}`;
		return {
			text: previousLabel ? `${action} (was ${previousLabel})` : action,
			detail: previousLabel === undefined ? "allowance amount unknown" : undefined,
			isWarning: true,
			key: `${approval.token.toLowerCase()}|${approval.spender.toLowerCase()}|amount|unknown`,
		};
	}

	if (amount === 0n) {
		const action = `${prefix}Revoke ${spenderLabel} spending of ${tokenLabel}`;
		return {
			text: previousLabel ? `${action} (was ${previousLabel})` : action,
			detail: previousLabel ? undefined : "previous allowance unknown",
			isWarning: false,
			key: `${approval.token.toLowerCase()}|${approval.spender.toLowerCase()}|amount|revoke`,
		};
	}

	const action = `${prefix}Allow ${spenderLabel} to spend ${amountLabel} ${tokenLabel}`;
	return {
		text: previousLabel ? `${action} (was ${previousLabel})` : action,
		detail: previousLabel ? undefined : "previous allowance unknown",
		isWarning: true,
		isUnlimitedApproval: amountLabel === "UNLIMITED",
		key: `${approval.token.toLowerCase()}|${approval.spender.toLowerCase()}|amount|${amountLabel}`,
	};
}

function extractSimulationHints(notes: string[], result: AnalysisResult): string[] {
	const hints = notes
		.filter((note) => note.startsWith("Hint:"))
		.map((hint) => userFacingSimulationFailureReason(hint.replace(/^Hint:\s*/, "")))
		.filter((hint) => shouldIncludeSimulationReason(hint, result));
	if (hints.length === 0) return [];
	return hints;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatNftChange(change: AssetChange): string | null {
	if (change.assetType !== "erc721" && change.assetType !== "erc1155") return null;
	const label = change.address ? change.address : change.assetType.toUpperCase();
	const tokenId = change.tokenId ? ` #${change.tokenId.toString()}` : "";
	if (change.assetType === "erc1155" && change.amount) {
		const signed = change.direction === "out" ? -change.amount : change.amount;
		const amount = formatSignedAmount(signed, 0, `${label}${tokenId}`);
		return amount;
	}
	const sign = change.direction === "out" ? "-" : "+";
	return `${sign} ${label}${tokenId}`;
}

function isDustDisplayAmount(amount: bigint, decimals: number | undefined): boolean {
	if (amount === 0n) return true;
	if (decimals === undefined) return false;
	if (decimals <= BALANCE_AMOUNT_FRACTION_DIGITS) return false;
	const threshold = 10n ** BigInt(decimals - BALANCE_AMOUNT_FRACTION_DIGITS);
	return amount < threshold;
}

function formatSignedAmount(
	amount: bigint,
	decimals: number | undefined,
	symbol: string,
): string | null {
	const sign = amount < 0n ? "-" : "+";
	const absolute = amount < 0n ? -amount : amount;
	if (isDustDisplayAmount(absolute, decimals)) return null;
	const formatted =
		decimals === undefined
			? formatNumberString(absolute.toString())
			: formatNumberString(formatFixed(absolute, decimals), BALANCE_AMOUNT_FRACTION_DIGITS);
	return `${sign} ${formatted} ${symbol}`;
}

function formatFixed(value: bigint, decimals: number): string {
	if (decimals <= 0) return value.toString();
	const base = value.toString().padStart(decimals + 1, "0");
	const index = base.length - decimals;
	const integer = base.slice(0, index);
	const fraction = base.slice(index);
	return `${integer}.${fraction}`;
}

function formatNumberString(value: string, maxFractionDigits?: number): string {
	const [rawInteger, rawFraction] = value.split(".");
	const integer = rawInteger && rawInteger.length > 0 ? rawInteger : "0";
	const formattedInt = new Intl.NumberFormat("en-US").format(BigInt(integer));
	if (!rawFraction || rawFraction.length === 0) {
		return formattedInt;
	}
	let fraction = rawFraction.replace(/0+$/, "");
	if (maxFractionDigits !== undefined && fraction.length > maxFractionDigits) {
		fraction = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
	}
	return fraction.length > 0 ? `${formattedInt}.${fraction}` : formattedInt;
}

function formatTokenLabel(token: string, symbol?: string): string {
	if (symbol && symbol.trim().length > 0) {
		return `${cleanLabel(symbol)} (${token})`;
	}
	return token;
}

function formatSpenderLabel(spender: string, chain: Chain, result?: AnalysisResult): string {
	if (result) {
		const protocolEntity = resolveKnownProtocolApprovalEntity(result, spender);
		if (protocolEntity) {
			return `${protocolEntity} (${formatEntityAddressPreview(spender)})`;
		}
	}

	const known = (KNOWN_SPENDERS[chain] ?? []).find(
		(entry) => entry.address.toLowerCase() === spender.toLowerCase(),
	);
	if (known) {
		return `${known.name} (${spender})`;
	}
	return spender;
}

function formatTokenAmount(amount: bigint, decimals: number | undefined): string {
	if (decimals === undefined) return formatNumberString(amount.toString());
	return formatNumberString(formatFixed(amount, decimals), 6);
}

function formatAllowanceAmountLabel(
	standard: "erc20" | "permit2" | "erc721" | "erc1155",
	amount: bigint,
	decimals: number | undefined,
): string {
	const isUnlimited = standard === "permit2" ? amount === MAX_UINT160 : amount === MAX_UINT256;
	if (isUnlimited) return "UNLIMITED";
	return formatTokenAmount(amount, decimals);
}

function formatApprovalAmountLabel(
	approval: BalanceSimulationResult["approvals"]["changes"][number],
): string {
	if (approval.amount === undefined) return "UNKNOWN";
	return formatAllowanceAmountLabel(approval.standard, approval.amount, approval.decimals);
}

function nativeSymbol(chain: Chain): string {
	return NATIVE_SYMBOLS[chain] ?? "ETH";
}

function isZeroAddress(address: string): boolean {
	return /^0x0{40}$/i.test(address);
}

function shortenAddress(address: string): string {
	if (address.length <= 10) return address;
	return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function renderApprovalBox(
	tx: ApprovalTx,
	chain: Chain,
	context: ApprovalContext | undefined,
	result: ApprovalAnalysisResult,
	maxWidth?: number,
): string {
	const { label, icon, color } = recommendationStyle(result.recommendation);
	const title = ` ${color(`${icon} ${label}`)}`;

	const approvalLines: string[] = [];
	approvalLines.push(` Token: ${tx.token}`);
	approvalLines.push(` Spender: ${tx.spender}`);
	approvalLines.push(` Amount: ${formatApprovalAmount(tx.amount, 18)}`);
	approvalLines.push(` Chain: ${chain}`);

	if (context?.expectedSpender) {
		approvalLines.push(COLORS.dim(` Expected: ${context.expectedSpender}`));
	}
	if (context?.calledContract) {
		approvalLines.push(COLORS.dim(` Called: ${context.calledContract}`));
	}

	const findingsLines: string[] = [];
	findingsLines.push(" Findings:");
	if (result.findings.length === 0) {
		findingsLines.push(COLORS.dim("  None"));
	} else {
		for (const finding of result.findings) {
			findingsLines.push(` ${formatFindingLine(finding)}`);
		}
		if (result.findings.some((finding) => finding.code === "UNLIMITED_APPROVAL")) {
			findingsLines.push(` ${COLORS.warning(UNLIMITED_APPROVAL_MITIGATION_LINE)}`);
		}
	}

	const spenderLines: string[] = [];
	const spenderLabel =
		result.spenderAnalysis.contract.name ?? result.spenderAnalysis.contract.address;
	spenderLines.push(` Spender contract: ${spenderLabel}`);
	const verifiedMark = result.spenderAnalysis.contract.verified
		? COLORS.ok("✓")
		: COLORS.danger("✗");
	spenderLines.push(` Verified: ${verifiedMark}`);
	if (result.spenderAnalysis.protocol) {
		spenderLines.push(` Protocol: ${result.spenderAnalysis.protocol}`);
	}
	if (result.spenderAnalysis.contract.age_days !== undefined) {
		spenderLines.push(COLORS.dim(` Age: ${result.spenderAnalysis.contract.age_days} days`));
	}
	const spenderRecommendation = recommendationStyle(result.spenderAnalysis.recommendation);
	spenderLines.push(` Recommendation: ${spenderRecommendation.color(spenderRecommendation.label)}`);

	return renderBox(title, [approvalLines, findingsLines, spenderLines], maxWidth);
}

// ---------------------------------------------------------------------------
// Safe Multisend summary rendering
// ---------------------------------------------------------------------------

export interface SafeCallResult {
	to: string;
	data?: string;
	operation?: number;
	analysis?: AnalysisResult;
	error?: string;
}

function worstRecommendation(recommendations: Recommendation[]): Recommendation {
	const order: Recommendation[] = ["ok", "caution", "warning", "danger"];
	let worst = 0;
	for (const rec of recommendations) {
		const idx = order.indexOf(rec);
		if (idx > worst) worst = idx;
	}
	return order[worst] ?? "ok";
}

function callOperationSuffix(operation: number | undefined): string {
	return operation === 1 ? " [DELEGATECALL]" : "";
}

function resolveSafeTargetLabel(call: SafeCallResult, chain: Chain): string {
	const analyzedAddress = call.analysis?.contract?.address ?? call.to;
	const analyzedName = call.analysis?.contract?.name;
	if (analyzedName) {
		return `${cleanLabel(analyzedName)} (${shortenAddress(analyzedAddress)})`;
	}

	const tokenMetadata = getKnownTokenMetadata(call.to);
	if (tokenMetadata) {
		return `${tokenMetadata.symbol} (${shortenAddress(call.to)})`;
	}

	const knownSpender = (KNOWN_SPENDERS[chain] ?? []).find(
		(entry) => entry.address.toLowerCase() === call.to.toLowerCase(),
	);
	if (knownSpender) {
		return `${knownSpender.name} (${shortenAddress(call.to)})`;
	}

	return shortenAddress(call.to);
}

function resolveOfflineCallActionLabel(call: SafeCallResult): string {
	if (!call.data || call.data === "0x") return "";
	const decoded = decodeKnownCalldata(call.data);
	if (!decoded) return "";

	const tokenMetadata = getKnownTokenMetadata(call.to);
	const intent = buildIntent(decoded, {
		contractAddress: call.to,
		contractName: tokenMetadata?.symbol,
	});
	if (intent) {
		return intent;
	}

	const signature = decoded.signature ?? decoded.functionName;
	return humanizeActionLabel(signature);
}

function resolveCallActionLabel(call: SafeCallResult, hasCalldata: boolean): string {
	if (!hasCalldata) return "";
	if (call.analysis) {
		const label = resolveActionLabel(call.analysis);
		if (label === "Unknown action") return "";
		return humanizeActionLabel(label);
	}
	return resolveOfflineCallActionLabel(call);
}

function formatCallSummaryLines(
	index: number,
	call: SafeCallResult,
	hasCalldata: boolean,
	chain: Chain,
): string[] {
	const { analysis } = call;
	const target = resolveSafeTargetLabel(call, chain);
	const action = resolveCallActionLabel(call, hasCalldata);
	const intent = action ? ` · ${action}` : "";
	const operation = callOperationSuffix(call.operation);
	const headerLine = ` Call ${index + 1}${operation} → ${target}${intent}`;

	if (!analysis) {
		const reason = call.error ? ` (${call.error})` : "";
		return [headerLine, COLORS.dim(`   Analysis unavailable${reason}`)];
	}

	const style = recommendationStyle(analysis.recommendation);
	const topFinding = collectChecksFindings(analysis)[0];
	const reason = topFinding ? ` — ${cleanLabel(topFinding.message)}` : "";
	return [headerLine, `   ${style.color(`${style.icon} ${style.label}`)}${reason}`];
}

/** Single-line per-call row: target · action  badge */
function formatCallOneLiner(
	index: number,
	call: SafeCallResult,
	hasCalldata: boolean,
	chain: Chain,
): string {
	const { analysis } = call;
	const target = resolveSafeTargetLabel(call, chain);
	const action = resolveCallActionLabel(call, hasCalldata);
	const intent = action ? ` · ${action}` : "";
	const operation = callOperationSuffix(call.operation);

	if (!analysis) {
		const reason = call.error ? COLORS.dim(` (${call.error})`) : "";
		return ` Call ${index + 1}${operation} → ${target}${intent}${reason}`;
	}

	const style = recommendationStyle(analysis.recommendation);
	return ` Call ${index + 1}${operation} → ${target}${intent}  ${style.color(style.icon)}`;
}

/** Real-time progress line emitted as each call completes during parallel analysis. */
export function renderCallProgressLine(
	index: number,
	result: SafeCallResult,
	totalCalls: number,
	chain: Chain,
): string {
	const { analysis } = result;
	const target = resolveSafeTargetLabel(result, chain);
	const action = resolveCallActionLabel(result, true);
	const intent = action ? ` · ${action}` : "";
	const label = `Call ${index + 1}/${totalCalls}`;
	const operation = callOperationSuffix(result.operation);

	if (result.error) {
		const short = result.error.length > 50 ? `${result.error.slice(0, 50)}…` : result.error;
		return `  ${COLORS.danger("✗")} ${label}${operation} → ${target}${intent}  ${COLORS.dim(`(${short})`)}`;
	}

	if (!analysis) {
		return `  ${COLORS.dim("◌")} ${label}${operation} → ${target}${intent}`;
	}

	const style = recommendationStyle(analysis.recommendation);
	return `  ${COLORS.ok("✓")} ${label}${operation} → ${target}${intent}  ${style.color(style.icon)}`;
}

function buildSafeOverallWhy(calls: SafeCallResult[]): string {
	const analyzed = calls.filter((c) => c.analysis);
	if (analyzed.length === 0) return "No analysis available.";
	const worst = analyzed.reduce(
		(prev, curr) => {
			if (!curr.analysis) return prev;
			if (!prev) return curr;
			const order: Recommendation[] = ["ok", "caution", "warning", "danger"];
			return order.indexOf(curr.analysis.recommendation) >
				order.indexOf(prev.analysis?.recommendation ?? "ok")
				? curr
				: prev;
		},
		undefined as SafeCallResult | undefined,
	);
	if (!worst?.analysis) return "No analysis available.";
	const topFinding = collectChecksFindings(worst.analysis)[0];
	if (topFinding) return cleanLabel(topFinding.message);
	if (worst.analysis.recommendation === "ok") {
		return "All calls passed checks.";
	}
	return "Some calls have risk patterns; review before signing.";
}

function buildSafeVerdictLine(overall: Recommendation): string {
	if (overall === "danger") return "BLOCK — high-risk findings in one or more calls.";
	if (overall === "warning") return "PROMPT + review each call before signing.";
	if (overall === "caution") return "PROMPT + verify targets and amounts before signing.";
	return "SAFE to continue.";
}

// ---------------------------------------------------------------------------
// Aggregate balance/approval across Safe sub-calls
// ---------------------------------------------------------------------------

function worstConfidenceOf(
	calls: SafeCallResult[],
	accessor: (sim: BalanceSimulationResult) => SimulationConfidenceLevel,
): SimulationConfidenceLevel {
	const order: SimulationConfidenceLevel[] = ["high", "medium", "low", "none"];
	let worst = 0;
	for (const call of calls) {
		if (!call.analysis?.simulation) continue;
		const idx = order.indexOf(accessor(call.analysis.simulation));
		if (idx > worst) worst = idx;
	}
	return order[worst] ?? "high";
}

function buildAggregateSafeBalanceSection(
	calls: SafeCallResult[],
	chain: Chain,
	actorLabel: "You" | "Sender",
): string[] {
	const allChanges: AssetChange[] = [];
	let nativeDiff = 0n;
	let anyFailed = false;
	let anyMissing = false;

	for (const call of calls) {
		if (!call.analysis?.simulation) {
			anyMissing = true;
			continue;
		}
		const sim = call.analysis.simulation;
		if (!sim.success) {
			anyFailed = true;
			continue;
		}
		if (sim.nativeDiff) nativeDiff += sim.nativeDiff;
		allChanges.push(...sim.balances.changes);
	}

	const worstConf = worstConfidenceOf(calls, (s) => s.balances.confidence);
	const lines: string[] = [];
	lines.push(` 💰 BALANCE CHANGES${sectionCoverageSuffix(worstConf)}`);

	if (anyFailed) {
		lines.push(
			COLORS.warning(" - Some simulations didn't complete — balance impact may be incomplete."),
		);
	} else if (anyMissing) {
		lines.push(
			COLORS.warning(" - Some calls couldn't be analyzed — balance impact may be incomplete."),
		);
	}

	const items: string[] = [];
	if (nativeDiff !== 0n) {
		const nativeItem = formatSignedAmount(nativeDiff, 18, nativeSymbol(chain));
		if (nativeItem) {
			items.push(nativeItem);
		}
	}
	const erc20Net = aggregateErc20(allChanges);
	for (const change of erc20Net) {
		const symbol = change.symbol ?? shortenAddress(change.address);
		const item = formatSignedAmount(change.amount, change.decimals, symbol);
		if (item) {
			items.push(item);
		}
	}
	for (const change of allChanges) {
		if (change.assetType === "erc20") continue;
		const item = formatNftChange(change);
		if (item) items.push(item);
	}

	if (items.length === 0 && !anyFailed && !anyMissing) {
		lines.push(COLORS.dim(" - No net balance change detected"));
		return lines;
	}

	const ordered = orderBalanceChanges(items);
	for (const item of ordered) {
		const trimmed = item.trim();
		if (trimmed.startsWith("-")) {
			lines.push(` - ${actorLabel} sent ${trimmed.replace(/^[-]\s*/, "")}`);
		} else if (trimmed.startsWith("+")) {
			lines.push(` - ${actorLabel} received ${trimmed.replace(/^[+]\s*/, "")}`);
		} else {
			lines.push(` - ${trimmed}`);
		}
	}
	return lines;
}

function buildAggregateSafeApprovalSection(calls: SafeCallResult[]): string[] {
	const allItems: RenderedApprovalItem[] = [];
	const seen = new Set<string>();
	const decodedApprovals: BalanceSimulationResult["approvals"]["changes"] = [];

	for (const call of calls) {
		if (!call.analysis) continue;
		const simulationApprovals = call.analysis.simulation?.approvals.changes;
		if (simulationApprovals) {
			decodedApprovals.push(...simulationApprovals);
		}
		const items = buildApprovalItems(call.analysis);
		for (const item of items) {
			const key = item.key.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			allItems.push(item);
		}
	}

	if (allItems.length === 0) return [];

	const worstConf = worstConfidenceOf(calls, (s) => s.approvals.confidence);
	const confidenceSuffix = sectionCoverageSuffix(worstConf);
	const showIncompleteSuffix =
		confidenceSuffix !== " (incomplete)" ||
		decodedApprovals.length === 0 ||
		!decodedApprovals.every((approval) => approvalDeltaFullyDecoded(approval));
	const lines: string[] = [];
	lines.push(` 🔐 APPROVALS${showIncompleteSuffix ? confidenceSuffix : ""}`);

	for (const approval of allItems) {
		const prefix = approval.isWarning ? "⚠️" : "✓";
		const line = `${prefix} ${approval.text}`;
		lines.push(approval.isWarning ? ` ${COLORS.warning(line)}` : ` ${COLORS.ok(line)}`);
		if (approval.detail) {
			lines.push(`   ${COLORS.warning(`(${approval.detail})`)}`);
		}
	}

	if (allItems.some((approval) => approval.isUnlimitedApproval)) {
		lines.push(` ${COLORS.warning(UNLIMITED_APPROVAL_MITIGATION_LINE)}`);
	}
	return lines;
}

function safeCallsHaveBalanceChanges(calls: SafeCallResult[]): boolean {
	for (const call of calls) {
		if (!call.analysis?.simulation?.success) continue;
		const sim = call.analysis.simulation;
		if (sim.nativeDiff && sim.nativeDiff !== 0n) return true;
		if (aggregateErc20(sim.balances.changes).length > 0) return true;
		if (sim.balances.changes.some((c) => c.assetType !== "erc20")) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------

export function renderSafeSummaryBox(options: {
	chain: Chain;
	safe: string;
	kind: string;
	calls: SafeCallResult[];
	safeTxHash?: string;
	verbose?: boolean;
	maxWidth?: number;
}): string {
	const { chain, safe, kind, calls, verbose, maxWidth, safeTxHash } = options;
	const callCount = calls.length;
	const typeLabel = kind === "single" ? "Single call" : "Multisend";

	const headerLines = [
		` ${typeLabel} · ${shortenAddress(safe)}`,
		` Chain: ${chain} · ${callCount} call${callCount !== 1 ? "s" : ""}`,
	];
	if (verbose && safeTxHash) {
		headerLines.push(COLORS.dim(` SafeTxHash: ${safeTxHash}`));
	}

	const analyzed = calls.filter((c) => c.analysis);
	const recommendations = analyzed
		.map((c) => c.analysis?.recommendation)
		.filter((r): r is Recommendation => r !== undefined);
	const overall = recommendations.length > 0 ? worstRecommendation(recommendations) : undefined;

	const allClean =
		analyzed.length > 0 &&
		analyzed.length === calls.length &&
		analyzed.every((c) => c.analysis && isCleanAssessment(c.analysis, true));
	const compact = allClean && !verbose;

	const sections: string[][] = [];

	// Per-call rows — always shown (one-liners default, multi-line verbose)
	if (verbose) {
		const callLines: string[] = [];
		for (let i = 0; i < calls.length; i++) {
			const lines = formatCallSummaryLines(i, calls[i], true, chain);
			if (i > 0) callLines.push("");
			callLines.push(...lines);
		}
		sections.push(callLines);
	} else {
		const callLines = calls.map((c, i) => formatCallOneLiner(i, c, true, chain));
		sections.push(callLines);
	}

	if (analyzed.length === 0) {
		// No analysis (offline) — explain why after call list
		sections.push([
			COLORS.dim(" ℹ️  Risk analysis requires network access."),
			COLORS.dim("    Run without --offline for full scan."),
		]);
	} else if (compact) {
		// Clean: aggregate balance impact (if any) + verdict
		if (safeCallsHaveBalanceChanges(calls)) {
			sections.push(buildAggregateSafeBalanceSection(calls, chain, "You"));
		}
		const approvals = buildAggregateSafeApprovalSection(calls);
		if (approvals.length > 0) {
			sections.push(approvals);
		}
		sections.push([COLORS.ok(" ✅ SAFE to continue.")]);
	} else {
		// Degraded: recommendation + aggregate impact + verdict
		const style = recommendationStyle(overall ?? "caution");
		sections.push([
			` 🎯 RECOMMENDATION: ${style.color(`${style.icon} ${style.label}`)}`,
			` Why: ${buildSafeOverallWhy(calls)}`,
		]);

		sections.push(buildAggregateSafeBalanceSection(calls, chain, "You"));

		const approvals = buildAggregateSafeApprovalSection(calls);
		if (approvals.length > 0) {
			sections.push(approvals);
		}

		const verdictStyle = recommendationStyle(overall ?? "caution");
		const verdictLines = [
			` 👉 VERDICT: ${verdictStyle.color(`${verdictStyle.icon} ${verdictStyle.label}`)}`,
		];
		const actionLine = buildSafeVerdictLine(overall ?? "caution");
		if (actionLine.includes("BLOCK")) {
			verdictLines.push(COLORS.danger(` ${actionLine}`));
		} else if (actionLine.includes("PROMPT")) {
			verdictLines.push(COLORS.warning(` ${actionLine}`));
		} else {
			verdictLines.push(COLORS.ok(` ${actionLine}`));
		}
		sections.push(verdictLines);
	}

	return renderUnifiedBox(headerLines, sections, maxWidth);
}

export function renderHeading(text: string): string {
	return COLORS.dim(text);
}

export function renderError(text: string): string {
	return COLORS.danger(text);
}
