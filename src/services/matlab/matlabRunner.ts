import * as path from "path"

import { resolveMatlabRuntime, type MatlabRuntime } from "./matlabToolUtils"

export interface MatlabRunConfig {
	command: string
	cwd?: string
	env?: Record<string, string>
}

const isWin = process.platform === "win32"

/** Octave/MATLAB single-quoted string escape (double single quote for literal '). */
function escapeMatlabSingleQuoted(s: string): string {
	return s.replace(/'/g, "''")
}

/** Normalize path for use inside MATLAB/Octave single-quoted strings. */
function toMatlabPathLiteral(p: string): string {
	return escapeMatlabSingleQuoted(path.resolve(p).replace(/\\/g, "/"))
}

function formatOctaveInvoke(octavePath: string, argsTail: string): string {
	if (isWin) {
		return `& "${octavePath}" ${argsTail}`
	}
	return `"${octavePath}" ${argsTail}`
}

/** `-batch` argument for MATLAB (no outer shell quotes). */
function formatMatlabBatchInvoke(exe: string, batchCode: string): string {
	if (isWin) {
		const psEscape = String.fromCharCode(96) + '"'
		const safe = batchCode.replace(/"/g, psEscape)
		return `& "${exe}" -batch "${safe}"`
	}
	const safe = batchCode.replace(/"/g, '\\"')
	return `"${exe}" -batch "${safe}"`
}

function buildRunCommand(rt: MatlabRuntime, filePath: string): string {
	const lit = toMatlabPathLiteral(filePath)

	if (rt.kind === "octave") {
		return formatOctaveInvoke(rt.executable, `"${filePath}"`)
	}

	return formatMatlabBatchInvoke(rt.executable, `run('${lit}')`)
}

/**
 * Build run config for a .m script only (no UI). Returns null for non-.m or missing runtime.
 */
export function buildMatlabRunConfig(filePath: string): MatlabRunConfig | null {
	const ext = path.extname(filePath).toLowerCase()
	if (ext !== ".m") {
		return null
	}

	// Reject file paths with shell metacharacters to prevent command injection
	// when the path is interpolated into an Octave/MATLAB shell command string.
	if (/[&|;<>()$`!"\n\r]/.test(filePath)) {
		return null
	}

	const rt = resolveMatlabRuntime()
	if (!rt) {
		return null
	}

	const fileDir = path.dirname(filePath)
	const command = buildRunCommand(rt, filePath)

	const safeEnvKeys = ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "SystemRoot", "APPDATA", "LOCALAPPDATA"]
	const safeEnv: Record<string, string> = {}
	for (const key of safeEnvKeys) {
		if (process.env[key]) safeEnv[key] = process.env[key]!
	}

	return {
		command,
		cwd: fileDir,
		env: safeEnv,
	}
}
