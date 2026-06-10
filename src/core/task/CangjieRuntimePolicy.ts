import path from "path"

import { getMatchingCjcPatternsByCategory, parseCjpmToml } from "../prompts/sections/cangjie-context"
import {
	CRITICAL_SIGNATURE_MODULES,
	SEARCH_GATE_EXEMPT_MODULES,
	extractStdImports,
} from "../tools/cangjiePreflightCheck"

export type CangjieContextIntensity = "compact" | "full"

const PROJECT_CACHE_TTL_MS = 5_000
const ALLOWED_SEGMENT_PREFIXES = [
	"cjpm",
	"cjc",
	"cjfmt",
	"cjlint",
	"cjdb",
	"cjprof",
	"rg",
	"Get-ChildItem",
	"Get-Content",
	"Select-String",
	"dir",
	"ls",
	"cat",
	"type",
	"pwd",
	"echo",
	"cd",
	"Set-Location",
] as const
const BUILD_COMMAND_RE = /\b(?:cjpm\s+(?:build|check)\b|cjc\b)/i
const INIT_COMMAND_RE = /\bcjpm\s+init\b/i
const PACKAGE_DECL_RE = /^\s*package\s+([\w.]+)\s*$/m

type EvidenceSource = "corpus_search" | "corpus_read" | "lsp_hover" | "lsp_definition" | "lsp_symbols"

interface EvidenceRecord {
	source: EvidenceSource
	key: string
	detail?: string
	createdAt: number
}

function normalizeStdModule(moduleName: string): string {
	const parts = moduleName.split(".")
	return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : moduleName
}

function splitCommandSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\|/)
		.map((segment) => segment.trim())
		.filter(Boolean)
}

function stripLeadingDirectoryChange(segment: string): string {
	return segment.replace(/^(?:cd|Set-Location)\s+[^&|;]+$/i, "").trim()
}

function extractStdModuleFromCorpusPath(filePath: string): string | undefined {
	const normalized = filePath.replace(/\\/g, "/")
	const marker = "/libs/std/"
	const idx = normalized.indexOf(marker)
	if (idx < 0) return undefined
	const after = normalized.slice(idx + marker.length)
	const moduleName = after.split("/")[0]
	return moduleName ? `std.${moduleName}` : undefined
}

function normalizeRelPath(relPath: string): string {
	return relPath.replace(/\\/g, "/").replace(/^\.\/+/, "")
}

function inferPackageForProjectPath(relPath: string, srcDir: string, rootPackageName?: string): string | null {
	const normalized = normalizeRelPath(relPath)
	const normalizedSrcDir = normalizeRelPath(srcDir).replace(/\/+$/, "") || "src"
	const prefix = `${normalizedSrcDir}/`
	if (!normalized.startsWith(prefix)) return null
	const afterSrc = normalized.slice(prefix.length)
	const parts = afterSrc.split("/").filter(Boolean)
	if (parts.length <= 1) {
		return rootPackageName || null
	}
	return parts.slice(0, -1).join(".")
}

function countCompilerErrors(output: string): number {
	const matches = output.match(/\berror\b|错误|鍑洪敊/gi)
	return matches?.length ?? (output.trim() ? 1 : 0)
}

function summarizeBuildRootCauses(output: string): string[] {
	const byPattern = getMatchingCjcPatternsByCategory(output)
	if (byPattern.length > 0) {
		return [...new Set(byPattern.map((pattern) => pattern.category))].slice(0, 4)
	}

	const fallback: Array<[RegExp, string]> = [
		[/undeclared|not found|cannot find|未声明|未找到/i, "missing symbol or import"],
		[/package.*mismatch|package.*directory|包.*不一致/i, "package declaration mismatch"],
		[/type mismatch|类型不匹配|expected .* found/i, "type mismatch"],
		[/mut func|cannot call mut|let.*mut/i, "let or mut misuse"],
		[/non-exhaustive|match.*missing|match.*不穷尽/i, "non-exhaustive match"],
	]
	const causes = fallback.filter(([regex]) => regex.test(output)).map(([, label]) => label)
	return causes.length > 0 ? causes.slice(0, 4) : ["unknown compile failure"]
}

