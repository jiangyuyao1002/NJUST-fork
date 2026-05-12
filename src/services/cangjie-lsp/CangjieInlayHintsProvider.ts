import * as vscode from "vscode"
import { parseCangjieDefinitions } from "../../services/tree-sitter/cangjieParser"

export class CangjieInlayHintsProvider implements vscode.InlayHintsProvider {
	async provideInlayHints(
		document: vscode.TextDocument,
		_range: vscode.Range,
		token: vscode.CancellationToken,
	): Promise<vscode.InlayHint[]> {
		const hints: vscode.InlayHint[] = []
		if (token.isCancellationRequested) return hints

		const content = document.getText()
		const defs = parseCangjieDefinitions(content)

		for (const def of defs) {
			// Type hint for var/let declarations
			if ((def.kind === "var" || def.kind === "let") && def.signature) {
				const typeMatch = def.signature.match(/:\s*(\S[\w<>, ]*)/)
				if (typeMatch) {
					const line = def.startLine
					const lineText = document.lineAt(line).text
					const nameIdx = lineText.indexOf(def.name)
					if (nameIdx !== -1 && nameIdx + def.name.length < lineText.length) {
						const pos = new vscode.Position(line, nameIdx + def.name.length)
						hints.push({
							position: pos,
							label: `: ${typeMatch[1]}`,
							kind: vscode.InlayHintKind.Type,
							paddingLeft: true,
						})
					}
				}
			}
		}

		return hints
	}
}
