import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const recordingsDir = path.join(import.meta.dir, "fixtures", "recordings");

describe("ui recordings snapshots", () => {
	test("recorded proxy outputs stay readable", async () => {
		if (!existsSync(recordingsDir)) {
			return;
		}

		const entries = await readdir(recordingsDir, { withFileTypes: true });
		const bundles = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		if (bundles.length === 0) {
			return;
		}

		for (const bundle of bundles) {
			const renderedPath = path.join(recordingsDir, bundle, "rendered.txt");
			if (!existsSync(renderedPath)) continue;
			const rendered = await readFile(renderedPath, "utf-8");
			expect(rendered).toMatchSnapshot(bundle);
		}
	});
});