export function isAllowedCangjieCommand(command: string): boolean {
	const segments = splitCommandSegments(command)
	if (segments.length === 0) return false

	return segments.every((segment) => {
		const stripped = stripLeadingDirectoryChange(segment)
		if (!stripped) return true
		return ALLOWED_SEGMENT_PREFIXES.some((prefix) => stripped.startsWith(prefix))
	})
}

export class CangjieRuntimePolicy {
	private projectCache: { hasProject: boolean; checkedAt: number } | null = null
	private writeRevision = 0
	private validatedRevision = 0
	private recentBuildSucceeded = true
	private recentBuildFailed = false
	private recentBuildFailureOutput: string | undefined
	private recentBuildRootCauses: string[] = []
	private recentBuildCommand: string | undefined
	private pendingEvidenceModules = new Set<string>()
	private compileFailureRounds = 0
	private stagnantFailureRounds = 0
	private previousFailureSignature: string | undefined
	private previousFailureErrorCount: number | undefined
	private repairDirective: string | undefined

	readonly searchedStdModules = new Set<string>()
	readonly corpusReadModules = new Set<string>()
	readonly corpusReadPaths = new Set<string>()
	readonly queryMemo = new Set<string>()
	readonly evidenceRecords = new Map<string, EvidenceRecord>()

	constructor(private readonly cwd: string) {}

	async hasCjpmProject(): Promise<boolean> {
		const now = Date.now()
		if (this.projectCache && now - this.projectCache.checkedAt < PROJECT_CACHE_TTL_MS) {
			return this.projectCache.hasProject
		}
		const info = await parseCjpmToml(this.cwd).catch(() => null)
		const hasProject = Boolean(info)
		this.projectCache = { hasProject, checkedAt: now }
		return hasProject
	}

	invalidateProjectCache(): void {
		this.projectCache = null
	}

	async ensureProjectInitializedForWrite(relPath: string): Promise<string | null> {
		if (!relPath.toLowerCase().endsWith(".cj")) return null
		if (await this.hasCjpmProject()) return null
		return (
			`Cangjie mode requires a cjpm project before writing ${relPath}. ` +
			`Run a valid "cjpm init --name <name> --type=<type>" command first.`
		)
	}

	validateCommandSurface(command: string): string | null {
		if (isAllowedCangjieCommand(command)) return null
		return (
			`Command rejected in Cangjie mode. Allowed commands are Cangjie toolchain commands ` +
			`(cjpm/cjc/cjfmt/cjlint/cjdb/cjprof) plus read-only helpers such as rg/Get-Content.`
		)
	}

	async validateProjectStructureForWrite(relPath: string, nextContent?: string): Promise<string | null> {
		const normalized = normalizeRelPath(relPath)
		const lowerPath = normalized.toLowerCase()
		if (!lowerPath.endsWith(".cj") && !lowerPath.endsWith("cjpm.toml")) return null

		if (lowerPath.endsWith("cjpm.toml") && nextContent !== undefined) {
			const hasPackage = /^\s*\[package\]\s*$/m.test(nextContent)
			const hasWorkspace = /^\s*\[workspace\]\s*$/m.test(nextContent)
			if (hasPackage && hasWorkspace) {
				return "Invalid cjpm.toml structure: [package] and [workspace] cannot be declared in the same cjpm.toml."
			}
			return null
		}

		if (!lowerPath.endsWith(".cj")) return null
		const info = await parseCjpmToml(this.cwd).catch(() => null)
		if (!info) return null

		const projectRoots = info.isWorkspace
			? (info.members ?? []).map((member) => ({
					prefix: `${normalizeRelPath(member.path).replace(/\/+$/, "")}/${normalizeRelPath((member as { srcDir?: string }).srcDir || "src").replace(/\/+$/, "")}`,
					rootPackageName: member.name,
				}))
			: [{ prefix: normalizeRelPath(info.srcDir || "src").replace(/\/+$/, ""), rootPackageName: info.name }]

		const match = projectRoots.find(
			(root) => normalized === root.prefix || normalized.startsWith(`${root.prefix}/`),
		)
		if (!match) {
			const allowed = projectRoots.map((root) => `${root.prefix}/`).join(", ")
			return `Cangjie source files must be written under the configured source directory. Allowed source roots: ${allowed}. Target: ${relPath}.`
		}

		if (nextContent !== undefined) {
			const declared = nextContent.match(PACKAGE_DECL_RE)?.[1]
			const expected = inferPackageForProjectPath(normalized, match.prefix, match.rootPackageName)
			if (expected && declared && declared !== expected) {
				return `Invalid Cangjie package declaration for ${relPath}: declared "package ${declared}", expected "package ${expected}" from the project source layout.`
			}
			if (expected?.includes(".") && !declared) {
				return `Missing Cangjie package declaration for ${relPath}: expected "package ${expected}" from the project source layout.`
			}
		}

		return null
	}

