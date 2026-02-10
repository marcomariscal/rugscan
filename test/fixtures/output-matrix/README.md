# Output text matrix fixtures

Deterministic goldens for high-leverage output scenarios.

Each scenario is defined in `scenarios.ts` and paired with `rendered.txt` under:

- `malicious-phishing-contract`
- `malicious-approval-drainer`
- `unverified-contract`
- `weird-inconclusive-edge`
- `happy-path-swap`
- `intricate-defi-action`

To regenerate `rendered.txt` files after intentional UI changes:

```bash
bun -e '
import path from "node:path";
import { renderHeading, renderResultBox } from "./src/cli/ui";
import { OUTPUT_MATRIX_SCENARIOS } from "./test/fixtures/output-matrix/scenarios";
const baseDir = path.join(process.cwd(), "test", "fixtures", "output-matrix");
for (const scenario of OUTPUT_MATRIX_SCENARIOS) {
	const scanLabel = scenario.context.hasCalldata ? "Transaction" : "Address";
	const rendered = `${renderHeading(`${scanLabel} scan on ${scenario.analysis.contract.chain}`)}\n\n${renderResultBox(scenario.analysis, scenario.context)}\n`;
	await Bun.write(path.join(baseDir, scenario.id, "rendered.txt"), rendered);
}
'
```
