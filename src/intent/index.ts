import type { DecodedCall } from "../analyzers/calldata/decoder";
import { INTENT_TEMPLATES, type IntentContext } from "./templates";

export type { IntentContext } from "./templates";

export function buildIntent(decoded: DecodedCall, context: IntentContext): string | null {
	for (const template of INTENT_TEMPLATES) {
		if (!template.match(decoded)) continue;
		const summary = template.render(decoded, context);
		if (summary) return summary;
	}
	return null;
}
