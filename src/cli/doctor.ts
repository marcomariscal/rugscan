import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config";
import type { Config } from "../types";

interface DoctorResult {
	ok: boolean;
	lines: string[];
}

type AnvilStatus = { kind: "present"; message: string } | { kind: "missing"; message: string };

export async function runDoctor(): Promise<void> {
	const config = await loadConfig();
	const anvilStatus = detectAnvil(config);
	const result = formatDoctorResult(anvilStatus);
	process.stdout.write(`${result.lines.join("\n")}\n`);
	process.exit(result.ok ? 0 : 1);
}

export function detectAnvil(config?: Config, env: NodeJS.ProcessEnv = process.env): AnvilStatus {
	const configured = config?.simulation?.anvilPath?.trim();
	if (configured && configured.length > 0) {
		const resolvedConfigured = resolveConfiguredAnvil(configured, env);
		if (resolvedConfigured) {
			return {
				kind: "present",
				message:
					resolvedConfigured === configured
						? `anvil: found at ${resolvedConfigured} (configured)`
						: `anvil: found at ${resolvedConfigured} (configured as ${configured})`,
			};
		}
		return {
			kind: "missing",
			message: `anvil: configured simulation.anvilPath not found (${configured})`,
		};
	}

	const fromPath = findExecutableOnPath("anvil", env);
	if (fromPath) {
		return { kind: "present", message: `anvil: found at ${fromPath} (PATH)` };
	}

	const homeDir = resolveHomeDir(env);
	const defaultCandidate = homeDir ? path.join(homeDir, ".foundry", "bin", "anvil") : undefined;
	if (defaultCandidate && existsSync(defaultCandidate)) {
		return {
			kind: "present",
			message: `anvil: found at ${defaultCandidate} (~/.foundry/bin/anvil)`,
		};
	}

	return {
		kind: "missing",
		message: "anvil: not found on PATH",
	};
}

function formatDoctorResult(anvilStatus: AnvilStatus): DoctorResult {
	if (anvilStatus.kind === "present") {
		return {
			ok: true,
			lines: ["✅ Doctor: simulation prerequisites OK", `- ${anvilStatus.message}`],
		};
	}

	return {
		ok: false,
		lines: [
			"❌ Doctor: missing simulation prerequisite",
			`- ${anvilStatus.message}`,
			"- Install Foundry: https://getfoundry.sh",
			"- Then run: foundryup",
			"- Simulation will not run until Anvil is available.",
		],
	};
}

function resolveConfiguredAnvil(configured: string, env: NodeJS.ProcessEnv): string | null {
	if (looksLikePath(configured)) {
		return existsSync(configured) ? configured : null;
	}
	return findExecutableOnPath(configured, env);
}

function looksLikePath(value: string): boolean {
	return (
		path.isAbsolute(value) || value.includes("/") || value.includes("\\") || value.startsWith(".")
	);
}

function resolveHomeDir(env: NodeJS.ProcessEnv): string {
	const home = env.HOME;
	if (home && home.trim().length > 0) {
		return home;
	}
	const userProfile = env.USERPROFILE;
	if (userProfile && userProfile.trim().length > 0) {
		return userProfile;
	}
	return os.homedir();
}

function findExecutableOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
	const pathValue = env.PATH;
	if (!pathValue) return null;
	const dirs = splitPathList(pathValue);
	if (dirs.length === 0) return null;

	const extensions = executableExtensions(env);
	for (const dir of dirs) {
		for (const ext of extensions) {
			const candidate = path.join(dir, `${command}${ext}`);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}

function splitPathList(value: string): string[] {
	return value
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function executableExtensions(env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32") return [""];
	const pathext = env.PATHEXT;
	if (pathext) {
		const entries = pathext
			.split(";")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		if (entries.length > 0) {
			return entries;
		}
	}
	return [".EXE", ".CMD", ".BAT", ".COM"];
}
