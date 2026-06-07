import type { SymbolEntry } from "../cangjie-lsp/CangjieSymbolIndex"
import type { CangjieDef } from "../tree-sitter/cangjieParser"

// ── Re-export types consumed by core/prompts/sections/cangjieContext ─────────
export type { SymbolEntry } from "../cangjie-lsp/CangjieSymbolIndex"
export type { CangjieDef } from "../tree-sitter/cangjieParser"

export interface CjcErrorPattern {
	pattern: RegExp
	category: string
	suggestion: string
	priority?: number
}

export interface DocMapping {
	symbol: string
	docPath: string
}

// ── ICangjieSymbolIndex ──────────────────────────────────────────────────────
export interface ICangjieSymbolIndex {
	fileCount: number
	symbolCount: number
	getAllSymbols(): SymbolEntry[]
	getSymbolsByFile(filePath: string): SymbolEntry[]
	getSymbolsByDirectory(dirPath: string): SymbolEntry[]
	getConversionHintFromDiagnosticMessage(message: string): string | null
}

// ── ICangjieErrorAnalyzer ───────────────────────────────────────────────────
export interface ICangjieErrorAnalyzer {
	CJC_ERROR_PATTERNS: readonly CjcErrorPattern[]
	matchCjcErrorPattern(text: string): CjcErrorPattern | null
	getMatchingCjcPatternsByCategory(text: string): CjcErrorPattern[]
}

// ── ICangjieDiagnosticRootCause ──────────────────────────────────────────────
export interface ICangjieDiagnosticRootCause {
	traceDiagnosticRootCause(
		diagnostic: import("vscode").Diagnostic,
		uri: string | undefined,
		cwd: string,
		diagnosticsByFile?: Map<string, import("vscode").Diagnostic[]>,
	): string | null
}

// ── ICjpmTreeForPrompt ───────────────────────────────────────────────────────
export interface ICjpmTreeForPrompt {
	getCjpmTreeSummaryForPrompt(cwd: string): Promise<string>
}

// ── ICangjieParser ───────────────────────────────────────────────────────────
export interface ICangjieParser {
	parseCangjieDefinitions(content: string): CangjieDef[]
	computeCangjieSignature(lines: string[], def: CangjieDef): string
}

// ── ICangjieCompileHistory ───────────────────────────────────────────────────
export interface ICangjieCompileHistory {
	formatCompileHistoryPromptSection(cwd: string): string | null
}

// ── Aggregated facade for all cangjie prompt services ────────────────────────
export interface ICangjiePromptServices {
	getCangjieSymbolIndex(): ICangjieSymbolIndex | undefined
	getCangjieErrorAnalyzer(): ICangjieErrorAnalyzer
	getCangjieDiagnosticRootCause(): ICangjieDiagnosticRootCause
	getCjpmTreeForPrompt(): ICjpmTreeForPrompt
	getCangjieParser(): ICangjieParser
	getCangjieCompileHistory(): ICangjieCompileHistory
}
