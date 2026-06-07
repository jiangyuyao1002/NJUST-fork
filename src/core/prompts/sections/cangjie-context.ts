// Agent-facing prompt templates — Chinese strings are intentionally kept in Chinese
// to match Cangjie compiler error output and provide context to the LLM.
// Do NOT i18n these strings; they target the AI agent, not the VS Code UI.
import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

import type { CangjieContextIntensity } from "../../task/CangjieRuntimePolicy"
import type { ICangjiePromptServices } from "../../../services/interfaces/ICangjiePromptServices"
import { CangjiePromptServices } from "../../../services/CangjiePromptServices"
import {
	DEFAULT_CANGJIE_CONTEXT_TOKEN_BUDGET,
	estimateCangjieContextTokensForTest,
	estimateContextTokens,
	addPrioritized,
	buildMandatoryCorpusFooter,
	packSectionsWithTokenBudget,
	simpleHash,
	type PrioritizedCangjieSection,
} from "./cangjieContext/budget"
import { STDLIB_CRITICAL_SIGNATURES } from "./cangjieContext/stdlibSignatures"
import { getLearnedFixesFileMtime } from "./learnedFixesStorage"
import {
	extractImports as _extractImports,
	mapImportsToDocPaths as _mapImportsToDocPaths,
	resolveImportedSymbols as _resolveImportedSymbols,
} from "./CangjieImportParser"
import {
	buildCangjieExecuteCommandErrorAppendix as buildCangjieExecuteCommandErrorAppendixFromModule,
	enhanceCjcErrorOutput as enhanceCjcErrorOutputFromModule,
	getErrorFixDirective as getErrorFixDirectiveFromModule,
} from "./CangjiePromptErrorAnalysis"
import { resolveBundledCangjieCorpusPath, resolveCangjieDocsBasePath } from "./CangjieDocsResolver"
import {
	collectActiveCangjieEditorSnapshot as _collectActiveCangjieEditorSnapshot,
	getActiveCangjieFileInfo as _getActiveCangjieFileInfo,
	type StructuredEditingContextPreparse,
} from "./CangjieSymbolExtractor"
import {
	buildCompactProjectOverviewSection,
	buildWorkspaceSymbolSummary,
	getCachedPackageHierarchy,
	getCjpmTreeSection,
	invalidateCjpmProjectParserCaches,
	parseCjpmToml,
	parseCjpmTomlWithMeta,
	scanPackageHierarchy,
	verifyPackageDeclarations,
} from "./cangjieContext/cjpmProjectParser"
import {
	buildConversionHintByMessage,
	buildDiagnosticAugmentationLines,
	collectDiagnosticSnapshot,
	mapDiagnosticsToDocContext,
	sampleCangjieDiagnostics,
} from "./cangjieContext/diagnosticHandling"
import {
	bumpCangjieL3TtlConfigCache,
	computeContextCacheKey,
	deleteContextSectionInFlight,
	detectCangjieRelevanceForAuxiliaryModes,
	getCachedContextSection,
	getCachedHeavyContext,
	getCachedProjectOverview,
	getContextSectionInFlight,
	getCangjieSystemPromptCacheKeySuffix,
	invalidateCangjieContextSectionCacheState,
	invalidateCangjieL3ContextCacheState,
	setCachedContextSection,
	setCachedHeavyContext,
	setCachedProjectOverview,
	setContextSectionInFlight,
	userMessageSuggestsCangjie,
	type HeavyContextBundle,
} from "./cangjieContext/cacheManagement"
import { buildContextualCodingRules } from "./cangjieContext/contextualCodingRules"
import {
	buildAutoCorpusSearchSection,
	buildAutoCorpusQueries,
	buildCompileErrorCorpusSearch,
	buildCorpusExtraFewShotSection,
	buildStdlibSignatureHintsSection,
} from "./cangjieContext/corpusQueryBuilding"
import {
	buildCangjieStyleFewShotSection,
	invalidateLearnedFixMatchingCaches,
	loadLearnedFixesSection,
	recordLearnedFailure,
	recordLearnedFix,
	testLearnedFixPatternMatchesMessage,
	testNormalizeLearnedFixText,
} from "./cangjieContext/learnedFixMatching"
import {
	buildStructuredEditingContext,
	invalidateStructuredEditingContextCache,
} from "./cangjieContext/structuredEditingContext"

