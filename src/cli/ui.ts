import pc from "picocolors";
import { KNOWN_SPENDERS } from "../approvals/known-spenders";
import { MAX_UINT160, MAX_UINT256 } from "../constants";
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

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
const NATIVE_SYMBOLS: Record<Chain, string> = {
	ethereum: "ETH",
	base: "ETH",
	arbitrum: "ETH",
	optimism: "ETH",
	polygon: "MATIC",
};

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

export function createProgressRenderer(enabled: boolean) {
	const spinner = new Spinner(enabled);
	const activeProviders: string[] = [];

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

	const message = `${style.icon} ${finding.message}`;
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

	while (visibleLength(remaining) > maxWidth) {
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

		const breakByte = lastSpaceByte > 0 ? lastSpaceByte : i;
		const skipByte = lastSpaceByte > 0 ? lastSpaceByte + 1 : i;

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

function renderBox(title: string, sections: string[][], maxWidth?: number): string {
	// Box chrome takes 4 visible columns: "│ " (2) + " │" (2)
	const contentMax = maxWidth !== undefined ? maxWidth - 4 : undefined;

	const wrappedTitle = contentMax ? wrapBoxLine(title, contentMax) : [title];
	const wrappedSections = sections.map((s) => wrapAllLines(s, contentMax));

	const allLines = [...wrappedTitle, ...wrappedSections.flat()];
	const width = allLines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
	const horizontal = "─".repeat(width + 2);

	const top = `┌${horizontal}┐`;
	const bottom = `└${horizontal}┘`;
	const divider = `├${horizontal}┤`;

	const lines: string[] = [top];
	for (const t of wrappedTitle) {
		lines.push(`│ ${padRight(t, width)} │`);
	}
	wrappedSections.forEach((section, index) => {
		lines.push(divider);
		for (const line of section) {
			lines.push(`│ ${padRight(line, width)} │`);
		}
		if (index === wrappedSections.length - 1) {
			return;
		}
	});
	lines.push(bottom);
	return lines.join("\n");
}

function renderUnifiedBox(headerLines: string[], sections: string[][], maxWidth?: number): string {
	// Box chrome takes 4 visible columns: "│ " (2) + " │" (2)
	const contentMax = maxWidth !== undefined ? maxWidth - 4 : undefined;

	const wrappedHeaders = wrapAllLines(headerLines, contentMax);
	const wrappedSections = sections.map((s) => wrapAllLines(s, contentMax));

	const allLines = [...wrappedHeaders, ...wrappedSections.flat()];
	const width = allLines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
	const horizontal = "─".repeat(width + 2);

	const top = `┌${horizontal}┐`;
	const bottom = `└${horizontal}┘`;
	const divider = `├${horizontal}┤`;

	const lines: string[] = [top];
	for (const line of wrappedHeaders) {
		lines.push(`│ ${padRight(line, width)} │`);
	}
	wrappedSections.forEach((section) => {
		lines.push(divider);
		for (const line of section) {
			lines.push(`│ ${padRight(line, width)} │`);
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

function formatContractLabel(contract: AnalysisResult["contract"]): string {
	if (contract.is_proxy && contract.proxy_name) {
		const proxyName = cleanLabel(contract.proxy_name);
		const implementationName =
			(contract.implementation_name ? cleanLabel(contract.implementation_name) : undefined) ??
			(contract.implementation ? shortenAddress(contract.implementation) : "implementation");
		return `${proxyName} → ${implementationName}`;
	}
	return contract.name ? cleanLabel(contract.name) : contract.address;
}

function resolveActionLabel(result: AnalysisResult): string {
	const base = result.intent ?? findDecodedSignature(result.findings) ?? "Unknown action";
	const improvedApproval = improveApprovalIntentFromSimulation(result, base);
	if (improvedApproval) return improvedApproval;

	const improvedSwap = improveSwapIntentFromSimulation(result, base);
	if (improvedSwap) return improvedSwap;

	return base;
}

function improveApprovalIntentFromSimulation(result: AnalysisResult, base: string): string | null {
	if (!result.simulation?.success) return null;
	if (!base.toLowerCase().startsWith("approve")) return null;

	const approval = result.simulation.approvals.changes.find(
		(a) => (a.standard === "erc20" || a.standard === "permit2") && a.scope !== "all",
	);
	if (!approval) return null;

	const spenderLabel = formatSpenderLabel(approval.spender, result.contract.chain);
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

function formatInconclusiveReason(result: AnalysisResult): string {
	const simulation = result.simulation;
	if (!simulation) {
		return "simulation unavailable";
	}
	if (!simulation.success) {
		return `simulation failed${simulation.revertReason ? ` (${simulation.revertReason})` : ""}`;
	}

	const reasons: string[] = [];
	if (simulation.balances.confidence !== "high") {
		reasons.push(`balances ${simulation.balances.confidence} confidence`);
	}
	if (simulation.approvals.confidence !== "high") {
		reasons.push(`approvals ${simulation.approvals.confidence} confidence`);
	}
	if (reasons.length === 0) {
		return "simulation confidence below high";
	}
	return reasons.join("; ");
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
	if (level === "none") return " (coverage: unavailable)";
	return ` (coverage: ${level})`;
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
	lines.push(` 💰 BALANCE CHANGES${sectionCoverageSuffix(confidence)}`);

	if (!hasCalldata) {
		lines.push(COLORS.dim(" - Not available (no calldata)"));
		return lines;
	}
	if (!result.simulation) {
		lines.push(COLORS.warning(" - Simulation data unavailable; treat this as higher risk."));
		return lines;
	}
	if (!result.simulation.success) {
		const detail = result.simulation.revertReason ? ` (${result.simulation.revertReason})` : "";
		lines.push(COLORS.warning(` - Simulation did not complete${detail}`));
		const hints = extractSimulationHints(result.simulation.notes);
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
		lines.push(COLORS.warning(" - Balance changes unknown"));
		return lines;
	}

	const changes = buildBalanceChangeItems(result.simulation, result.contract.chain);
	if (changes.length === 0) {
		if (result.simulation.balances.confidence === "high") {
			lines.push(COLORS.dim(" - No balance changes detected"));
		} else {
			lines.push(
				COLORS.warning(" - Could not verify all balance changes; treat this as higher risk."),
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
	key: string;
};

function buildApprovalItems(result: AnalysisResult): RenderedApprovalItem[] {
	const items = new Map<string, RenderedApprovalItem>();
	const simulation = result.simulation;

	if (simulation && simulation.approvals.changes.length > 0) {
		for (const approval of simulation.approvals.changes) {
			const item = formatSimulationApproval(approval, result.contract.chain);
			items.set(item.key.toLowerCase(), { ...item, source: "simulation" });
		}
	}

	if (items.size > 0) {
		return Array.from(items.values());
	}

	const tokenFallback = result.contract.name ?? shortenAddress(result.contract.address);
	for (const finding of result.findings) {
		if (finding.code !== "UNLIMITED_APPROVAL") continue;
		const details = finding.details;
		const spender = details && typeof details.spender === "string" ? details.spender : undefined;
		const spenderLabel = spender ? shortenAddress(spender) : "unknown";
		const key = `${tokenFallback.toLowerCase()}|${spenderLabel.toLowerCase()}|calldata`;
		items.set(key, {
			text: `Allow ${spenderLabel} to spend UNLIMITED ${tokenFallback}`,
			isWarning: true,
			source: "calldata",
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
	const confidence = result.simulation?.approvals.confidence;
	lines.push(` 🔐 APPROVALS${sectionCoverageSuffix(confidence)}`);
	if (!hasCalldata) {
		lines.push(COLORS.dim(" - Not available (no calldata)"));
		return lines;
	}

	const approvals = buildApprovalItems(result);
	const simulationFailed = !result.simulation || !result.simulation.success;
	if (simulationFailed) {
		if (approvals.length === 0) {
			lines.push(
				COLORS.warning(" - Could not verify approval changes; treat this as higher risk."),
			);
			return lines;
		}
		lines.push(
			COLORS.warning(" - Partial approvals observed; treat unknown approvals as higher risk:"),
		);
	}
	if (approvals.length === 0) {
		if (result.simulation && result.simulation.approvals.confidence !== "high") {
			lines.push(COLORS.warning(" - Approval coverage is incomplete; treat this as higher risk."));
			return lines;
		}
		lines.push(COLORS.dim(" - None detected"));
		return lines;
	}

	for (const approval of approvals) {
		const prefix = approval.isWarning ? "⚠️" : "✓";
		const line = `${prefix} ${approval.text}`;
		lines.push(approval.isWarning ? ` ${COLORS.warning(line)}` : ` ${COLORS.ok(line)}`);
		if (approval.detail) {
			lines.push(`   ${COLORS.warning(`(${approval.detail})`)}`);
		}
	}
	return lines;
}

function contractVerificationState(result: AnalysisResult): "verified" | "unverified" | "unknown" {
	if (result.contract.verified) return "verified";
	const hasUnverifiedFinding = result.findings.some((finding) => finding.code === "UNVERIFIED");
	return hasUnverifiedFinding ? "unverified" : "unknown";
}

function formatChecksContextLine(result: AnalysisResult): string {
	const verificationState = contractVerificationState(result);
	const ageLabel =
		result.contract.age_days === undefined ? "age: —" : `age: ${result.contract.age_days}d`;
	const txCountLabel =
		result.contract.tx_count === undefined
			? "txs: —"
			: `txs: ${new Intl.NumberFormat("en-US").format(result.contract.tx_count)}`;
	return ` Context: ${verificationState} · ${ageLabel} · ${txCountLabel}`;
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

function collectChecksFindings(result: AnalysisResult): Finding[] {
	const deduped = new Map<string, Finding>();
	for (const finding of result.findings) {
		if (isChecksNoiseFinding(finding)) continue;
		const existing = deduped.get(finding.code);
		if (!existing || compareFindingsBySignal(finding, existing) < 0) {
			deduped.set(finding.code, finding);
		}
	}
	return Array.from(deduped.values()).sort(compareFindingsBySignal);
}

function renderChecksSection(result: AnalysisResult, verboseFindings: boolean): string[] {
	const lines: string[] = [];
	lines.push(" 🧾 CHECKS");

	const contextLine = formatChecksContextLine(result);
	const verificationState = contractVerificationState(result);
	if (verificationState === "verified") {
		lines.push(COLORS.dim(contextLine));
	} else {
		lines.push(COLORS.warning(contextLine));
	}

	if (result.contract.verified) {
		lines.push(COLORS.ok(" ✓ Source verified"));
	} else {
		lines.push(COLORS.warning(" ⚠️ Source not verified (or unknown)"));
	}

	if (result.contract.is_proxy) {
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
		return { decision: "BLOCK", reason: "INCONCLUSIVE simulation" };
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

function recommendationForDisplay(result: AnalysisResult, hasCalldata: boolean): Recommendation {
	if (simulationIsUncertain(result, hasCalldata) && result.recommendation === "ok") {
		return "caution";
	}
	return result.recommendation;
}

function buildRecommendationWhy(
	result: AnalysisResult,
	hasCalldata: boolean,
	policy?: PolicySummary,
): string {
	const simulationUncertain = simulationIsUncertain(result, hasCalldata);
	if (simulationUncertain) {
		return "Simulation is inconclusive, so balance and approval effects may be incomplete.";
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

	const topFinding = collectChecksFindings(result)[0];
	if (topFinding) {
		if (topFinding.code === "UPGRADEABLE") {
			return "Upgradeable proxy detected — code can change post-deploy, so trust assumptions matter.";
		}
		return cleanLabel(topFinding.message);
	}

	const displayedRecommendation = recommendationForDisplay(result, hasCalldata);
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
	policy?: PolicySummary,
): string[] {
	const displayedRecommendation = recommendationForDisplay(result, hasCalldata);
	const style = recommendationStyle(displayedRecommendation);
	const lines: string[] = [];
	lines.push(` 🎯 RECOMMENDATION: ${style.color(`${style.icon} ${style.label}`)}`);
	lines.push(` Why: ${buildRecommendationWhy(result, hasCalldata, policy)}`);
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
		const address = shortenAddress(endpoint.address);
		const label = endpoint.label ? `${cleanLabel(endpoint.label)} (${address})` : address;
		lines.push(COLORS.ok(` ✓ Allowlisted ${endpoint.role}: ${label}`));
	}

	for (const endpoint of nonAllowlisted) {
		const address = shortenAddress(endpoint.address);
		const label = endpoint.label ? `${cleanLabel(endpoint.label)} (${address})` : address;
		lines.push(COLORS.warning(` ⚠️ Non-allowlisted ${endpoint.role}: ${label}`));
	}

	const effectiveDecision = resolvePolicyDecision(result, hasCalldata, policy);
	const decisionLine = ` Policy decision: ${effectiveDecision.decision}${effectiveDecision.reason ? ` (${effectiveDecision.reason})` : ""}`;
	if (effectiveDecision.decision === "ALLOW") {
		lines.push(COLORS.ok(decisionLine));
	} else if (effectiveDecision.decision === "PROMPT") {
		lines.push(COLORS.warning(decisionLine));
	} else {
		lines.push(COLORS.danger(decisionLine));
	}

	return lines;
}

function renderVerdictSection(
	result: AnalysisResult,
	hasCalldata: boolean,
	policy?: PolicySummary,
): string[] {
	const simulationUncertain = simulationIsUncertain(result, hasCalldata);
	const displayedRecommendation = recommendationForDisplay(result, hasCalldata);
	const recommendation = recommendationStyle(displayedRecommendation);
	const lines: string[] = [];
	lines.push(
		` 👉 VERDICT: ${recommendation.color(`${recommendation.icon} ${recommendation.label}`)}`,
	);

	if (simulationUncertain) {
		lines.push(COLORS.warning(` ⚠️ INCONCLUSIVE: ${formatInconclusiveReason(result)}`));
	}

	const actionLine = buildNextActionLine(result, hasCalldata, policy);
	if (actionLine.includes("BLOCK")) {
		lines.push(COLORS.danger(` ${actionLine}`));
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
		return "BLOCK — simulation is inconclusive; verify spender, recipient, and amounts first.";
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
		verbose?: boolean;
		/** When set, long lines word-wrap to fit within this terminal width. */
		maxWidth?: number;
	},
): string {
	const hasCalldata = context?.hasCalldata ?? false;
	const actorLabel: "You" | "Sender" = context?.sender ? "You" : "Sender";
	const protocol = formatProtocolDisplay(result);
	const verboseFindings = context?.verbose ?? false;
	const protocolSuffix =
		result.protocolMatch?.slug && result.protocolMatch.slug !== protocol
			? COLORS.dim(` (${result.protocolMatch.slug})`)
			: "";
	const action = hasCalldata ? resolveActionLabel(result) : "N/A";
	const contractLabel = formatContractLabel(result.contract);

	const headerLines = [
		` Chain: ${result.contract.chain}`,
		` Protocol: ${protocol}${protocolSuffix}`,
		...(hasCalldata ? [` Action: ${action}`] : []),
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

		// Compact verdict: just the answer, no section header
		const verdictLabel = hasCalldata ? "SAFE to continue." : "No issues found.";
		sections.push([COLORS.ok(` ✅ ${verdictLabel}`)]);

		return renderUnifiedBox(headerLines, sections, context?.maxWidth);
	}

	// Full detail: assessment quality is degraded or --verbose requested
	const sections = hasCalldata
		? [
				renderRecommendationSection(result, hasCalldata, context?.policy),
				renderChecksSection(result, verboseFindings),
				...(context?.policy ? [renderPolicySection(result, hasCalldata, context.policy)] : []),
				renderBalanceSection(result, hasCalldata, actorLabel),
				renderApprovalsSection(result, hasCalldata),
				renderVerdictSection(result, hasCalldata, context?.policy),
			]
		: [
				renderRecommendationSection(result, hasCalldata, context?.policy),
				renderChecksSection(result, verboseFindings),
				...(context?.policy ? [renderPolicySection(result, hasCalldata, context.policy)] : []),
				renderVerdictSection(result, hasCalldata, context?.policy),
			];

	return renderUnifiedBox(headerLines, sections, context?.maxWidth);
}

function buildBalanceChangeItems(simulation: BalanceSimulationResult, chain: Chain): string[] {
	const items: string[] = [];
	if (simulation.nativeDiff && simulation.nativeDiff !== 0n) {
		items.push(formatSignedAmount(simulation.nativeDiff, 18, nativeSymbol(chain)));
	}

	const erc20Net = aggregateErc20(simulation.balances.changes);
	for (const change of erc20Net) {
		const symbol = change.symbol ?? shortenAddress(change.address);
		items.push(formatSignedAmount(change.amount, change.decimals, symbol));
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
	approval: BalanceSimulationResult["approvals"]["changes"][number],
	chain: Chain,
): {
	text: string;
	detail?: string;
	isWarning: boolean;
	key: string;
} {
	const spenderLabel = formatSpenderLabel(approval.spender, chain);
	const tokenLabel = approval.symbol ? cleanLabel(approval.symbol) : shortenAddress(approval.token);
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
			detail:
				previous === undefined
					? "previous operator approval unknown — state read failed"
					: undefined,
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
			? formatSpenderLabel(approval.previousSpender, chain)
			: undefined;
		const action = revoking
			? `${prefix}Revoke ${tokenLabel} #${approval.tokenId.toString()} approval`
			: `${prefix}Approve ${tokenLabel} #${approval.tokenId.toString()} for ${spenderLabel}`;
		return {
			text: previousSpender ? `${action} (was ${previousSpender})` : action,
			detail: previousSpender ? undefined : "previous approved spender unknown — state read failed",
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
			detail:
				previousLabel === undefined ? "allowance amount unknown — state read failed" : undefined,
			isWarning: true,
			key: `${approval.token.toLowerCase()}|${approval.spender.toLowerCase()}|amount|unknown`,
		};
	}

	if (amount === 0n) {
		const action = `${prefix}Revoke ${spenderLabel} spending of ${tokenLabel}`;
		return {
			text: previousLabel ? `${action} (was ${previousLabel})` : action,
			detail: previousLabel ? undefined : "previous allowance unknown — state read failed",
			isWarning: false,
			key: `${approval.token.toLowerCase()}|${approval.spender.toLowerCase()}|amount|revoke`,
		};
	}

	const action = `${prefix}Allow ${spenderLabel} to spend ${amountLabel} ${tokenLabel}`;
	return {
		text: previousLabel ? `${action} (was ${previousLabel})` : action,
		detail: previousLabel ? undefined : "previous allowance unknown — state read failed",
		isWarning: true,
		key: `${approval.token.toLowerCase()}|${approval.spender.toLowerCase()}|amount|${amountLabel}`,
	};
}

function extractSimulationHints(notes: string[]): string[] {
	const hints = notes.filter((note) => note.startsWith("Hint:"));
	if (hints.length === 0) return [];
	return hints.map((hint) => hint.replace(/^Hint:\s*/, ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function formatNftChange(change: AssetChange): string | null {
	if (change.assetType !== "erc721" && change.assetType !== "erc1155") return null;
	const label = change.address ? shortenAddress(change.address) : change.assetType.toUpperCase();
	const tokenId = change.tokenId ? ` #${change.tokenId.toString()}` : "";
	if (change.assetType === "erc1155" && change.amount) {
		const signed = change.direction === "out" ? -change.amount : change.amount;
		const amount = formatSignedAmount(signed, 0, `${label}${tokenId}`);
		return amount;
	}
	const sign = change.direction === "out" ? "-" : "+";
	return `${sign} ${label}${tokenId}`;
}

function formatSignedAmount(amount: bigint, decimals: number | undefined, symbol: string): string {
	const sign = amount < 0n ? "-" : "+";
	const absolute = amount < 0n ? -amount : amount;
	const formatted =
		decimals === undefined
			? formatNumberString(absolute.toString())
			: formatNumberString(formatFixed(absolute, decimals), 4);
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
	const short = shortenAddress(token);
	if (symbol && symbol.trim().length > 0) {
		return `${cleanLabel(symbol)} (${short})`;
	}
	return short;
}

function formatSpenderLabel(spender: string, chain: Chain): string {
	const short = shortenAddress(spender);
	const known = (KNOWN_SPENDERS[chain] ?? []).find(
		(entry) => entry.address.toLowerCase() === spender.toLowerCase(),
	);
	if (known) {
		return `${known.name} (${short})`;
	}
	return short;
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

function formatCallSummaryLines(
	index: number,
	call: SafeCallResult,
	hasCalldata: boolean,
): string[] {
	const { analysis } = call;
	const target = analysis?.contract?.name
		? cleanLabel(analysis.contract.name)
		: shortenAddress(call.to);
	const intent = analysis?.intent && hasCalldata ? ` · ${cleanLabel(analysis.intent)}` : "";
	const headerLine = ` Call ${index + 1} → ${target}${intent}`;

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
function formatCallOneLiner(index: number, call: SafeCallResult, hasCalldata: boolean): string {
	const { analysis } = call;
	const target = analysis?.contract?.name
		? cleanLabel(analysis.contract.name)
		: shortenAddress(call.to);
	const intent = analysis?.intent && hasCalldata ? ` · ${cleanLabel(analysis.intent)}` : "";

	if (!analysis) {
		const reason = call.error ? COLORS.dim(` (${call.error})`) : "";
		return ` Call ${index + 1} → ${target}${intent}${reason}`;
	}

	const style = recommendationStyle(analysis.recommendation);
	return ` Call ${index + 1} → ${target}${intent}  ${style.color(style.icon)}`;
}

/** Real-time progress line emitted as each call completes during parallel analysis. */
export function renderCallProgressLine(
	index: number,
	result: SafeCallResult,
	totalCalls: number,
): string {
	const { analysis } = result;
	const target = analysis?.contract?.name
		? cleanLabel(analysis.contract.name)
		: shortenAddress(result.to);
	const intent = analysis?.intent ? ` · ${cleanLabel(analysis.intent)}` : "";
	const label = `Call ${index + 1}/${totalCalls}`;

	if (result.error) {
		const short = result.error.length > 50 ? `${result.error.slice(0, 50)}…` : result.error;
		return `  ${COLORS.danger("✗")} ${label} → ${target}${intent}  ${COLORS.dim(`(${short})`)}`;
	}

	if (!analysis) {
		return `  ${COLORS.dim("◌")} ${label} → ${target}${intent}`;
	}

	const style = recommendationStyle(analysis.recommendation);
	return `  ${COLORS.ok("✓")} ${label} → ${target}${intent}  ${style.color(style.icon)}`;
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
	lines.push(` 💰 BALANCE CHANGES${sectionConfidenceSuffix(worstConf)}`);

	if (anyFailed) {
		lines.push(COLORS.warning(" - Some simulations failed; balance impact may be incomplete."));
	} else if (anyMissing) {
		lines.push(
			COLORS.warning(" - Some calls could not be analyzed; balance impact may be incomplete."),
		);
	}

	const items: string[] = [];
	if (nativeDiff !== 0n) {
		items.push(formatSignedAmount(nativeDiff, 18, nativeSymbol(chain)));
	}
	const erc20Net = aggregateErc20(allChanges);
	for (const change of erc20Net) {
		const symbol = change.symbol ?? shortenAddress(change.address);
		items.push(formatSignedAmount(change.amount, change.decimals, symbol));
	}
	for (const change of allChanges) {
		if (change.assetType === "erc20") continue;
		const item = formatNftChange(change);
		if (item) items.push(item);
	}

	if (items.length === 0 && !anyFailed && !anyMissing) {
		lines.push(COLORS.dim(" - No balance changes detected"));
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

	for (const call of calls) {
		if (!call.analysis) continue;
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
	const lines: string[] = [];
	lines.push(` 🔐 APPROVALS${sectionConfidenceSuffix(worstConf)}`);

	for (const approval of allItems) {
		const prefix = approval.isWarning ? "⚠️" : "✓";
		const line = `${prefix} ${approval.text}`;
		lines.push(approval.isWarning ? ` ${COLORS.warning(line)}` : ` ${COLORS.ok(line)}`);
		if (approval.detail) {
			lines.push(`   ${COLORS.warning(`(${approval.detail})`)}`);
		}
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
			const lines = formatCallSummaryLines(i, calls[i], true);
			if (i > 0) callLines.push("");
			callLines.push(...lines);
		}
		sections.push(callLines);
	} else {
		const callLines = calls.map((c, i) => formatCallOneLiner(i, c, true));
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
