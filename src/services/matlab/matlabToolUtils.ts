import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { execFileSync } from "child_process"

import { Package } from "../../shared/package"

/** User override: full path to MATLAB `matlab` / `matlab.exe`. */
export const MATLAB_CONFIG_KEY = "matlabTools.matlabPath"

/** User override: full path to Octave `octave` / `octave-cli.exe`. */
export const OCTAVE_CONFIG_KEY = "matlabTools.octavePath"

export type MatlabRuntimeKind = "matlab" | "octave"

export interface MatlabRuntime {
	kind: MatlabRuntimeKind
	executable: string
}

const isWin = process.platform === "win32"

function tryWhich(cmd: string): string | undefined {
	// Whitelist: only allow safe command names (alphanumeric, +, -, _, .)
	if (!/^[a-zA-Z0-9_+.\-]+$/.test(cmd)) {
		return undefined
	}
	try {
		if (isWin) {
			const out = execFileSync("where", [cmd], {
				encoding: "utf-8",
				windowsHide: true,
				stdio: ["pipe", "pipe", "ignore"],
			}).trim()
			const first = out.split(/\r?\n/).find((line) => line.trim().length > 0)
			const p = first?.trim()
			if (p && fs.existsSync(p)) {
				return p
			}
		} else {
			const out = execFileSync("which", [cmd], { encoding: "utf-8" }).trim()
			if (out && fs.existsSync(out)) {
				return out
			}
		}
	} catch {
		// intentionally ignored: tool not on PATH
	}
	return undefined
}

/**
 * Search typical MATLAB install locations when not on PATH.
 */
function findMatlabOnDisk(): string | undefined {
	const plat = process.platform
	if (plat === "win32") {
		const base = "C:\\Program Files\\MATLAB"
		if (!fs.existsSync(base)) {
			return undefined
		}
		let dirs: string[]
		try {
			dirs = fs
				.readdirSync(base)
				.filter((d) => fs.statSync(path.join(base, d)).isDirectory())
				.sort()
				.reverse()
		} catch {
			return undefined
		}
		for (const d of dirs) {
			const exe = path.join(base, d, "bin", "matlab.exe")
			if (fs.existsSync(exe)) {
				return exe
			}
		}
		return undefined
	}

	if (plat === "darwin") {
		const apps = "/Applications"
		if (!fs.existsSync(apps)) {
			return undefined
		}
		let names: string[]
		try {
			names = fs
				.readdirSync(apps)
				.filter((d) => d.startsWith("MATLAB_") && d.endsWith(".app"))
				.sort()
				.reverse()
		} catch {
			return undefined
		}
		for (const d of names) {
			const exe = path.join(apps, d, "bin", "matlab")
			if (fs.existsSync(exe)) {
				return exe
			}
		}
		return undefined
	}

	// linux / others: /usr/local/MATLAB/R20xx/bin/matlab
	const linuxBase = "/usr/local/MATLAB"
	if (!fs.existsSync(linuxBase)) {
		return undefined
	}
	let dirs: string[]
	try {
		dirs = fs
			.readdirSync(linuxBase)
			.filter((d) => fs.statSync(path.join(linuxBase, d)).isDirectory())
			.sort()
			.reverse()
	} catch {
		return undefined
	}
	for (const d of dirs) {
		const exe = path.join(linuxBase, d, "bin", "matlab")
		if (fs.existsSync(exe)) {
			return exe
		}
	}
	return undefined
}

function detectMatlabAuto(): string | undefined {
	return tryWhich("matlab") ?? findMatlabOnDisk()
}

function detectOctaveAuto(): string | undefined {
	const o = tryWhich("octave")
	if (o) {
		return o
	}
	if (isWin) {
		return tryWhich("octave-cli") ?? tryWhich("octave-cli.exe")
	}
	return undefined
}

/**
 * Resolve runtime: explicit matlabPath → explicit octavePath → auto MATLAB → auto Octave.
 */
export function resolveMatlabRuntime(): MatlabRuntime | undefined {
	const conf = vscode.workspace.getConfiguration(Package.name)
	const matlabPath = conf.get<string>(MATLAB_CONFIG_KEY, "").trim()
	const octavePath = conf.get<string>(OCTAVE_CONFIG_KEY, "").trim()

	if (matlabPath) {
		const resolved = path.resolve(matlabPath)
		if (fs.existsSync(resolved)) {
			return { kind: "matlab", executable: resolved }
		}
	}
	if (octavePath) {
		const resolved = path.resolve(octavePath)
		if (fs.existsSync(resolved)) {
			return { kind: "octave", executable: resolved }
		}
	}

	const m = detectMatlabAuto()
	if (m) {
		return { kind: "matlab", executable: m }
	}

	const o = detectOctaveAuto()
	if (o) {
		return { kind: "octave", executable: o }
	}

	return undefined
}
