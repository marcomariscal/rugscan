import { performance } from "node:perf_hooks";

export function nowMs(): number {
	return performance.now();
}

export class TimingStore {
	readonly #values = new Map<string, number[]>();

	add(name: string, ms: number): void {
		if (!Number.isFinite(ms)) return;
		const existing = this.#values.get(name);
		if (existing) {
			existing.push(ms);
			return;
		}
		this.#values.set(name, [ms]);
	}

	getTotals(): Array<{ name: string; ms: number; count: number }> {
		const out: Array<{ name: string; ms: number; count: number }> = [];
		for (const [name, values] of this.#values.entries()) {
			const total = values.reduce((acc, value) => acc + value, 0);
			out.push({ name, ms: total, count: values.length });
		}
		out.sort((a, b) => b.ms - a.ms);
		return out;
	}

	toLogLine(prefix = "timing"): string {
		const parts: string[] = [];
		for (const entry of this.getTotals()) {
			const rounded = Math.round(entry.ms);
			parts.push(`${entry.name}=${rounded}ms${entry.count > 1 ? `x${entry.count}` : ""}`);
		}
		return parts.length > 0 ? `${prefix}: ${parts.join(" ")}` : `${prefix}: (none)`;
	}
}
