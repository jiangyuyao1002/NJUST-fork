import * as path from "path"
import { z } from "zod"

import { BaseTool, type ToolCallbacks } from "./BaseTool"
import type { Task } from "../task/Task"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { formatResponse } from "../prompts/responses"

type LSPAction = "definition" | "references" | "hover" | "symbols" | "implementations"

interface LSPParams {
	action: LSPAction
	filePath: string
	line?: number // 1-based
	character?: number // 1-based
	symbolName?: string // for workspace symbol search
}

/**
 * Map LSP action to vscode command name.
 */
const ACTION_COMMAND_MAP: Record<LSPAction, string> = {
	definition: "vscode.executeDefinitionProvider",
	references: "vscode.executeReferenceProvider",
	hover: "vscode.executeHoverProvider",
	symbols: "vscode.executeWorkspaceSymbolProvider",
	implementations: "vscode.executeImplementationProvider",
}

/**
 * Dynamically load the vscode module. Returns undefined when not running
 * inside a VS Code extension host (e.g. unit-test / CLI environment).
 */
async function getVscodeModule(): Promise<typeof import("vscode") | undefined> {
	try {
		return await import("vscode")
	} catch {
		return undefined
	}
}

/**
 * Format a vscode.Location (or LocationLink) array into readable text.
 */
function formatLocations(locations: UnsafeAny[], cwd: string): string {
	if (!locations || locations.length === 0) {
		return "No results found."
	}
	const lines: string[] = []
	for (const loc of locations) {
		// LocationLink has targetUri/targetRange; Location has uri/range
		const uri = loc.targetUri ?? loc.uri
		const range = loc.targetRange ?? loc.range
		if (!uri || !range) {
			continue
		}
		const filePath = uri.fsPath ?? uri.toString()
		const relPath = path.relative(cwd, filePath)
		const startLine = (range.start?.line ?? 0) + 1
		const startChar = (range.start?.character ?? 0) + 1
		const endLine = (range.end?.line ?? 0) + 1
		lines.push(`${relPath}:${startLine}:${startChar} (to line ${endLine})`)
	}
	return lines.length > 0 ? lines.join("\n") : "No results found."
}

/**
 * Format hover results into readable text.
 */
function formatHoverResults(hovers: UnsafeAny[]): string {
	if (!hovers || hovers.length === 0) {
		return "No hover information available."
	}
	const parts: string[] = []
	for (const hover of hovers) {
		if (!hover?.contents) continue
		const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
		for (const content of contents) {
			if (typeof content === "string") {
				parts.push(content)
			} else if (content?.value) {
				// MarkdownString or MarkedString { language, value }
				parts.push(content.value)
			}
		}
	}
	return parts.length > 0 ? parts.join("\n\n") : "No hover information available."
}

/**
 * Format workspace symbol results into readable text.
 */
function formatSymbolResults(symbols: UnsafeAny[], cwd: string): string {
	if (!symbols || symbols.length === 0) {
		return "No symbols found."
	}
	const lines: string[] = []
	const symbolKindNames: Record<number, string> = {
		0: "File",
		1: "Module",
		2: "Namespace",
		3: "Package",
		4: "Class",
		5: "Method",
		6: "Property",
		7: "Field",
		8: "Constructor",
		9: "Enum",
		10: "Interface",
		11: "Function",
		12: "Variable",
		13: "Constant",
		14: "String",
		15: "Number",
		16: "Boolean",
		17: "Array",
		18: "Object",
		19: "Key",
		20: "Null",
		21: "EnumMember",
		22: "Struct",
		23: "Event",
		24: "Operator",
		25: "TypeParameter",
	}
	for (const sym of symbols) {
		const kindName = symbolKindNames[sym.kind] ?? `Kind(${sym.kind})`
		const loc = sym.location
		if (loc?.uri) {
			const filePath = loc.uri.fsPath ?? loc.uri.toString()
			const relPath = path.relative(cwd, filePath)
			const line = (loc.range?.start?.line ?? 0) + 1
			lines.push(`[${kindName}] ${sym.name} — ${relPath}:${line}`)
		} else {
			lines.push(`[${kindName}] ${sym.name}`)
		}
	}
	return lines.join("\n")
}

