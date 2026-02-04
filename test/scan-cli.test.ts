import { describe, expect, test } from "bun:test";

async function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}) {
	const env = { ...process.env, ...envOverrides };
	const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

describe("cli scan", () => {
	test("--format json outputs AnalyzeResponse", async () => {
		const result = await runCli([
			"scan",
			"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
			"--format",
			"json",
			"--quiet",
		]);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.requestId).toBeDefined();
		expect(parsed.scan?.input?.address).toBeDefined();
		expect(parsed.scan?.recommendation).toBeDefined();
	}, 120000);

	test("--fail-on caution returns exit code 2 for caution findings", async () => {
		const result = await runCli([
			"scan",
			"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
			"--format",
			"json",
			"--fail-on",
			"caution",
			"--quiet",
		]);

		expect(result.exitCode).toBe(2);
	}, 120000);

	test("--format sarif outputs SARIF log", async () => {
		const result = await runCli([
			"scan",
			"0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
			"--format",
			"sarif",
			"--quiet",
		]);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.version).toBe("2.1.0");
		expect(parsed.runs?.length).toBe(1);
	}, 120000);

	test("--calldata accepts canonical JSON input", async () => {
		const calldata = JSON.stringify({
			to: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
			data: "0x",
			chain: "1",
		});
		const result = await runCli(["scan", "--calldata", calldata, "--format", "json", "--quiet"]);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.scan?.input?.calldata?.to).toBe("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984");
	}, 120000);

	test("--calldata accepts Rabby-style tx JSON (extra fields ignored)", async () => {
		const tx = JSON.stringify({
			chainId: 1,
			from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
			to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
			value: "0x0",
			data: "0x",
			gas: "0x5208",
			maxFeePerGas: "0x1",
			maxPriorityFeePerGas: "0x1",
			nonce: "0x1",
		});

		const result = await runCli(["scan", "--no-sim", "--calldata", tx, "--format", "json", "--quiet"]);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.scan?.input?.calldata?.to).toBe("0x66a9893cc07d91d95644aedd05d03f95e1dba8af");
		expect(parsed.scan?.input?.calldata?.chain).toBe("1");
		const tags = Array.isArray(parsed.scan?.contract?.tags) ? parsed.scan.contract.tags : [];
		expect(tags.join(" ")).toContain("Uniswap");
	}, 120000);

	test("--calldata accepts JSON-RPC request objects (params[0])", async () => {
		const request = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "eth_sendTransaction",
			params: [
				{
					chainId: "0x1",
					from: "0x24274566a1ad6a9b056e8e2618549ebd2f5141a7",
					to: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
					value: "0x0",
					data: "0x",
				},
			],
		});

		const result = await runCli([
			"scan",
			"--no-sim",
			"--calldata",
			request,
			"--format",
			"json",
			"--quiet",
		]);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.scan?.input?.calldata?.to).toBe("0x66a9893cc07d91d95644aedd05d03f95e1dba8af");
		expect(parsed.scan?.input?.calldata?.chain).toBe("1");
	}, 120000);

	test("--calldata accepts raw hex calldata when --to is provided", async () => {
		const result = await runCli([
			"scan",
			"--calldata",
			"0x3593564c",
			"--to",
			"0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
			"--chain",
			"1",
			"--format",
			"json",
			"--quiet",
		]);

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.scan?.input?.calldata?.data).toBe("0x3593564c");
	}, 120000);
});
