import * as vscode from "vscode"
import { parseCangjieDefinitions } from "../../services/tree-sitter/cangjieParser"

const KIND_TO_TOKEN_TYPE: Record<string, string> = {
	class: "type",
	struct: "type",
	interface: "type",
	enum: "type",
	type_alias: "type",
	func: "function",
	main: "function",
	macro: "macro",
	var: "variable",
	let: "variable",
	prop: "property",
	import: "namespace",
	package: "namespace",
}

const KIND_TO_MODIFIER: Record<string, string[]> = {
	operator: ["declaration"],
	init: ["declaration"],
	extend: ["declaration"],
}


export class CangjieSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
	private static readonly _legend = new vscode.SemanticTokensLegend(
		["type", "function", "macro", "variable", "property", "namespace", "operator", "decorator"],
		["declaration", "readonly"],
	)
	static get legend(): vscode.SemanticTokensLegend { return CangjieSemanticTokensProvider._legend }
	async provideDocumentSemanticTokens(
		document: vscode.TextDocument,
	): Promise<vscode.SemanticTokens> {
		const builder = new vscode.SemanticTokensBuilder(CangjieSemanticTokensProvider._legend)
		const content = document.getText()
		const defs = parseCangjieDefinitions(content)

		for (const def of defs) {
			const tokenType = KIND_TO_TOKEN_TYPE[def.kind]
			if (!tokenType) continue

			const line = def.startLine
			const lineText = document.lineAt(line).text
			const nameIdx = lineText.indexOf(def.name)
			if (nameIdx === -1) continue

			const modifierFlags = KIND_TO_MODIFIER[def.kind] ?? []
			builder.push(
				new vscode.Range(line, nameIdx, line, nameIdx + def.name.length),
				tokenType,
				modifierFlags,
			)
		}

		return builder.build()
	}
}