export class LSPTool extends BaseTool<"lsp"> {
	readonly name = "lsp" as const

	override get shouldDefer() {
		return true
	}

	override isConcurrencySafe(): boolean {
		return true
	}

	override isReadOnly(): boolean {
		return true
	}

	override userFacingName(): string {
		return "LSP"
	}

	override get searchHint(): string | undefined {
		return "lsp language server definition references hover symbols"
	}

	protected override get inputSchema() {
		return z.object({
			action: z.enum(["definition", "references", "hover", "symbols", "implementations"]),
			filePath: z.string().min(1, "filePath is required"),
			line: z.number().int().positive().optional(),
			character: z.number().int().positive().optional(),
			symbolName: z.string().optional(),
		})
	}

	override validateInput(params: LSPParams) {
		const { action, line, character, symbolName } = params
		if (action === "symbols") {
			if (!symbolName || symbolName.trim().length === 0) {
				return { valid: false, error: "symbolName is required for the 'symbols' action." }
			}
		} else {
			if (line === undefined || character === undefined) {
				return {
					valid: false,
					error: `line and character are required for the '${action}' action.`,
				}
			}
		}
		return { valid: true }
	}

	async execute(params: LSPParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { action, filePath, line, character, symbolName } = params

		try {
			const vscode = await getVscodeModule()
			if (!vscode) {
				pushToolResult(
					"LSP tool is not available in the current environment. " +
						"This tool requires VS Code extension host to access language server features. " +
						"Please use alternative tools (grep, codebase_search) for code navigation.",
				)
				return
			}

			const absolutePath = path.resolve(task.cwd, filePath)
			const relPath = path.relative(task.cwd, absolutePath)

			// Block LSP operations on files outside workspace for safety
			if (isPathOutsideWorkspace(absolutePath)) {
				pushToolResult(
					formatResponse.toolError(
						`Safety: cannot perform LSP operations on path outside workspace: ${relPath}`,
					),
				)
				return
			}

			// Approval
			const approved = await askApproval(
				"tool",
				JSON.stringify({
					tool: "lsp",
					action,
					path: relPath,
					...(line !== undefined && { line }),
					...(character !== undefined && { character }),
					...(symbolName && { symbolName }),
				}),
			)
			if (!approved) {
				return
			}

			let resultText: string

			if (action === "symbols") {
				// Workspace symbol search doesn't need a document/position
				const command = ACTION_COMMAND_MAP[action]
				const results = await vscode.commands.executeCommand<UnsafeAny[]>(command, symbolName)
				resultText = formatSymbolResults(results, task.cwd)
				if (task.taskMode === "cangjie" && symbolName && resultText !== "No symbols found.") {
					task.cangjieRuntimePolicy.noteLspEvidence("symbols", symbolName, resultText.slice(0, 1000))
				}
			} else {
				// Open the document and create a position
				const uri = vscode.Uri.file(absolutePath)
				const document = await vscode.workspace.openTextDocument(uri)
				// Convert 1-based user input to 0-based VS Code API
				const position = new vscode.Position((line ?? 1) - 1, (character ?? 1) - 1)

				const command = ACTION_COMMAND_MAP[action]
				const results = await vscode.commands.executeCommand<UnsafeAny[]>(command, document.uri, position)

				if (action === "hover") {
					resultText = formatHoverResults(results)
				} else {
					resultText = formatLocations(results, task.cwd)
				}
				if (
					task.taskMode === "cangjie" &&
					(action === "hover" || action === "definition") &&
					!/^No (hover information available|results found)\./.test(resultText)
				) {
					task.cangjieRuntimePolicy.noteLspEvidence(
						action,
						`${relPath}:${line}:${character}`,
						resultText.slice(0, 1000),
					)
				}
			}

			pushToolResult(resultText)
		} catch (error) {
			await handleError("LSP query", error instanceof Error ? error : new Error(String(error)))
		} finally {
			this.resetPartialState()
		}
	}
}

export const lspTool = new LSPTool()