let _cangjieServices: ICangjiePromptServices | undefined

export function setCangjiePromptServices(services: ICangjiePromptServices): void {
	_cangjieServices = services
}

export function getCangjiePromptServices(): ICangjiePromptServices {
	if (!_cangjieServices) {
		// Lazy-init with default implementation so module-level code that calls
		// getCangjiePromptServices() during import does not crash.
		_cangjieServices = new CangjiePromptServices()
	}
	return _cangjieServices
}

export { bumpCangjieL3TtlConfigCache }
export { detectCangjieRelevanceForAuxiliaryModes, getCangjieSystemPromptCacheKeySuffix, userMessageSuggestsCangjie }
export { recordLearnedFix, recordLearnedFailure }
export { testLearnedFixPatternMatchesMessage, testNormalizeLearnedFixText }
export type { StructuredEditingContextPreparse } from "./CangjieSymbolExtractor"

export function invalidateCangjieContextSectionCache(): void {
	invalidateCangjieContextSectionCacheState()
	invalidateCjpmProjectParserCaches()
	invalidateLearnedFixMatchingCaches()
	invalidateStructuredEditingContextCache()
}

export function invalidateCangjieL3ContextCache(): void {
	invalidateCangjieL3ContextCacheState()
}

export async function getCangjieContextSection(
	cwd: string,
	mode: string,
	extensionPath?: string,
	tokenBudget: number = DEFAULT_CANGJIE_CONTEXT_TOKEN_BUDGET,
	globalStoragePath?: string,
	lastUserHintForRelevance?: string,
	contextIntensity: CangjieContextIntensity = "full",
	recentBuildRootCauses: string[] = [],
	repairDirective?: string,
): Promise<string> {
	const runCangjieContext =
		mode === "cangjie" ||
		((mode === "ask" || mode === "architect") &&
			detectCangjieRelevanceForAuxiliaryModes(cwd, lastUserHintForRelevance))
	if (!runCangjieContext) return ""

	const diagSnapshot = collectDiagnosticSnapshot()
	const contextSectionKey = `${await computeContextCacheKey(cwd, diagSnapshot.diagSummaryHash)}|tb:${tokenBudget}|m:${mode}|intensity:${contextIntensity}|rc:${simpleHash(recentBuildRootCauses.join("|"))}|rd:${simpleHash(repairDirective ?? "")}`
	const now = Date.now()
	const cachedContextSection = getCachedContextSection(contextSectionKey, now)
	if (cachedContextSection) return cachedContextSection

	const inflight = getContextSectionInFlight(contextSectionKey)
	if (inflight) return inflight

	const p = (async (): Promise<string> => {
		const docsBase = resolveCangjieDocsBasePath(extensionPath)
		let docsExist = false
		if (docsBase != null) {
			try {
				await fs.promises.access(docsBase)
				docsExist = true
			} catch {
				docsExist = false
			}
		}
		const includeHeavyContext = contextIntensity === "full"

		const prioritized: PrioritizedCangjieSection[] = []
		let treeSectionPromise: Promise<string | null> = Promise.resolve(null)
		let styleFewShot: string | null = null

		const activeFileInfo = _getActiveCangjieFileInfo()

		// 0a. Project structure context (cjpm.toml) - L1 cache
		const { info: projectInfo, cjpmRawHash } = await parseCjpmTomlWithMeta(cwd)
		if (projectInfo) {
			const projectOverviewKey = `${cwd}|${cjpmRawHash}|active:${activeFileInfo?.packageName ?? "-"}`
			let overview = getCachedProjectOverview(projectOverviewKey, now)
			if (overview === null) {
				overview = await buildCompactProjectOverviewSection(
					cwd,
					projectInfo,
					activeFileInfo?.packageName ?? null,
					activeFileInfo?.filePath ?? null,
				)
				setCachedProjectOverview(projectOverviewKey, overview, now)
			}
			addPrioritized(prioritized, 490, overview)
		}

		// 0b. package declaration verification + cjpm tree
		if (projectInfo && includeHeavyContext) {
			if (!projectInfo.isWorkspace) {
				const rootPkgName = projectInfo.name || undefined
				const pkgTree = await getCachedPackageHierarchy(cwd, projectInfo.srcDir, rootPkgName)
				if (pkgTree) {
					const pkgMismatches = await verifyPackageDeclarations(pkgTree, cwd, projectInfo.srcDir)
					addPrioritized(prioritized, 515, pkgMismatches || undefined)
				}
			} else {
				for (const member of projectInfo.members || []) {
					const memberCwd = path.join(cwd, member.path)
					const memberTree = await getCachedPackageHierarchy(memberCwd, "src", member.name)
					if (memberTree) {
						const pkgMismatches = await verifyPackageDeclarations(memberTree, memberCwd, "src")
						addPrioritized(prioritized, 515, pkgMismatches || undefined)
					}
				}
			}

			// cjpm tree — started in parallel; awaited below
			treeSectionPromise = getCjpmTreeSection(cwd)
		}

		// Collect imports + symbols from visible editors (single pass)
		const { imports, symbols: editorSymbolsSnapshot, activePreparse } = _collectActiveCangjieEditorSnapshot()
		const rawDiagnostics = diagSnapshot.allCjDiags
		const rawErrorCount = rawDiagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length

		// Symbol scanning, import analysis, and doc mapping are only performed
		// when a cjpm.toml project exists, to keep context lightweight otherwise.
		if (projectInfo && includeHeavyContext) {
			const idx = getCangjiePromptServices().getCangjieSymbolIndex()
			const importsHash = simpleHash([...imports].sort().join("|"))
			const learnedFixesMtime = getLearnedFixesFileMtime(cwd)
			const heavyContextKey = [
				cwd,
				`idx:${idx?.fileCount ?? 0}:${idx?.symbolCount ?? 0}`,
				`imports:${imports.length}:${importsHash}`,
				`lf:${learnedFixesMtime}`,
				`ws:${projectInfo.isWorkspace ? 1 : 0}`,
			].join("::")
			let heavyBundle: HeavyContextBundle | null = getCachedHeavyContext(heavyContextKey, now)
			if (!heavyBundle) {
				heavyBundle = {
					symbols: editorSymbolsSnapshot,
					importedSymbols: _resolveImportedSymbols(imports, cwd, projectInfo),
					stdlibHints: await buildStdlibSignatureHintsSection(imports, docsBase, globalStoragePath),
					workspaceSummary: projectInfo.isWorkspace
						? await buildWorkspaceSymbolSummary(projectInfo, cwd)
						: null,
					fewShot: await buildCangjieStyleFewShotSection(cwd, imports, rawDiagnostics, cjpmRawHash),
				}
				setCachedHeavyContext(heavyContextKey, heavyBundle, now)
			}
			styleFewShot = heavyBundle.fewShot
			addPrioritized(prioritized, 380, heavyBundle.symbols || undefined)
			addPrioritized(prioritized, 390, heavyBundle.importedSymbols || undefined)
			addPrioritized(prioritized, 395, heavyBundle.stdlibHints || undefined)
			if (includeHeavyContext) {
				addPrioritized(prioritized, 528, heavyBundle.workspaceSummary || undefined)
			}

			// 1. Import-based documentation context
			if (includeHeavyContext && imports.length > 0 && docsBase && docsExist) {
				const docMappings = _mapImportsToDocPaths(imports)
				if (docMappings.length > 0) {
					const importContext = docMappings
						.map((m) => {
							const paths = m.docPaths.map((p) => p.replace(/\\/g, "/")).join(", ")
							return `- \`${m.prefix}\`: ${m.summary} (请视需检索: ${paths})`
						})
						.join("\n")

					addPrioritized(
						prioritized,
						350,
						`## 当前代码涉及的重要模块映射\n\n当前代码中已引入以下高级模块。若后续编写代码缺乏十足把握，强烈建议立刻使用 \`search_files\`（regex 搜索）检索这些官方库示例：\n\n${importContext}`,
					)
				}
			}
		}

		const diagSample = sampleCangjieDiagnostics(rawDiagnostics)
		const diagnostics = diagSample.sampled
		const conversionByMessage = buildConversionHintByMessage(diagnostics)
		const errorSections =
			diagnostics.length > 0 && docsBase && docsExist
				? mapDiagnosticsToDocContext(diagnostics, docsBase, conversionByMessage)
				: []

		if (includeHeavyContext) {
			addPrioritized(
				prioritized,
				95,
				getCangjiePromptServices().getCangjieCompileHistory().formatCompileHistoryPromptSection(cwd),
			)
		}

		if (recentBuildRootCauses.length > 0) {
			addPrioritized(
				prioritized,
				92,
				`## Recent Cangjie Build Root Causes\n- ${recentBuildRootCauses.slice(0, 4).join("\n- ")}`,
			)
		}

		if (repairDirective) {
			addPrioritized(prioritized, 93, `## Cangjie Compile-Repair Directive\n${repairDirective}`)
		}

		// 1b. Dynamic coding rules injection (context-aware).
		addPrioritized(
			prioritized,
			650,
			buildContextualCodingRules(imports, projectInfo, rawDiagnostics, errorSections.length > 0) || undefined,
		)
		if (includeHeavyContext) {
			addPrioritized(prioritized, 850, styleFewShot || undefined)
		}

		// 2. Error/diagnostic context (sampled + merged messages for prompt), kept late in final order.
		let diagnosticSection: string | null = null
		if (errorSections.length > 0) {
			const omitNote =
				diagSample.omitted > 0
					? `\n\n_共 ${diagSample.total} 条诊断，以上展示经重要性筛选与消息合并；另有 ${diagSample.omitted} 条未列出。_`
					: ""
			diagnosticSection = `## 当前诊断错误与修复建议\n\n检测到以下编译/检查错误，建议参考对应文档修复：\n\n${errorSections.join("\n")}${omitNote}`
			const aug = buildDiagnosticAugmentationLines(diagnostics, cwd, conversionByMessage, diagSnapshot.byFile)
			if (aug.length > 0) {
				diagnosticSection += `\n\n### 辅助定位（根因/类型转换）\n${aug.join("\n")}`
			}
			addPrioritized(prioritized, 90, diagnosticSection)
		}

		// 2a. Intent-matched few-shot from bundled corpus extra/
		if (includeHeavyContext && docsBase && docsExist) {
			addPrioritized(
				prioritized,
				750,
				(await buildCorpusExtraFewShotSection(docsBase, imports, rawDiagnostics)) || undefined,
			)
		}

		// 2b. Auto-inject corpus search results based on imports and diagnostics
		if (includeHeavyContext && docsBase && docsExist) {
			addPrioritized(
				prioritized,
				550,
				(await buildAutoCorpusSearchSection(docsBase, imports, diagnostics)) || undefined,
			)
		}

		const mandatoryFooter = buildMandatoryCorpusFooter(docsBase, docsExist)

		// 4. Structured editing context + awaiting parallel promises
		const activeEd = vscode.window.activeTextEditor
		let structuredPre: StructuredEditingContextPreparse | undefined
		if (activeEd && (activeEd.document.languageId === "cangjie" || activeEd.document.fileName.endsWith(".cj"))) {
			structuredPre = activePreparse
				? { ...activePreparse, diagnosticsByFile: diagSnapshot.byFile }
				: (() => {
						const c = activeEd.document.getText()
						return {
							content: c,
							lines: c.split("\n"),
							imports: _extractImports(c),
							defs: getCangjiePromptServices().getCangjieParser().parseCangjieDefinitions(c),
							diagnosticsByFile: diagSnapshot.byFile,
						}
					})()
		}
		const [editingCtx, treeSection] = await Promise.all([
			buildStructuredEditingContext(structuredPre),
			treeSectionPromise,
		])
		addPrioritized(prioritized, 525, treeSection || undefined)
		addPrioritized(prioritized, 150, editingCtx || undefined)

		// 5. Project-curated learned fixes (optional JSON in .njust_ai/)
		addPrioritized(prioritized, 250, loadLearnedFixesSection(cwd, rawDiagnostics) || undefined)

		const diagTokensEstimate = diagnosticSection ? estimateContextTokens(diagnosticSection) : 0
		const packed = packSectionsWithTokenBudget(prioritized, mandatoryFooter, Math.max(500, tokenBudget), {
			rawErrorCount,
			totalDiagnosticCount: rawDiagnostics.length,
			diagnosticSectionMinTokens: rawErrorCount > 0 ? Math.min(Math.max(diagTokensEstimate, 480), 1200) : 0,
		})
		if (diagnosticSection) {
			const idx = packed.indexOf(diagnosticSection)
			if (idx >= 0) {
				packed.splice(idx, 1)
				packed.push(diagnosticSection)
			}
		}
		if (packed.length === 0) return ""

		const auxiliaryNote =
			mode === "ask" || mode === "architect"
				? "\n（以下仓颉语料与工程上下文仅供查阅；请保持当前 Ask/Architect 模式的角色与职责。）"
				: ""

		const result = `====

CANGJIE DEVELOPMENT CONTEXT${auxiliaryNote}

${packed.join("\n\n")}
`
		setCachedContextSection(contextSectionKey, result)
		return result
	})()
	setContextSectionInFlight(contextSectionKey, p)
	void p.finally(() => deleteContextSectionInFlight(contextSectionKey))
	return p
}

