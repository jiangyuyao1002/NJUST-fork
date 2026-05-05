import * as vscode from "vscode"
import * as path from "path"

/**
 * Infer `package a.b.c` from file path under workspace `src/` or parallel `test/` tree.
 * `test/x/y/z.cj` uses the same dot-segments as `src/x/y` would (package x.y for file directly under test/).
 */
export function inferCangjiePackageFromSrcLayout(documentUri: vscode.Uri): string | undefined {
	const folder = vscode.workspace.getWorkspaceFolder(documentUri)
	if (!folder) return undefined
	const wf = folder.uri.fsPath
	const srcDir = path.join(wf, "src")
	const testDir = path.join(wf, "test")
	const dir = path.dirname(documentUri.fsPath)
	const normDir = dir.replace(/\\/g, "/").toLowerCase()
	const normTest = testDir.replace(/\\/g, "/").toLowerCase()
	const normSrc = srcDir.replace(/\\/g, "/").toLowerCase()

	if (normDir === normTest || normDir.startsWith(normTest + "/")) {
		const rel = path.relative(testDir, dir)
		if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined
		if (!rel || rel === ".") return "main"
		return rel.split(path.sep).join(".")
	}

	if (normDir === normSrc || normDir.startsWith(normSrc + "/")) {
		const rel = path.relative(srcDir, dir)
		if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined
		if (!rel || rel === ".") return "main"
		return rel.split(path.sep).join(".")
	}
	return undefined
}
