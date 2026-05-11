import * as vscode from "vscode"

import type { ClineProvider } from "../core/webview/ClineProvider"
import { getErrorMessage } from "../shared/error-utils"

interface ToolDefinition {
	name: string
	displayName: string
	description: string
	inputSchema: Record<string, unknown>
	tags: string[]
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "roo_readFile",
		displayName: "Roo: Read File",
		description: "Read the contents of a file in the workspace. Returns the full text content of the specified file.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to read, relative to the workspace root",
				},
			},
			required: ["path"],
		},
		tags: ["roo-agent", "file-operations"],
	},
	{
		name: "roo_editFile",
		displayName: "Roo: Edit File",
		description:
			"Edit a file by applying a search-and-replace patch. Specify the file path and a unified diff-style patch to apply.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The path of the file to edit, relative to the workspace root",
				},
				diff: {
					type: "string",
					description: "The unified diff patch to apply to the file",
				},
			},
			required: ["path", "diff"],
		},
		tags: ["roo-agent", "file-operations"],
	},
	{
		name: "roo_executeCommand",
		displayName: "Roo: Execute Command",
		description:
			"Execute a shell command in the workspace terminal. Returns the command output. Use with caution as commands have side effects.",
		inputSchema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The shell command to execute",
				},
			},
			required: ["command"],
		},
		tags: ["roo-agent", "terminal"],
	},
	{
		name: "roo_searchFiles",
		displayName: "Roo: Search Files",
		description:
			"Search for files in the workspace using a regex pattern. Returns matching lines with file paths and line numbers.",
		inputSchema: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "The regex pattern to search for",
				},
				path: {
					type: "string",
					description: "Optional directory path to limit the search scope",
				},
			},
			required: ["pattern"],
		},
		tags: ["roo-agent", "search"],
	},
	{
		name: "roo_listFiles",
		displayName: "Roo: List Files",
		description: "List files and directories in the specified path. Returns a tree-like listing of the directory contents.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "The directory path to list, relative to the workspace root",
				},
				recursive: {
					type: "boolean",
					description: "Whether to list files recursively (default: false)",
				},
			},
			required: ["path"],
		},
		tags: ["roo-agent", "file-operations"],
	},
	{
		name: "roo_codebaseSearch",
		displayName: "Roo: Codebase Search",
		description:
			"Perform a semantic search across the codebase using natural language queries. Requires code indexing to be enabled.",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The natural language search query",
				},
			},
			required: ["query"],
		},
		tags: ["roo-agent", "search"],
	},
]

/**
 * Registers Roo's native tools as VSCode Language Model Tools.
 * This allows VSCode's built-in Agent Mode (e.g., Copilot) to invoke
 * Roo's file editing, terminal execution, and code search capabilities.
 */
export function registerLMTools(
	context: vscode.ExtensionContext,
	provider: ClineProvider,
	outputChannel: vscode.OutputChannel,
): void {
	if (typeof vscode.lm?.registerTool !== "function") {
		outputChannel.appendLine("[LMTools] vscode.lm.registerTool not available in this VSCode version, skipping.")
		return
	}

	for (const def of TOOL_DEFINITIONS) {
		try {
			const tool = createLMTool(def, provider, outputChannel)
			const disposable = vscode.lm.registerTool(def.name, tool)
			context.subscriptions.push(disposable)
			outputChannel.appendLine(`[LMTools] Registered tool: ${def.name}`)
		} catch (error) {
			outputChannel.appendLine(
				`[LMTools] Failed to register tool ${def.name}: ${getErrorMessage(error)}`,
			)
		}
	}
}

