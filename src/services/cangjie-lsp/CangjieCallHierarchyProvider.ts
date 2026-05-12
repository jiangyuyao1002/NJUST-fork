import * as vscode from "vscode"
import { CangjieSymbolIndex } from "./CangjieSymbolIndex"
import {  type CangjieDefKind } from "../../services/tree-sitter/cangjieParser"

const CALLABLE_KINDS: Set<CangjieDefKind> = new Set(["func", "main", "init", "macro", "operator"])

export class CangjieCallHierarchyProvider implements vscode.CallHierarchyProvider {
	constructor(private readonly index: CangjieSymbolIndex) {}

	async prepareCallHierarchy(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<vscode.CallHierarchyItem[]> {
		const sym = this.index.findEnclosingSymbol(document.uri.fsPath, position.line)
		if (!sym || !CALLABLE_KINDS.has(sym.kind)) return []

		return [{
			kind: sym.kind === "main" || sym.kind === "init"
				? vscode.SymbolKind.Constructor
				: vscode.SymbolKind.Function,
			name: sym.name,
			detail: sym.signature ?? sym.kind,
			uri: vscode.Uri.file(sym.filePath),
			range: new vscode.Range(sym.startLine, 0, sym.endLine, 0),
			selectionRange: new vscode.Range(sym.startLine, 0, sym.startLine, 100),
		}]
	}

	async provideCallHierarchyIncomingCalls(
		item: vscode.CallHierarchyItem,
		_token: vscode.CancellationToken,
	): Promise<vscode.CallHierarchyIncomingCall[]> {
		const refs = this.index.findReferences(item.name)
		if (!refs.length) return []

		const byFile = new Map<string, vscode.Range[]>()
		for (const ref of refs) {
			const arr = byFile.get(ref.filePath) ?? []
			arr.push(new vscode.Range(ref.line, ref.column, ref.line, ref.column + item.name.length))
			byFile.set(ref.filePath, arr)
		}

		const calls: vscode.CallHierarchyIncomingCall[] = []
		for (const [filePath, ranges] of byFile) {
			const caller = this.index.findEnclosingSymbol(filePath, ranges[0].start.line)
			const name = caller?.name ?? filePath.split("/").pop() ?? filePath
			calls.push({
				from: {
					kind: vscode.SymbolKind.Function,
					name,
					uri: vscode.Uri.file(filePath),
					range: ranges[0],
					selectionRange: ranges[0],
				},
				fromRanges: ranges,
			})
		}

		return calls
	}

	async provideCallHierarchyOutgoingCalls(
		item: vscode.CallHierarchyItem,
		token: vscode.CancellationToken,
	): Promise<vscode.CallHierarchyOutgoingCall[]> {
		if (token.isCancellationRequested) return []

		try {
			const fs = await import("fs")
			const content = fs.readFileSync(item.uri.fsPath, "utf-8")
			const _lines = content.split("\n")
			const callPattern = /\b([A-Z]\w*|[a-z_]\w+)\s*(?=<|!|\.|\()/g

			const calls: vscode.CallHierarchyOutgoingCall[] = []
			const seen = new Set<string>()
			let match: RegExpExecArray | null
			while ((match = callPattern.exec(content)) !== null) {
				const calleeName = match[1]
				if (seen.has(calleeName)) continue
				if (calleeName === item.name) continue
				const defs = this.index.findDefinitions(calleeName)
				if (defs.length === 0 || !defs.some((d) => CALLABLE_KINDS.has(d.kind))) continue
				seen.add(calleeName)

				const callLine = content.substring(0, match.index).split("\n").length - 1
				calls.push({
					to: {
						kind: vscode.SymbolKind.Function,
						name: calleeName,
						uri: item.uri,
						range: new vscode.Range(callLine, match.index, callLine, match.index + calleeName.length),
						selectionRange: new vscode.Range(callLine, match.index, callLine, match.index + calleeName.length),
					},
					fromRanges: [new vscode.Range(callLine, match.index, callLine, match.index + calleeName.length)],
				})
			}

			return calls
		} catch {
			return []
		}
	}
}
