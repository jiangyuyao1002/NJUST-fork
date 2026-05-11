import * as vscode from "vscode"
import { CangjieSymbolIndex } from "./CangjieSymbolIndex"
import type { SymbolEntry } from "./CangjieSymbolIndex"

const TYPE_KINDS = new Set(["class", "struct", "interface", "enum", "extend", "type_alias"])

export class CangjieTypeHierarchyProvider implements vscode.TypeHierarchyProvider {
	constructor(private readonly index: CangjieSymbolIndex) {}

	prepareTypeHierarchy(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<vscode.TypeHierarchyItem[]> {
		const sym = this.index.findEnclosingSymbol(document.uri.fsPath, position.line)
		if (!sym || !TYPE_KINDS.has(sym.kind)) return []

		return [this.symbolToItem(sym)]
	}

	async provideTypeHierarchySupertypes(
		item: vscode.TypeHierarchyItem,
		_token: vscode.CancellationToken,
	): Promise<vscode.TypeHierarchyItem[]> {
		try {
			const fs = await import("fs")
			const content = fs.readFileSync(item.uri.fsPath, "utf-8")
			const lines = content.split("\n")
			const startLine = item.range.start.line
			// Look at the declaration line and next few for extends/implements patterns
			const searchLines = lines.slice(startLine, Math.min(startLine + 8, lines.length)).join(" ")

			// Match: class Foo <: Bar, extend Type <: Base, enum E <: Int, etc.
			const superMatch = searchLines.match(/(?:<:|extends|where)\s+(\w[\w.]*)/g)
			if (!superMatch) return []

			const items: vscode.TypeHierarchyItem[] = []
			for (const m of superMatch) {
				const name = m.replace(/^(?:<:|extends|where)\s+/, "").split(".").pop()!
				const defs = this.index.findDefinitions(name)
				for (const def of defs) {
					if (!TYPE_KINDS.has(def.kind)) continue
					items.push(this.symbolToItem(def))
				}
			}
			return items
		} catch {
			return []
		}
	}

	async provideTypeHierarchySubtypes(
		item: vscode.TypeHierarchyItem,
		_token: vscode.CancellationToken,
	): Promise<vscode.TypeHierarchyItem[]> {
		// Use reverse dependency cache: files that import/depend on this type's file
		const reverseDeps = this.index.getReverseDependencies(item.uri.fsPath)
		const items: vscode.TypeHierarchyItem[] = []

		for (const depFile of reverseDeps) {
			try {
				const fs = await import("fs")
				const content = fs.readFileSync(depFile, "utf-8")
				// Check if this file extends/implements the target type
				if (content.includes(`<: ${item.name}`) || content.includes(`extends ${item.name}`)) {
					const syms = this.index.getSymbolsByFile(depFile)
					for (const sym of syms) {
						if (!TYPE_KINDS.has(sym.kind)) continue
						items.push(this.symbolToItem(sym))
					}
				}
			} catch {
				continue
			}
		}

		return items
	}

	private symbolToItem(sym: SymbolEntry): vscode.TypeHierarchyItem {
		return {
			kind: sym.kind === "interface"
				? vscode.SymbolKind.Interface
				: sym.kind === "enum"
					? vscode.SymbolKind.Enum
					: vscode.SymbolKind.Class,
			name: sym.name,
			detail: sym.signature ?? sym.kind,
			uri: vscode.Uri.file(sym.filePath),
			range: new vscode.Range(sym.startLine, 0, sym.endLine, 0),
			selectionRange: new vscode.Range(sym.startLine, 0, sym.startLine, sym.name.length),
		}
	}
}
