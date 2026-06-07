import { CangjieSymbolIndex } from "./cangjie-lsp/CangjieSymbolIndex"
import {
	CJC_ERROR_PATTERNS,
	matchCjcErrorPattern,
	getMatchingCjcPatternsByCategory,
} from "./cangjie-lsp/CangjieErrorAnalyzer"
import { traceDiagnosticRootCause } from "./cangjie-lsp/cangjieDiagnosticRootCause"
import { getCjpmTreeSummaryForPrompt } from "./cangjie-lsp/cjpmTreeForPrompt"
import { parseCangjieDefinitions, computeCangjieSignature } from "./tree-sitter/cangjieParser"
import { formatCompileHistoryPromptSection } from "./cangjie-lsp/cangjieCompileHistory"
import type {
	ICangjiePromptServices,
	ICangjieSymbolIndex,
	ICangjieErrorAnalyzer,
	ICangjieDiagnosticRootCause,
	ICjpmTreeForPrompt,
	ICangjieParser,
	ICangjieCompileHistory,
} from "./interfaces/ICangjiePromptServices"

class CangjieSymbolIndexAdapter implements ICangjieSymbolIndex {
	constructor(private readonly index: CangjieSymbolIndex) {}
	get fileCount() {
		return this.index.fileCount
	}
	get symbolCount() {
		return this.index.symbolCount
	}
	getAllSymbols() {
		return this.index.getAllSymbols()
	}
	getSymbolsByFile(filePath: string) {
		return this.index.getSymbolsByFile(filePath)
	}
	getSymbolsByDirectory(dirPath: string) {
		return this.index.getSymbolsByDirectory(dirPath)
	}
	getConversionHintFromDiagnosticMessage(message: string) {
		return this.index.getConversionHintFromDiagnosticMessage(message)
	}
}

const cangjieErrorAnalyzerImpl: ICangjieErrorAnalyzer = {
	CJC_ERROR_PATTERNS,
	matchCjcErrorPattern,
	getMatchingCjcPatternsByCategory,
}

const cangjieDiagnosticRootCauseImpl: ICangjieDiagnosticRootCause = {
	traceDiagnosticRootCause,
}

const cjpmTreeForPromptImpl: ICjpmTreeForPrompt = {
	getCjpmTreeSummaryForPrompt,
}

const cangjieParserImpl: ICangjieParser = {
	parseCangjieDefinitions,
	computeCangjieSignature,
}

const cangjieCompileHistoryImpl: ICangjieCompileHistory = {
	formatCompileHistoryPromptSection,
}

export class CangjiePromptServices implements ICangjiePromptServices {
	getCangjieSymbolIndex(): ICangjieSymbolIndex | undefined {
		const idx = CangjieSymbolIndex.getInstance()
		return idx ? new CangjieSymbolIndexAdapter(idx) : undefined
	}

	getCangjieErrorAnalyzer(): ICangjieErrorAnalyzer {
		return cangjieErrorAnalyzerImpl
	}

	getCangjieDiagnosticRootCause(): ICangjieDiagnosticRootCause {
		return cangjieDiagnosticRootCauseImpl
	}

	getCjpmTreeForPrompt(): ICjpmTreeForPrompt {
		return cjpmTreeForPromptImpl
	}

	getCangjieParser(): ICangjieParser {
		return cangjieParserImpl
	}

	getCangjieCompileHistory(): ICangjieCompileHistory {
		return cangjieCompileHistoryImpl
	}
}
