export interface NameResolutionInput {
	address: string;
	isProxy: boolean;
	proxyName?: string;
	implementationName?: string;
	protocolName?: string;
}

export interface NameResolutionResult {
	resolvedName: string;
	friendlyName?: string;
}

export function resolveContractName(input: NameResolutionInput): NameResolutionResult {
	const proxyName = normalizeName(input.proxyName);
	const implementationName = normalizeName(input.implementationName);
	const protocolName = normalizeName(input.protocolName);

	let friendlyName: string | undefined;

	if (input.isProxy) {
		if (protocolName && implementationName) {
			friendlyName = combineProtocolAndImplementation(protocolName, implementationName);
		} else if (protocolName) {
			friendlyName = protocolName;
		} else if (implementationName) {
			friendlyName = implementationName;
		}

		return {
			resolvedName: friendlyName ?? implementationName ?? proxyName ?? input.address,
			friendlyName,
		};
	}

	if (!proxyName && protocolName) {
		friendlyName = protocolName;
	}

	return {
		resolvedName: proxyName ?? friendlyName ?? input.address,
		friendlyName,
	};
}

function normalizeName(value?: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function combineProtocolAndImplementation(protocolName: string, implementationName: string): string {
	if (includesIgnoreCase(implementationName, protocolName)) {
		return implementationName;
	}
	return `${protocolName} ${implementationName}`;
}

function includesIgnoreCase(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}