	noteCorpusSearch(modules: string[], query?: string): void {
		for (const moduleName of modules) {
			const normalized = normalizeStdModule(moduleName)
			this.searchedStdModules.add(normalized)
			this.noteEvidence("corpus_search", normalized, query)
		}
		if (query) {
			this.queryMemo.add(query.trim().toLowerCase())
		}
	}

	noteCorpusReadPath(filePath: string): void {
		this.corpusReadPaths.add(path.resolve(filePath))
		const moduleName = extractStdModuleFromCorpusPath(filePath)
		if (moduleName) {
			const normalized = normalizeStdModule(moduleName)
			this.corpusReadModules.add(normalized)
			this.noteEvidence("corpus_read", normalized, filePath)
		}
	}

	noteLspEvidence(action: "hover" | "definition" | "symbols", key: string, detail?: string): void {
		const source: EvidenceSource =
			action === "hover" ? "lsp_hover" : action === "definition" ? "lsp_definition" : "lsp_symbols"
		this.noteEvidence(source, key.trim(), detail)
	}

	private noteEvidence(source: EvidenceSource, key: string, detail?: string): void {
		if (!key) return
		const normalizedKey = key.toLowerCase()
		this.evidenceRecords.set(`${source}:${normalizedKey}`, {
			source,
			key,
			detail,
			createdAt: Date.now(),
		})
	}

	hasEvidenceForStdModule(moduleName: string): boolean {
		const normalized = normalizeStdModule(moduleName)
		return (
			this.searchedStdModules.has(normalized) ||
			this.corpusReadModules.has(normalized) ||
			CRITICAL_SIGNATURE_MODULES.has(normalized) ||
			SEARCH_GATE_EXEMPT_MODULES.has(normalized)
		)
	}

	getMissingImportEvidence(previousContent: string | undefined, nextContent: string): string[] {
		const previous = new Set(extractStdImports(previousContent ?? "").map(normalizeStdModule))
		const next = extractStdImports(nextContent).map(normalizeStdModule)
		return next.filter((moduleName) => !previous.has(moduleName) && !this.hasEvidenceForStdModule(moduleName))
	}

	noteWriteApplied(relPath: string, previousContent: string | undefined, nextContent: string | undefined): void {
		const lowerPath = relPath.toLowerCase()
		const affectsBuild = lowerPath.endsWith(".cj") || lowerPath.endsWith(".toml")
		if (!affectsBuild) return

		this.writeRevision += 1
		this.recentBuildSucceeded = false
		this.recentBuildFailed = false
		this.recentBuildFailureOutput = undefined
		this.recentBuildRootCauses = []
		this.repairDirective = undefined

		if (lowerPath.endsWith(".cj") && nextContent !== undefined) {
			for (const moduleName of this.getMissingImportEvidence(previousContent, nextContent)) {
				this.pendingEvidenceModules.add(moduleName)
			}
		}
		if (lowerPath.endsWith("cjpm.toml")) {
			this.invalidateProjectCache()
		}
	}

	notePathDeleted(relPath: string): void {
		const lowerPath = relPath.toLowerCase()
		if (!lowerPath.endsWith(".cj") && !lowerPath.endsWith(".toml")) return
		this.writeRevision += 1
		this.recentBuildSucceeded = false
		this.recentBuildFailed = false
		this.recentBuildFailureOutput = undefined
		this.recentBuildRootCauses = []
		this.repairDirective = undefined
	}

