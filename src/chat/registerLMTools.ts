import * as path from "path"
import * as vscode from "vscode"

import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

import type { ClineProvider } from "../core/webview/ClineProvider"
import { getErrorMessage } from "../shared/error-utils"
import { validateRegexPattern } from "../utils/safeRegex"
import { logger } from "../shared/logger"

interface ToolDefinition {
	name: string
	displayName: string
	description: string
	inputSchema: Record<string, unknown>
	tags: string[]
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "njust_ai_readFile",
		displayName: "Njust-AI: Read File",
		description:
			"Read the contents of a file in the workspace. Returns the full text content of the specified file.",
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
		tags: ["njust-ai-agent", "file-operations"],
	},
	{
		name: "njust_ai_editFile",
		displayName: "Njust-AI: Edit File",
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
		tags: ["njust-ai-agent", "file-operations"],
	},
	{
		name: "njust_ai_executeCommand",
		displayName: "Njust-AI: Execute Command",
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
		tags: ["njust-ai-agent", "terminal"],
	},
	{
		name: "njust_ai_searchFiles",
		displayName: "Njust-AI: Search Files",
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
		tags: ["njust-ai-agent", "search"],
	},
	{
		name: "njust_ai_listFiles",
		displayName: "Njust-AI: List Files",
		description:
			"List files and directories in the specified path. Returns a tree-like listing of the directory contents.",
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
		tags: ["njust-ai-agent", "file-operations"],
	},
	{
		name: "njust_ai_codebaseSearch",
		displayName: "Njust-AI: Codebase Search",
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
		tags: ["njust-ai-agent", "search"],
	},
]

/**
 * Registers Njust-AI's native tools as VSCode Language Model Tools.
 * This allows VSCode's built-in Agent Mode (e.g., Copilot) to invoke
 * Njust-AI's file editing, terminal execution, and code search capabilities.
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
			outputChannel.appendLine(`[LMTools] Failed to register tool ${def.name}: ${getErrorMessage(error)}`)
			TelemetryService.reportError(error, TelemetryEventName.EXTENSION_INIT_ERROR)
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
				TelemetryService.reportError(error, TelemetryEventName.EXTENSION_INIT_ERROR)
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Error: ${message}`)])
			}
		},

		// eslint-disable-next-line @typescript-eslint/require-await
		async prepareInvocation(
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
		case "njust_ai_readFile": {
			const filePath = resolveFilePath(cwd, input.path as string)
			const uri = vscode.Uri.file(filePath)
			const content = await vscode.workspace.fs.readFile(uri)
			return new TextDecoder().decode(content)
		}

		case "njust_ai_editFile": {
			const filePath = resolveFilePath(cwd, input.path as string)
			const diff = input.diff as string
			const prompt = `Apply the following diff to the file ${filePath}:\n\n${diff}`
			await provider.createTask(prompt)
			return `Edit task created for ${filePath}. The Njust-AI Agent is processing the change.`
		}

		case "njust_ai_executeCommand": {
			const command = input.command as string
			const prompt = `Execute the following command: ${command}`
			await provider.createTask(prompt)
			return `Command execution task created: ${command}. The Njust-AI Agent is processing.`
		}

		case "njust_ai_searchFiles": {
			const pattern = input.pattern as string
			const searchPath = (input.path as string) || ""
			const fullPath = searchPath ? resolveFilePath(cwd, searchPath) : cwd

			const results: string[] = []
			const files = await vscode.workspace.findFiles(
				new vscode.RelativePattern(fullPath, "**/*"),
				"**/node_modules/**",
				100,
			)

			let regex: RegExp | undefined
			const validation = validateRegexPattern(pattern)
			if (validation.valid) {
				regex = new RegExp(pattern, "gi")
			} else {
				regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
			}
			for (const file of files.slice(0, 50)) {
				try {
					const content = await vscode.workspace.fs.readFile(file)
					const text = new TextDecoder().decode(content)
					const lines = text.split("\n")
					for (let i = 0; i < lines.length; i++) {
						if (regex.test(lines[i]!)) {
							results.push(`${vscode.workspace.asRelativePath(file)}:${i + 1}: ${lines[i]!.trim()}`)
						}
						regex.lastIndex = 0
					}
				} catch (error) {
					logger.debug("RegisterLMTools", "file read failed during search", error)
					// Skip unreadable files
				}

				if (results.length > 200) break
			}

			return results.length > 0 ? results.join("\n") : `No matches found for pattern: ${pattern}`
		}

		case "njust_ai_listFiles": {
			const listPath = resolveFilePath(cwd, (input.path as string) || ".")
			const recursive = (input.recursive as boolean) || false
			const pattern = recursive ? "**/*" : "*"
			const files = await vscode.workspace.findFiles(
				new vscode.RelativePattern(listPath, pattern),
				"**/node_modules/**",
				500,
			)

			return (
				files
					.map((f) => vscode.workspace.asRelativePath(f))
					.sort()
					.join("\n") || "No files found"
			)
		}

		case "njust_ai_codebaseSearch": {
			const query = input.query as string
			const prompt = `Search the codebase for: ${query}`
			await provider.createTask(prompt)
			return `Codebase search task created for: ${query}. The Njust-AI Agent is processing.`
		}

		default:
			throw new Error(`Unknown tool: ${toolName}`)
	}
}

function resolveFilePath(cwd: string, relativePath: string): string {
	if (!relativePath) return cwd
	if (path.isAbsolute(relativePath)) return relativePath
	return path.join(cwd, relativePath)
}
