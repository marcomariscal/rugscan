import pc from "picocolors";
import { MAX_UINT256 } from "../constants";
import type {
	AIAnalysis,
	AIConcern,
	AnalysisResult,
	ApprovalAnalysisResult,
	ApprovalContext,
	ApprovalTx,
	AssetChange,
	BalanceSimulationResult,
	Chain,
	Finding,
	Recommendation,
} from "../types";

const COLORS = {
	ok: pc.green,
	warning: pc.yellow,
	danger: pc.red,
	// Use ANSI "dim" (not gray) — much more readable on many terminals/themes.
	dim: pc.dim,
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

export function createProgressRenderer(enabled: boolean) {
	const spinner = new Spinner(enabled);
	return (event: ProviderEvent) => {
		const provider = pc.cyan(event.provider);
		const message = typeof event.message === "string" ? cleanLabel(event.message) : undefined;
		switch (event.status) {
			case "start":
				spinner.start(`Checking ${provider}...`);
				break;
			case "success": {
				const detail = message ? ` ${COLORS.dim(`(${message})`)}` : "";
				spinner.succeed(`${COLORS.ok("✓")} ${provider}${detail}`);
				break;
			}
			case "error": {
				const detail = message ? ` ${COLORS.dim(`(${message})`)}` : "";
				spinner.fail(`${COLORS.danger("✗")} ${provider}${detail}`);
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

function renderBox(title: string, sections: string[][]): string {
	const allLines = [title, ...sections.flat()];
	const width = allLines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
	const horizontal = "─".repeat(width + 2);

	const top = `┌${horizontal}┐`;
	const bottom = `└${horizontal}┘`;
	const divider = `├${horizontal}┤`;

	const lines: string[] = [top];
	lines.push(`│ ${padRight(title, width)} │`);
	sections.forEach((section, index) => {
		lines.push(divider);
		for (const line of section) {
			lines.push(`│ ${padRight(line, width)} │`);
		}
		if (index === sections.length - 1) {
			return;
		}
	});
	lines.push(bottom);
	return lines.join("\n");
}

function renderUnifiedBox(headerLines: string[], sections: string[][]): string {
	const allLines = [...headerLines, ...sections.flat()];
	const width = allLines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
	const horizontal = "─".repeat(width + 2);

	const top = `┌${horizontal}┐`;
	const bottom = `└${horizontal}┘`;
	const divider = `├${horizontal}┤`;

	const lines: string[] = [top];
	for (const line of headerLines) {
		lines.push(`│ ${padRight(line, width)} │`);
	}
	sections.forEach((section) => {
		lines.push(divider);
		for (const line of section) {
			lines.push(`│ ${padRight(line, width)} │`);
		}
	});
	lines.push(bottom);
	return lines.join("\n");
}

function riskLabel(score: number): string {
	if (score >= 85) return "CRITICAL";
	if (score >= 70) return "HIGH";
	if (score >= 50) return "MEDIUM";
	if (score >= 30) return "LOW";
	return "SAFE";
}

function severityColor(severity: AIConcern["severity"]) {
	if (severity === "medium") return COLORS.warning;
	return COLORS.danger;
}

function _renderAISection(ai: AIAnalysis): string[] {
	const lines: string[] = [];
	lines.push(` AI: ${ai.provider} / ${ai.model}`);
	lines.push(` Risk score: ${ai.risk_score} (${riskLabel(ai.risk_score)})`);
	lines.push(` Summary: ${ai.summary}`);
	if (ai.concerns.length > 0) {
		lines.push(" Concerns:");
		for (const concern of ai.concerns) {
			const color = severityColor(concern.severity);
			lines.push(
				`  ${color(concern.severity.toUpperCase())} ${concern.title} (${concern.category}) - ${concern.explanation}`,
			);
		}
	} else {
		lines.push(COLORS.dim(" Concerns: None"));
	}
	return lines;
}

function formatProtocolDisplay(result: AnalysisResult): string {
	if (result.protocolMatch?.name) return cleanLabel(result.protocolMatch.name);
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

function recommendationRiskLabel(recommendation: Recommendation): string {
	if (recommendation === "danger") return "HIGH";
	if (recommendation === "warning") return "MEDIUM";
	if (recommendation === "caution") return "LOW";
	return "SAFE";
}

function riskColor(label: string) {
	if (label === "CRITICAL" || label === "HIGH") return COLORS.danger;
	if (label === "MEDIUM") return COLORS.warning;
	if (label === "LOW") return COLORS.warning;
	return COLORS.ok;
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

function renderBalanceSection(result: AnalysisResult, hasCalldata: boolean): string[] {
	const lines: string[] = [];
	lines.push(" 💰 BALANCE CHANGES");

	if (!hasCalldata) {
		lines.push(COLORS.dim(" - Not available (no calldata)"));
		return lines;
	}
	if (!result.simulation) {
		lines.push(COLORS.dim(" - Simulation pending"));
		return lines;
	}
	if (!result.simulation.success) {
		const detail = result.simulation.revertReason ? ` (${result.simulation.revertReason})` : "";
		lines.push(COLORS.warning(` - Simulation failed${detail}`));
		return lines;
	}

	const changes = buildBalanceChangeItems(result.simulation, result.contract.chain);
	if (changes.length === 0) {
		lines.push(COLORS.dim(" - No balance changes detected"));
		return lines;
	}

	const ordered = orderBalanceChanges(changes);
	const confidenceNote =
		result.simulation.confidence !== "high" ? ` (${result.simulation.confidence} confidence)` : "";
	lines.push(`${formatBalanceChangeLine(ordered)}${confidenceNote}`);
	return lines;
}

function buildApprovalItems(result: AnalysisResult): Array<{ text: string; isUnlimited: boolean }> {
	const items = new Map<string, { text: string; isUnlimited: boolean }>();
	const tokenFallback = result.contract.name ?? shortenAddress(result.contract.address);

	// From calldata findings
	for (const finding of result.findings) {
		if (finding.code !== "UNLIMITED_APPROVAL") continue;
		const details = finding.details;
		const spender = details && typeof details.spender === "string" ? details.spender : undefined;
		const spenderLabel = spender ? shortenAddress(spender) : "unknown";
		const key = `${tokenFallback.toLowerCase()}|${spenderLabel.toLowerCase()}`;
		items.set(key, { text: `${tokenFallback}: UNLIMITED to ${spenderLabel}`, isUnlimited: true });
	}

	// From simulation
	if (result.simulation) {
		for (const approval of result.simulation.approvals) {
			const tokenLabel = shortenAddress(approval.token);
			const spenderLabel = shortenAddress(approval.spender);
			const key = `${tokenLabel.toLowerCase()}|${spenderLabel.toLowerCase()}`;
			const isUnlimited = approval.amount === MAX_UINT256;
			const amountLabel =
				isUnlimited || approval.amount === undefined
					? "UNLIMITED"
					: formatApprovalAmount(approval.amount, 18);
			items.set(key, { text: `${tokenLabel}: ${amountLabel} to ${spenderLabel}`, isUnlimited });
		}
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
	lines.push(" 🔐 APPROVALS");
	if (!hasCalldata) {
		lines.push(COLORS.dim(" - Not available (no calldata)"));
		return lines;
	}

	const approvals = buildApprovalItems(result);
	if (approvals.length === 0) {
		lines.push(COLORS.dim(" - None detected"));
		return lines;
	}
	for (const approval of approvals) {
		if (approval.isUnlimited) {
			lines.push(` ${COLORS.warning(`⚠️ ${approval.text}`)}`);
		} else {
			lines.push(` ${COLORS.dim(`• ${approval.text}`)}`);
		}
	}
	return lines;
}

function renderRiskSection(result: AnalysisResult): string[] {
	const label = result.ai
		? riskLabel(result.ai.risk_score)
		: recommendationRiskLabel(result.recommendation);
	const note = result.ai ? "" : " (AI disabled)";
	const colored = riskColor(label)(label);
	return [` 📊 RISK: ${colored}${note}`];
}

export function renderResultBox(
	result: AnalysisResult,
	context?: { hasCalldata?: boolean },
): string {
	const hasCalldata = context?.hasCalldata ?? false;
	const protocol = formatProtocolDisplay(result);
	const protocolSuffix =
		result.protocolMatch?.slug && result.protocolMatch.slug !== protocol
			? COLORS.dim(` (${result.protocolMatch.slug})`)
			: "";
	const action = hasCalldata ? (result.intent ?? "Unknown action") : "N/A";
	const contractLabel = formatContractLabel(result.contract);

	const headerLines = [
		` Chain: ${result.contract.chain}`,
		` Protocol: ${protocol}${protocolSuffix}`,
		...(hasCalldata ? [` Action: ${action}`] : []),
		` Contract: ${contractLabel}`,
	];

	const sections = hasCalldata
		? [
				renderBalanceSection(result, hasCalldata),
				renderApprovalsSection(result, hasCalldata),
				renderRiskSection(result),
			]
		: [renderRiskSection(result)];

	return renderUnifiedBox(headerLines, sections);
}

function buildBalanceChangeItems(simulation: BalanceSimulationResult, chain: Chain): string[] {
	const items: string[] = [];
	if (simulation.nativeDiff && simulation.nativeDiff !== 0n) {
		items.push(formatSignedAmount(simulation.nativeDiff, 18, nativeSymbol(chain)));
	}

	const erc20Net = aggregateErc20(simulation.assetChanges);
	for (const change of erc20Net) {
		const symbol = change.symbol ?? shortenAddress(change.address);
		items.push(formatSignedAmount(change.amount, change.decimals, symbol));
	}

	for (const change of simulation.assetChanges) {
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

function nativeSymbol(chain: Chain): string {
	return NATIVE_SYMBOLS[chain] ?? "ETH";
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

	return renderBox(title, [approvalLines, findingsLines, spenderLines]);
}

export function renderHeading(text: string): string {
	return COLORS.dim(text);
}

export function renderError(text: string): string {
	return COLORS.danger(text);
}
