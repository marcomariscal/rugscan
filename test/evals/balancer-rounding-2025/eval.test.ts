import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// TODO: Import when M6 precision detection is implemented
// import { detectPrecisionIssues } from "../../../src/detectors/precision";

/**
 * Balancer V2 Rounding Error Exploit Eval
 *
 * This eval tests whether rugscan would have detected the vulnerability
 * that led to $128M being drained on November 3, 2025.
 *
 * The exploit leveraged precision loss in _upscaleArray's mulDown operation
 * when token balances were pushed to 8-9 wei, compounding errors across
 * 65+ batched swaps to suppress BPT price.
 *
 * Reference: https://research.checkpoint.com/2025/how-an-attacker-drained-128m-from-balancer-through-rounding-error-exploitation/
 */

const EVAL_DIR = join(import.meta.dir);
const vulnerableCode = readFileSync(join(EVAL_DIR, "vulnerable-code.sol"), "utf-8");
const expectedFindings = JSON.parse(
	readFileSync(join(EVAL_DIR, "expected-findings.json"), "utf-8"),
);

describe("Balancer Rounding Exploit Eval", () => {
	describe("Static Detection (M6)", () => {
		test.todo("should detect PRECISION_LOSS in _upscaleArray", () => {
			// const findings = detectPrecisionIssues(vulnerableCode);
			// const precisionLoss = findings.find(f => f.code === "PRECISION_LOSS");
			// expect(precisionLoss).toBeDefined();
			// expect(precisionLoss?.message).toContain("mulDown");
		});

		test.todo("should detect ROUNDING_TO_ZERO in invariant calculation", () => {
			// const findings = detectPrecisionIssues(vulnerableCode);
			// const roundingToZero = findings.find(f => f.code === "ROUNDING_TO_ZERO");
			// expect(roundingToZero).toBeDefined();
		});

		test.todo("should detect MISSING_MIN_CHECK for balance validation", () => {
			// const findings = detectPrecisionIssues(vulnerableCode);
			// const missingMin = findings.find(f => f.code === "MISSING_MIN_CHECK");
			// expect(missingMin).toBeDefined();
		});

		test.todo("should NOT flag the _upscaleArraySafe fix as vulnerable", () => {
			// const safeCode = vulnerableCode.split("_upscaleArraySafe")[1];
			// const findings = detectPrecisionIssues(safeCode);
			// expect(findings).toHaveLength(0);
		});
	});

	describe("Eval Metadata", () => {
		test("exploit metadata is complete", () => {
			expect(expectedFindings.exploit.name).toBe("Balancer V2 Rounding Error Exploit");
			expect(expectedFindings.exploit.loss).toBe("$128M");
			expect(expectedFindings.exploit.date).toBe("2025-11-03");
			expect(expectedFindings.expectedFindings.length).toBeGreaterThan(0);
		});

		test("vulnerable code contains known vulnerable patterns", () => {
			expect(vulnerableCode).toContain("mulDown");
			expect(vulnerableCode).toContain("_upscaleArray");
			expect(vulnerableCode).toContain("_calculateInvariant");
			expect(vulnerableCode).toContain("8-9 wei");
		});
	});
});
