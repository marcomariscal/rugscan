import { describe, expect, test } from "bun:test";
import {
	decideRiskAction,
	extractSendTransactionCalldata,
	type ProxyPolicy,
} from "../src/jsonrpc/proxy";

function buildPolicy(overrides: Partial<ProxyPolicy> = {}): ProxyPolicy {
	return {
		threshold: overrides.threshold ?? "caution",
		onRisk: overrides.onRisk ?? "block",
		allowPromptWhenSimulationFails: overrides.allowPromptWhenSimulationFails ?? true,
	};
}

describe("jsonrpc proxy - unit", () => {
	test("extractSendTransactionCalldata parses eth_sendTransaction payload", () => {
		const calldata = extractSendTransactionCalldata({
			jsonrpc: "2.0",
			id: 1,
			method: "eth_sendTransaction",
			params: [
				{
					to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
					from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
					data: "0x",
					value: "0x0",
					chainId: "0x1",
				},
			],
		});

		expect(calldata).not.toBeNull();
		if (!calldata) return;
		expect(calldata.to).toBe("0x66a9893cc07d91d95644aedd05d03f95e1dba8af");
		expect(calldata.from).toBe("0x24274566a1ad6a9b056e8e2618549ebd2f5141a7");
		expect(calldata.data).toBe("0x");
		expect(calldata.value).toBe("0");
		expect(calldata.chain).toBe("1");
	});

	test("decideRiskAction never forwards when simulation fails", () => {
		const action = decideRiskAction({
			recommendation: "ok",
			simulationSuccess: false,
			policy: buildPolicy({ threshold: "danger", onRisk: "prompt" }),
			isInteractive: true,
		});
		expect(action).toBe("prompt");
	});

	test("decideRiskAction blocks when non-interactive and risky", () => {
		const action = decideRiskAction({
			recommendation: "danger",
			simulationSuccess: true,
			policy: buildPolicy({ threshold: "caution", onRisk: "prompt" }),
			isInteractive: false,
		});
		expect(action).toBe("block");
	});
});
