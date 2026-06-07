import { execFile } from "child_process"
import { promisify } from "util"
import { resolveCangjieToolPath, buildCangjieToolEnv } from "./cangjieToolUtils"

const execFileAsync = promisify(execFile)

let sharedTreeCache: { cwd: string; result: string; ts: number } | undefined

// Agent-facing dependency tree prompt section — intentionally kept in Chinese (not i18n'd)

/**
 * Run `cjpm tree` and format a concise prompt section (shared cache, no VS Code OutputChannel).
 * Used by prompt context and may be called from {@link CangjieCompileGuard.getCjpmTreeSummary}.
 */
export async function getCjpmTreeSummaryForPrompt(cwd: string): Promise<string> {
	const now = Date.now()
	if (sharedTreeCache && sharedTreeCache.cwd === cwd && now - sharedTreeCache.ts < 30_000) {
		return sharedTreeCache.result
	}

	const cjpmPath = resolveCangjieToolPath("cjpm", "cangjieTools.cjpmPath")
	if (!cjpmPath) {
		sharedTreeCache = { cwd, result: "", ts: now }
		return ""
	}

	let tree: string | null = null
	try {
		const { stdout, stderr } = await execFileAsync(cjpmPath, ["tree", "-V", "--depth", "3"], {
			timeout: 15_000,
			cwd,
			env: buildCangjieToolEnv() as NodeJS.ProcessEnv,
		})
		const output = (stdout + stderr).trim()
		tree = output.length > 0 ? output : null
	} catch {
		tree = null
	}

	if (!tree) {
		sharedTreeCache = { cwd, result: "", ts: now }
		return ""
	}

	const truncated = tree.length > 2000 ? tree.slice(0, 2000) + "\n…（已截断）" : tree
	const result = `## 仓颉依赖树 (cjpm tree)\n\n\`\`\`\n${truncated}\n\`\`\``
	sharedTreeCache = { cwd, result, ts: now }
	return result
}

/** Clear memo when switching workspace or for tests. */
export function clearCjpmTreePromptCache(): void {
	sharedTreeCache = undefined
}
