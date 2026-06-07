import * as vscode from "vscode"
import { parseCangjieDefinitions, type CangjieDef } from "../tree-sitter/cangjieParser"
import { t } from "../../i18n"

/**
 * Fallback hover provider for Cangjie files. Only contributes when the LSP
 * server hasn't returned hover information (VS Code merges multiple providers).
 * Extracts the full signature line from the parser and displays it.
 */
export class CangjieHoverProvider implements vscode.HoverProvider {
	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): vscode.Hover | undefined {
		const content = document.getText()
		const defs = parseCangjieDefinitions(content)

		const word = document.getText(document.getWordRangeAtPosition(position))
		if (!word) return undefined

		const def = this.findBestMatch(defs, word, position.line)
		if (!def) return undefined

		const sigLine = document.lineAt(def.startLine).text.trim()
		const kindLabel = this.kindLabel(def.kind)

		const md = new vscode.MarkdownString()
		md.appendCodeblock(sigLine, "cangjie")
		if (def.endLine > def.startLine) {
			md.appendMarkdown(
				`\n\n*${kindLabel}* \`${def.name}\` — ${t("tooltips.cangjie_lsp.hover_line_range", { start: def.startLine + 1, end: def.endLine + 1 })}`,
			)
		} else {
			md.appendMarkdown(`\n\n*${kindLabel}* \`${def.name}\``)
		}

		return new vscode.Hover(md)
	}

	private findBestMatch(defs: CangjieDef[], word: string, line: number): CangjieDef | undefined {
		const nameMatches = defs.filter((d) => d.name === word && d.kind !== "import" && d.kind !== "package")
		if (nameMatches.length === 0) return undefined
		if (nameMatches.length === 1) return nameMatches[0]

		const onLine = nameMatches.find((d) => d.startLine === line)
		if (onLine) return onLine

		const containing = nameMatches.find((d) => d.startLine <= line && d.endLine >= line)
		if (containing) return containing

		return nameMatches.reduce((closest, d) =>
			Math.abs(d.startLine - line) < Math.abs(closest.startLine - line) ? d : closest,
		)
	}

	private kindLabel(kind: string): string {
		const labels: Record<string, string> = {
			class: t("tooltips.cangjie_lsp.kind_class"),
			struct: t("tooltips.cangjie_lsp.kind_struct"),
			interface: t("tooltips.cangjie_lsp.kind_interface"),
			enum: t("tooltips.cangjie_lsp.kind_enum"),
			func: t("tooltips.cangjie_lsp.kind_func"),
			main: t("tooltips.cangjie_lsp.kind_main"),
			macro: t("tooltips.cangjie_lsp.kind_macro"),
			extend: t("tooltips.cangjie_lsp.kind_extend"),
			var: t("tooltips.cangjie_lsp.kind_var"),
			let: t("tooltips.cangjie_lsp.kind_let"),
			type_alias: t("tooltips.cangjie_lsp.kind_type_alias"),
		}
		return labels[kind] || kind
	}
}