function createLMTool(
	def: ToolDefinition,
	provider: ClineProvider,
	outputChannel: vscode.OutputChannel,
): vscode.LanguageModelTool<Record<string, unknown>> {
	return {
		async invoke(
			options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
			token: vscode.CancellationToken,
		): Promise<vscode.LanguageModelToolResult> {
			const input = options.input
			outputChannel.appendLine(`[LMTools] Invoking ${def.name} with input: ${JSON.stringify(input)}`)

			try {
				const result = await executeTool(def.name, input, provider, token)
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)])
			} catch (error) {
				const message = getErrorMessage(error)
				outputChannel.appendLine(`[LMTools] Error in ${def.name}: ${message}`)
				return new vscode.LanguageModelToolResult([
					new vscode.LanguageModelTextPart(`Error: ${message}`),
				])
			}
		},

		prepareInvocation(
			_options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>,
			_token: vscode.CancellationToken,
		): Promise<vscode.PreparedToolInvocation> {
			return {
				invocationMessage: `Running ${def.displayName}...`,
			}
		},
	}
}

async function executeTool(
	toolName: string,
	input: Record<string, unknown>,
	provider: ClineProvider,
	_token: vscode.CancellationToken,
): Promise<string> {
	const workspaceFolders = vscode.workspace.workspaceFolders
	const cwd = workspaceFolders?.[0]?.uri.fsPath || ""

	switch (toolName) {
		case "roo_readFile": {
			const filePath = resolveFilePath(cwd, input.path as string)
			const uri = vscode.Uri.file(filePath)
			const content = await vscode.workspace.fs.readFile(uri)
			return new TextDecoder().decode(content)
		}

		case "roo_editFile": {
			const filePath = resolveFilePath(cwd, input.path as string)
			const diff = input.diff as string
			const prompt = `Apply the following diff to the file ${filePath}:\n\n${diff}`
			await provider.createTask(prompt)
			return `Edit task created for ${filePath}. The Roo Agent is processing the change.`
		}

		case "roo_executeCommand": {
			const command = input.command as string
			const prompt = `Execute the following command: ${command}`
			await provider.createTask(prompt)
			return `Command execution task created: ${command}. The Roo Agent is processing.`
		}

		case "roo_searchFiles": {
			const pattern = input.pattern as string
			const searchPath = (input.path as string) || ""
			const fullPath = searchPath ? resolveFilePath(cwd, searchPath) : cwd

			const results: string[] = []
			const files = await vscode.workspace.findFiles(
				new vscode.RelativePattern(fullPath, "**/*"),
				"**/node_modules/**",
				100,
			)

			const regex = new RegExp(pattern, "gi")
			for (const file of files.slice(0, 50)) {
				try {
					const content = await vscode.workspace.fs.readFile(file)
					const text = new TextDecoder().decode(content)
					const lines = text.split("\n")
					for (let i = 0; i < lines.length; i++) {
						if (regex.test(lines[i])) {
							results.push(`${vscode.workspace.asRelativePath(file)}:${i + 1}: ${lines[i].trim()}`)
						}
						regex.lastIndex = 0
					}
				} catch {
					// Skip unreadable files
				}

				if (results.length > 200) break
			}

			return results.length > 0
				? results.join("\n")
				: `No matches found for pattern: ${pattern}`
		}

		case "roo_listFiles": {
			const listPath = resolveFilePath(cwd, (input.path as string) || ".")
			const recursive = (input.recursive as boolean) || false
			const pattern = recursive ? "**/*" : "*"
			const files = await vscode.workspace.findFiles(
				new vscode.RelativePattern(listPath, pattern),
				"**/node_modules/**",
				500,
			)

			return files
				.map((f) => vscode.workspace.asRelativePath(f))
				.sort()
				.join("\n") || "No files found"
		}

		case "roo_codebaseSearch": {
			const query = input.query as string
			const prompt = `Search the codebase for: ${query}`
			await provider.createTask(prompt)
			return `Codebase search task created for: ${query}. The Roo Agent is processing.`
		}

		default:
			throw new Error(`Unknown tool: ${toolName}`)
	}
}

function resolveFilePath(cwd: string, relativePath: string): string {
	if (!relativePath) return cwd
	const path = require("path")
	if (path.isAbsolute(relativePath)) return relativePath
	return path.join(cwd, relativePath)
}
