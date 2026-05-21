import * as vscode from "vscode"

import {
	getLanguageConfig,
	extractImportsForLanguage,
	resolveImports,
	formatResolvedContext,
	collectVisibleEditorSymbols,
	LANGUAGE_DISPLAY_NAMES,
} from "../services/ImportContextResolver"

export function getMultiFileContextSection(cwd: string): string {
	const editor = vscode.window.activeTextEditor
	if (!editor) return ""

	const languageId = editor.document.languageId
	const config = getLanguageConfig(languageId)
	if (!config) return ""

	const langName = LANGUAGE_DISPLAY_NAMES[languageId] || languageId

	const sections: string[] = []

	// 1. Symbols from visible editors
	const visibleSymbols = collectVisibleEditorSymbols(languageId, config)
	if (visibleSymbols) sections.push(visibleSymbols)

	// 2. Cross-file symbols from imports
	const content = editor.document.getText()
	const imports = extractImportsForLanguage(content, config, languageId)

	if (imports.length > 0) {
		const resolved = resolveImports(imports, config, cwd, editor.document.fileName)
		if (resolved.length > 0) {
			const formatted = formatResolvedContext(resolved)
			sections.push(
				`## Imported Module Definitions\n\n` +
					`The following symbols are imported in the current file and available for use:\n\n${formatted}`,
			)
		}
	}

	if (sections.length === 0) return ""

	return `====

${langName.toUpperCase()} CROSS-FILE CONTEXT

${sections.join("\n\n")}
`
}

export {
	extractDefs,
	extractImportsForLanguage,
	getLanguageConfig,
	LANGUAGE_CONFIGS,
	type SimpleDef,
	type ImportResult,
	type LanguageImportConfig,
} from "../services/ImportContextResolver"
