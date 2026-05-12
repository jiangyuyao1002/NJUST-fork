import * as vscode from "vscode"
import { CangjieSymbolIndex } from "./CangjieSymbolIndex"


const KIND_TO_ICON: Record<string, vscode.SymbolKind> = {
	class: vscode.SymbolKind.Class,
	struct: vscode.SymbolKind.Struct,
	interface: vscode.SymbolKind.Interface,
	enum: vscode.SymbolKind.Enum,
	func: vscode.SymbolKind.Function,
	main: vscode.SymbolKind.Function,
	macro: vscode.SymbolKind.Function,
	var: vscode.SymbolKind.Variable,
	let: vscode.SymbolKind.Variable,
	prop: vscode.SymbolKind.Property,
	package: vscode.SymbolKind.Package,
	import: vscode.SymbolKind.Module,
	type_alias: vscode.SymbolKind.TypeParameter,
	extend: vscode.SymbolKind.Class,
	init: vscode.SymbolKind.Constructor,
	operator: vscode.SymbolKind.Operator,
	enum_case: vscode.SymbolKind.EnumMember,
}

export class CangjieWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
	constructor(private readonly index: CangjieSymbolIndex) {}

	async provideWorkspaceSymbols(
		query: string,
		_token: vscode.CancellationToken,
	): Promise<vscode.SymbolInformation[]> {
		if (!query || query.length < 2) return []

		const symbols = this.index.findSymbolsByPrefix(query, 50)

		return symbols.map((sym) => {
			return new vscode.SymbolInformation(
				sym.name,
				KIND_TO_ICON[sym.kind] ?? vscode.SymbolKind.Object,
				`${sym.kind}${sym.signature ? " " + sym.signature : ""}`,
				new vscode.Location(
					vscode.Uri.file(sym.filePath),
					new vscode.Range(sym.startLine, 0, sym.endLine, 0),
				),
			)
		})
	}
}
