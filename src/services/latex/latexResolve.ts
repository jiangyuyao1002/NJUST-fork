import * as fs from "fs"
import * as path from "path"
import * as os from "os"

const isWin = process.platform === "win32"

/** Typical MiKTeX installs (Windows). */
const MIKTEX_LATEXMK: string[] = isWin
	? [
			path.join(process.env.ProgramFiles ?? "C:\\Program Files", "MiKTeX", "miktex", "bin", "x64", "latexmk.exe"),
			path.join(
				process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
				"MiKTeX",
				"miktex",
				"bin",
				"x64",
				"latexmk.exe",
			),
		]
	: []

/** Typical MiKTeX pdflatex (Windows). */
const MIKTEX_PDFLATEX: string[] = isWin
	? [
			path.join(
				process.env.ProgramFiles ?? "C:\\Program Files",
				"MiKTeX",
				"miktex",
				"bin",
				"x64",
				"pdflatex.exe",
			),
			path.join(
				process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
				"MiKTeX",
				"miktex",
				"bin",
				"x64",
				"pdflatex.exe",
			),
		]
	: []

function firstExisting(paths: string[]): string | undefined {
	for (const p of paths) {
		try {
			if (p && fs.existsSync(p)) return p
		} catch {
			// intentionally ignored: file existence check
		}
	}
	return undefined
}

/**
 * Discover TeX Live Windows `bin\win32` latexmk (e.g. C:\texlive\2024\bin\win32\latexmk.exe).
 */
function findTexliveWin32(tool: "latexmk.exe" | "pdflatex.exe"): string | undefined {
	if (!isWin) return undefined
	const roots = ["C:\\texlive", "D:\\texlive", path.join(os.homedir(), "texlive")]
	for (const root of roots) {
		if (!fs.existsSync(root)) continue
		try {
			const years = fs
				.readdirSync(root)
				.filter((d) => /^\d{4}$/.test(d))
				.sort()
				.reverse()
			for (const y of years) {
				const candidate = path.join(root, y, "bin", "win32", tool)
				if (fs.existsSync(candidate)) return candidate
			}
		} catch {
			// intentionally ignored: directory listing may fail
		}
	}
	return undefined
}

/**
 * Resolve latexmk: user setting first, then common MiKTeX/TeX Live paths on Windows, else "latexmk" (PATH).
 */
export function resolveLatexmkExecutable(configured?: string): string {
	const c = configured?.trim()
	if (c && fs.existsSync(c)) return c
	const hit = firstExisting(MIKTEX_LATEXMK) ?? findTexliveWin32("latexmk.exe")
	return hit ?? "latexmk"
}

/**
 * Resolve pdflatex: user setting first, then common paths, else "pdflatex" (PATH).
 */
export function resolvePdflatexExecutable(configured?: string): string {
	const c = configured?.trim()
	if (c && fs.existsSync(c)) return c
	const hit = firstExisting(MIKTEX_PDFLATEX) ?? findTexliveWin32("pdflatex.exe")
	return hit ?? "pdflatex"
}