	noteBuildResult(command: string, succeeded: boolean, output: string): void {
		if (INIT_COMMAND_RE.test(command) && succeeded) {
			this.invalidateProjectCache()
		}
		if (!BUILD_COMMAND_RE.test(command)) return

		this.recentBuildCommand = command
		this.recentBuildSucceeded = succeeded
		this.recentBuildFailed = !succeeded

		if (succeeded) {
			this.validatedRevision = this.writeRevision
			this.recentBuildFailureOutput = undefined
			this.recentBuildRootCauses = []
			this.pendingEvidenceModules.clear()
			this.compileFailureRounds = 0
			this.stagnantFailureRounds = 0
			this.previousFailureSignature = undefined
			this.previousFailureErrorCount = undefined
			this.repairDirective = undefined
			return
		}

		this.recentBuildFailureOutput = output
		this.recentBuildRootCauses = summarizeBuildRootCauses(output)
		this.compileFailureRounds += 1
		const signature = this.recentBuildRootCauses.join("|")
		const errorCount = countCompilerErrors(output)
		if (
			this.previousFailureSignature === signature &&
			this.previousFailureErrorCount !== undefined &&
			errorCount >= this.previousFailureErrorCount
		) {
			this.stagnantFailureRounds += 1
		} else {
			this.stagnantFailureRounds = 0
		}
		this.previousFailureSignature = signature
		this.previousFailureErrorCount = errorCount
		this.repairDirective = this.buildRepairDirective(errorCount)
	}

	private buildRepairDirective(errorCount: number): string {
		const rootCauses = this.recentBuildRootCauses.slice(0, 2)
		const focus = rootCauses.length > 0 ? rootCauses.join(", ") : "the first compiler error"
		const fallback =
			this.stagnantFailureRounds >= 1
				? "\nFallback required: diagnostics did not improve. Read the directly affected files and gather corpus/LSP evidence before editing again."
				: ""
		return (
			`Cangjie compile-repair directive: fix only the top root cause(s) this round: ${focus}. ` +
			`Current compiler error estimate: ${errorCount}. Re-run cjpm build after the edit and compare diagnostics before attempting completion.` +
			fallback
		)
	}

	getAttemptCompletionBlockReason(): string | null {
		if (this.pendingEvidenceModules.size > 0) {
			return (
				`Completion blocked in Cangjie mode: missing stdlib evidence for ${[...this.pendingEvidenceModules].join(", ")}. ` +
				`Search or read the bundled Cangjie corpus before finishing.`
			)
		}
		if (this.writeRevision > this.validatedRevision) {
			return "Completion blocked in Cangjie mode: Cangjie source or cjpm.toml changed after the last successful build."
		}
		if (this.recentBuildFailed) {
			const causeSummary =
				this.recentBuildRootCauses.length > 0
					? ` Recent root causes: ${this.recentBuildRootCauses.join(", ")}.`
					: ""
			const directive = this.repairDirective ? ` ${this.repairDirective}` : ""
			return `Completion blocked in Cangjie mode: the latest build failed.${causeSummary}${directive}`
		}
		return null
	}

	getContextIntensity(turnIndex: number): CangjieContextIntensity {
		if (this.recentBuildFailed || this.pendingEvidenceModules.size > 0) return "full"
		if (this.writeRevision > this.validatedRevision) return "full"
		return turnIndex > 0 ? "compact" : "full"
	}

	getRecentBuildRootCauses(): string[] {
		return [...this.recentBuildRootCauses]
	}

	getRecentBuildFailureOutput(): string | undefined {
		return this.recentBuildFailureOutput
	}

	getRecentBuildCommand(): string | undefined {
		return this.recentBuildCommand
	}

	getRepairDirective(): string | undefined {
		return this.repairDirective
	}

	getCompileFailureRounds(): number {
		return this.compileFailureRounds
	}

	getStagnantFailureRounds(): number {
		return this.stagnantFailureRounds
	}
}