/**
 * Enhance a cjc/cjlint error message with documentation references and fix suggestions.
 * Called when terminal output contains compilation errors.
 */

export function enhanceCjcErrorOutput(errorOutput: string, cwd: string, extensionPath?: string): Promise<string> {
	return enhanceCjcErrorOutputFromModule(errorOutput, cwd, extensionPath)
}

/**
 * Single appendix for **execute_command** on cjpm/cjc failure: either per-`==>` blocks with
 * nearby source + pattern hints (no duplicate tail blob), or {@link enhanceCjcErrorOutput} when
 * the output has no `==>` headers.
 */
export function buildCangjieExecuteCommandErrorAppendix(
	output: string,
	cwd: string,
	extensionPath?: string,
): Promise<string> {
	return buildCangjieExecuteCommandErrorAppendixFromModule(output, cwd, extensionPath)
}

// Error fix directives are now defined in CangjieErrorAnalyzer.ts; re-export here.
export const getErrorFixDirective = getErrorFixDirectiveFromModule

// Re-export for testing and backward compatibility
export {
	_extractImports,
	_extractImports as extractImports,
	_mapImportsToDocPaths,
	STDLIB_CRITICAL_SIGNATURES,
	DEFAULT_CANGJIE_CONTEXT_TOKEN_BUDGET,
	estimateCangjieContextTokensForTest,
	parseCjpmToml,
	scanPackageHierarchy,
	_resolveImportedSymbols,
	resolveBundledCangjieCorpusPath,
	resolveCangjieDocsBasePath,
	verifyPackageDeclarations,
	buildWorkspaceSymbolSummary,
	buildStructuredEditingContext,
	buildCompileErrorCorpusSearch,
	buildAutoCorpusQueries,
}
// Barrel re-exports for downstream consumers:
// - activate/CodeActionProvider.ts uses matchCjcErrorPattern
// - core/task/CangjieRuntimePolicy.ts uses getMatchingCjcPatternsByCategory
// TODO: migrate these consumers to use ICangjiePromptServices, then remove this block.
export {
	CJC_ERROR_PATTERNS,
	STDLIB_DOC_MAP,
	matchCjcErrorPattern,
	getMatchingCjcPatternsByCategory,
	type CjcErrorPattern,
	type DocMapping,
} from "../../../services/cangjie-lsp/CangjieErrorAnalyzer"
