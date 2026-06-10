import { type ToolName, toolNames, type FileEntry, TelemetryEventName } from "@njust-ai/types"
import { customToolRegistry } from "@njust-ai/core"

import {
	type ToolUse,
	type McpToolUse,
	type ToolParamName,
	type NativeToolArgs,
	toolParamNames,
} from "../../shared/tools"
import { resolveToolAlias } from "../prompts/tools/filter-tools-for-mode"
import { normalizeMcpToolName, parseMcpToolName } from "../../utils/mcp-name"
import { getErrorMessage } from "../../shared/error-utils"
import { logger } from "../../shared/logger"
import { TelemetryService } from "@njust-ai/telemetry"

type NativeArgsFor<TName extends ToolName> = TName extends keyof NativeToolArgs ? NativeToolArgs[TName] : never

export class NativeToolCallFormatter {
	private static readonly PARAM_ALIASES: Record<string, Record<string, string>> = {
		edit: { file: "file_path", path: "file_path", filename: "file_path" },
		search_and_replace: { file: "file_path", path: "file_path", filename: "file_path" },
		edit_file: { file: "file_path", path: "file_path", filename: "file_path" },
		search_replace: { file: "file_path", path: "file_path", filename: "file_path" },
		read_file: { file: "path", filepath: "path", filename: "path" },
		write_to_file: { file: "path", filepath: "path", filename: "path" },
		apply_diff: { file: "path", filepath: "path", filename: "path" },
		search_files: { file: "path", filepath: "path", filename: "path" },
		list_files: { file: "path", filepath: "path", filename: "path" },
		execute_command: { cmd: "command", shell: "command", run: "command" },
		ask_followup_question: { q: "question", text: "question" },
		attempt_completion: { answer: "result", message: "result", response: "result" },
	}

	static tryRecoverMalformedArgs(toolName: string, rawArgs: string): Record<string, UnsafeAny> | null {
		if (toolName === "update_todo_list") {
			const todosMatch = rawArgs.match(/\{"todos"\s*:\s*/)
			if (todosMatch) {
				const content = rawArgs.slice(todosMatch[0].length).replace(/\}?\s*$/, "")
				const unquoted = content.replace(/^"/, "").replace(/"$/, "")
				if (/\[[ x-]\]/.test(unquoted)) {
					return { todos: unquoted }
				}
			}
			if (/\[[ x-]\]/.test(rawArgs)) {
				return { todos: rawArgs.trim() }
			}
		}

		const codeBlockMatch = rawArgs.match(/```(?:json)?\s*([\s\S]*?)```/)
		if (codeBlockMatch) {
			try {
				return JSON.parse(codeBlockMatch[1]!.trim())
			} catch {
				/* ignore */
			}
		}

		const jsonObjectMatch = rawArgs.match(/(\{[\s\S]*\})/)
		if (jsonObjectMatch) {
			try {
				return JSON.parse(jsonObjectMatch[1]!)
			} catch {
				/* ignore */
			}
		}

		const trimmed = rawArgs.trim()
		if (trimmed.startsWith("{") && !trimmed.endsWith("}")) {
			try {
				return JSON.parse(trimmed + "}")
			} catch {
				/* ignore */
			}
			const openBraces = (trimmed.match(/\{/g) || []).length
			const closeBraces = (trimmed.match(/\}/g) || []).length
			if (openBraces > closeBraces) {
				try {
					return JSON.parse(trimmed + "}".repeat(openBraces - closeBraces))
				} catch {
					/* ignore */
				}
			}
		}

		return null
	}

	static remapParamAliases(toolName: string, args: Record<string, UnsafeAny>): void {
		const aliases = NativeToolCallFormatter.PARAM_ALIASES[toolName]
		if (!aliases) return

		for (const [oldKey, newKey] of Object.entries(aliases)) {
			if (oldKey in args && !(newKey in args)) {
				args[newKey] = args[oldKey]
				delete args[oldKey]
			}
		}
	}

	static coerceArgTypes(args: Record<string, UnsafeAny>): void {
		const intKeys = [
			"offset",
			"limit",
			"timeout",
			"anchor_line",
			"max_levels",
			"max_lines",
			"contextLines",
			"expected_replacements",
			"count",
		]
		for (const key of intKeys) {
			if (typeof args[key] === "string") {
				const n = Number(args[key])
				if (Number.isFinite(n)) args[key] = Math.trunc(n)
			}
		}

		const boolKeys = ["recursive", "replace_all", "include_siblings", "include_header"]
		for (const key of boolKeys) {
			if (typeof args[key] === "string") {
				const lower = (args[key] as string).toLowerCase().trim()
				if (lower === "true") args[key] = true
				else if (lower === "false") args[key] = false
			}
		}
	}

	static coerceOptionalBoolean(value: UnsafeAny): boolean | undefined {
		if (typeof value === "boolean") {
			return value
		}
		if (typeof value === "string") {
			const lower = value.trim().toLowerCase()
			if (lower === "true") {
				return true
			}
			if (lower === "false") {
				return false
			}
		}
		return undefined
	}

	static coerceOptionalNumber(value: UnsafeAny): number | undefined {
		if (typeof value === "number" && Number.isFinite(value)) {
			return value
		}
		if (typeof value === "string") {
			const n = Number(value)
			if (Number.isFinite(n)) {
				return n
			}
		}
		return undefined
	}

	static convertFileEntries(files: UnsafeAny[]): FileEntry[] {
		return files.map((file: UnsafeAny) => {
			const f = file as Record<string, UnsafeAny>
			const entry: FileEntry = { path: f.path as string }
			if (f.line_ranges && Array.isArray(f.line_ranges)) {
				entry.lineRanges = (f.line_ranges as UnsafeAny[])
					.map((range: UnsafeAny) => {
						if (Array.isArray(range) && range.length >= 2) {
							return { start: Number(range[0]), end: Number(range[1]) }
						}
						if (typeof range === "object" && range !== null && "start" in range && "end" in range) {
							const r = range as { start: UnsafeAny; end: UnsafeAny }
							return { start: Number(r.start), end: Number(r.end) }
						}
						if (typeof range === "string") {
							const match = range.match(/^(\d+)-(\d+)$/)
							if (match) {
								return { start: parseInt(match[1]!, 10), end: parseInt(match[2]!, 10) }
							}
						}
						return null
					})
					.filter((r): r is { start: number; end: number } => r !== null)
			}
			return entry
		})
	}

	static createPartialToolUse(
		id: string,
		name: ToolName,
		partialArgs: Record<string, UnsafeAny>,
		partial: boolean,
		originalName?: string,
	): ToolUse | null {
		const params: Partial<Record<ToolParamName, string>> = {}

		for (const [key, value] of Object.entries(partialArgs)) {
			if (toolParamNames.includes(key as ToolParamName)) {
				params[key as ToolParamName] = typeof value === "string" ? value : JSON.stringify(value)
			}
		}

		let nativeArgs: UnsafeAny = undefined

		let usedLegacyFormat = false

		switch (name) {
			case "read_file":
				if (partialArgs.files !== undefined) {
					let filesArray: UnsafeAny[] | null = null

					if (Array.isArray(partialArgs.files)) {
						filesArray = partialArgs.files
					} else if (typeof partialArgs.files === "string") {
						try {
							const parsed = JSON.parse(partialArgs.files)
							if (Array.isArray(parsed)) {
								filesArray = parsed
							}
						} catch (error) {
							logger.debug("NativeToolCallFormatter", "JSON parse failed for partial args", error)
						}
					}

					if (filesArray && filesArray.length > 0) {
						usedLegacyFormat = true
						nativeArgs = {
							files: NativeToolCallFormatter.convertFileEntries(filesArray),
							_legacyFormat: true as const,
						}
					}
				}
				if (!nativeArgs && partialArgs.path !== undefined) {
					const indent =
						partialArgs.indentation && typeof partialArgs.indentation === "object"
							? (partialArgs.indentation as Record<string, UnsafeAny>)
							: undefined
					nativeArgs = {
						path: partialArgs.path,
						mode: partialArgs.mode,
						offset: NativeToolCallFormatter.coerceOptionalNumber(partialArgs.offset),
						limit: NativeToolCallFormatter.coerceOptionalNumber(partialArgs.limit),
						indentation: indent
							? {
									anchor_line: NativeToolCallFormatter.coerceOptionalNumber(indent.anchor_line),
									max_levels: NativeToolCallFormatter.coerceOptionalNumber(indent.max_levels),
									max_lines: NativeToolCallFormatter.coerceOptionalNumber(indent.max_lines),
									include_siblings: NativeToolCallFormatter.coerceOptionalBoolean(
										indent.include_siblings,
									),
									include_header: NativeToolCallFormatter.coerceOptionalBoolean(
										indent.include_header,
									),
								}
							: undefined,
					}
				}
				break

			case "attempt_completion":
				if (partialArgs.result) {
					nativeArgs = { result: partialArgs.result }
				}
				break

			case "execute_command":
				if (partialArgs.command) {
					nativeArgs = {
						command: partialArgs.command,
						cwd: partialArgs.cwd,
						timeout: partialArgs.timeout,
					}
				}
				break

			case "write_to_file":
				if (partialArgs.path || partialArgs.content) {
					nativeArgs = {
						path: partialArgs.path,
						content: partialArgs.content,
					}
				}
				break

			case "ask_followup_question":
				if (partialArgs.question !== undefined || partialArgs.follow_up !== undefined) {
					nativeArgs = {
						question: partialArgs.question,
						follow_up: Array.isArray(partialArgs.follow_up) ? partialArgs.follow_up : undefined,
					}
				}
				break

			case "apply_diff":
				if (partialArgs.path !== undefined || partialArgs.diff !== undefined) {
					nativeArgs = {
						path: partialArgs.path,
						diff: partialArgs.diff,
					}
				}
				break

			case "codebase_search":
				if (partialArgs.query !== undefined) {
					nativeArgs = {
						query: partialArgs.query,
						path: partialArgs.path,
					}
				}
				break

			case "generate_image":
				if (partialArgs.prompt !== undefined || partialArgs.path !== undefined) {
					nativeArgs = {
						prompt: partialArgs.prompt,
						path: partialArgs.path,
						image: partialArgs.image,
					}
				}
				break

			case "web_search":
				if (partialArgs.search_query !== undefined) {
					nativeArgs = {
						search_query: partialArgs.search_query,
						count: NativeToolCallFormatter.coerceOptionalNumber(partialArgs.count),
					}
				}
				break

			case "run_slash_command":
				if (partialArgs.command !== undefined) {
					nativeArgs = {
						command: partialArgs.command,
						args: partialArgs.args,
					}
				}
				break

			case "skill":
				if (partialArgs.skill !== undefined) {
					nativeArgs = {
						skill: partialArgs.skill,
						args: partialArgs.args,
					}
				}
				break

			case "search_files":
				if (partialArgs.path !== undefined || partialArgs.regex !== undefined) {
					nativeArgs = {
						path: partialArgs.path,
						regex: partialArgs.regex,
						file_pattern: partialArgs.file_pattern,
						semantic_query: partialArgs.semantic_query,
					}
				}
				break

			case "switch_mode":
				if (partialArgs.mode_slug !== undefined || partialArgs.reason !== undefined) {
					nativeArgs = {
						mode_slug: partialArgs.mode_slug,
						reason: partialArgs.reason,
					}
				}
				break

			case "update_todo_list":
				if (partialArgs.todos !== undefined) {
					nativeArgs = {
						todos: partialArgs.todos,
					}
				}
				break

			case "use_mcp_tool":
				if (partialArgs.server_name !== undefined || partialArgs.tool_name !== undefined) {
					nativeArgs = {
						server_name: partialArgs.server_name,
						tool_name: partialArgs.tool_name,
						arguments: partialArgs.arguments,
					}
				}
				break

			case "apply_patch":
				if (partialArgs.patch !== undefined) {
					nativeArgs = {
						patch: partialArgs.patch,
					}
				}
				break

			case "search_replace":
				if (
					partialArgs.file_path !== undefined ||
					partialArgs.old_string !== undefined ||
					partialArgs.new_string !== undefined
				) {
					nativeArgs = {
						file_path: partialArgs.file_path,
						old_string: partialArgs.old_string,
						new_string: partialArgs.new_string,
					}
				}
				break

			case "edit":
			case "search_and_replace":
				if (
					partialArgs.file_path !== undefined ||
					partialArgs.old_string !== undefined ||
					partialArgs.new_string !== undefined
				) {
					nativeArgs = {
						file_path: partialArgs.file_path,
						old_string: partialArgs.old_string,
						new_string: partialArgs.new_string,
						replace_all: NativeToolCallFormatter.coerceOptionalBoolean(partialArgs.replace_all),
					}
				}
				break

			case "edit_file":
				if (
					partialArgs.file_path !== undefined ||
					partialArgs.old_string !== undefined ||
					partialArgs.new_string !== undefined
				) {
					nativeArgs = {
						file_path: partialArgs.file_path,
						old_string: partialArgs.old_string,
						new_string: partialArgs.new_string,
						expected_replacements: partialArgs.expected_replacements,
					}
				}
				break

			case "list_files":
				if (partialArgs.path !== undefined || partialArgs.recursive !== undefined) {
					const p = partialArgs.path
					const pathStr = typeof p === "string" ? p.trim() : ""
					nativeArgs = {
						path: pathStr || ".",
						recursive: NativeToolCallFormatter.coerceOptionalBoolean(partialArgs.recursive),
					}
				}
				break

			case "new_task":
				if (partialArgs.mode !== undefined || partialArgs.message !== undefined) {
					nativeArgs = {
						mode: partialArgs.mode,
						message: partialArgs.message,
						todos: partialArgs.todos,
					}
				}
				break

			default:
				if (toolNames.includes(name) || customToolRegistry.has(name)) {
					nativeArgs = partialArgs
				}
				break
		}

		const result: ToolUse = {
			type: "tool_use" as const,
			name,
			params,
			partial,
			nativeArgs,
		}

		if (originalName) {
			result.originalName = originalName
		}

		if (usedLegacyFormat) {
			result.usedLegacyFormat = true
		}

		return result
	}

	static parseToolCall<TName extends ToolName>(toolCall: {
		id: string
		name: TName
		arguments: string
	}): ToolUse<TName> | McpToolUse | null {
		const mcpPrefix = "mcp--"

		if (typeof toolCall.name === "string") {
			const normalizedName = normalizeMcpToolName(toolCall.name)
			if (normalizedName.startsWith(mcpPrefix)) {
				return NativeToolCallFormatter.parseDynamicMcpTool({ ...toolCall, name: normalizedName })
			}
		}

		const resolvedName = resolveToolAlias(toolCall.name as string) as TName

		if (!toolNames.includes(resolvedName as ToolName) && !customToolRegistry.has(resolvedName)) {
			logger.error("NativeToolCallFormatter", `Invalid tool name: ${toolCall.name} (resolved: ${resolvedName})`)
			logger.error("NativeToolCallFormatter", `Valid tool names:`, toolNames)
			return null
		}

		try {
			let args: Record<string, UnsafeAny>
			try {
				args = toolCall.arguments === "" ? {} : JSON.parse(toolCall.arguments)
			} catch (parseError) {
				const recovered = NativeToolCallFormatter.tryRecoverMalformedArgs(resolvedName, toolCall.arguments)
				if (recovered) {
					args = recovered
				} else {
					throw parseError
				}
			}

			NativeToolCallFormatter.remapParamAliases(resolvedName, args)

			NativeToolCallFormatter.coerceArgTypes(args)

			const params: Partial<Record<ToolParamName, string>> = {}

			for (const [key, value] of Object.entries(args)) {
				if (!toolParamNames.includes(key as ToolParamName) && !customToolRegistry.has(resolvedName)) {
					logger.warn("NativeToolCallFormatter", `Unknown parameter '${key}' for tool '${resolvedName}'`)
					logger.warn("NativeToolCallFormatter", `Valid param names:`, toolParamNames)
					continue
				}

				const stringValue = typeof value === "string" ? value : JSON.stringify(value)
				params[key as ToolParamName] = stringValue
			}

			let nativeArgs: NativeArgsFor<TName> | undefined = undefined

			let usedLegacyFormat = false

			switch (resolvedName) {
				case "read_file":
					if (args.files !== undefined) {
						let filesArray: UnsafeAny[] | null = null

						if (Array.isArray(args.files)) {
							filesArray = args.files
						} else if (typeof args.files === "string") {
							try {
								const parsed = JSON.parse(args.files)
								if (Array.isArray(parsed)) {
									filesArray = parsed
								}
							} catch (error) {
								logger.debug("NativeToolCallFormatter", "JSON parse failed for args.files", error)
							}
						}

						if (filesArray && filesArray.length > 0) {
							usedLegacyFormat = true
							nativeArgs = {
								files: NativeToolCallFormatter.convertFileEntries(filesArray),
								_legacyFormat: true as const,
							} as NativeArgsFor<TName>
						}
					}
					if (!nativeArgs && args.path !== undefined) {
						const indent =
							args.indentation && typeof args.indentation === "object"
								? (args.indentation as Record<string, UnsafeAny>)
								: undefined
						nativeArgs = {
							path: args.path,
							mode: args.mode,
							offset: NativeToolCallFormatter.coerceOptionalNumber(args.offset),
							limit: NativeToolCallFormatter.coerceOptionalNumber(args.limit),
							indentation: indent
								? {
										anchor_line: NativeToolCallFormatter.coerceOptionalNumber(indent.anchor_line),
										max_levels: NativeToolCallFormatter.coerceOptionalNumber(indent.max_levels),
										max_lines: NativeToolCallFormatter.coerceOptionalNumber(indent.max_lines),
										include_siblings: NativeToolCallFormatter.coerceOptionalBoolean(
											indent.include_siblings,
										),
										include_header: NativeToolCallFormatter.coerceOptionalBoolean(
											indent.include_header,
										),
									}
								: undefined,
						} as NativeArgsFor<TName>
					}
					break

				case "attempt_completion":
					if (args.result) {
						nativeArgs = { result: args.result } as NativeArgsFor<TName>
					}
					break

				case "execute_command":
					if (args.command) {
						nativeArgs = {
							command: args.command,
							cwd: args.cwd,
							timeout: args.timeout,
						} as NativeArgsFor<TName>
					}
					break

				case "apply_diff":
					if (args.path !== undefined && args.diff !== undefined) {
						nativeArgs = {
							path: args.path,
							diff: args.diff,
						} as NativeArgsFor<TName>
					}
					break

				case "edit":
				case "search_and_replace":
					if (
						args.file_path !== undefined &&
						args.old_string !== undefined &&
						args.new_string !== undefined
					) {
						nativeArgs = {
							file_path: args.file_path,
							old_string: args.old_string,
							new_string: args.new_string,
							replace_all: NativeToolCallFormatter.coerceOptionalBoolean(args.replace_all),
						} as NativeArgsFor<TName>
					}
					break

				case "ask_followup_question":
					if (args.question !== undefined && args.follow_up !== undefined) {
						nativeArgs = {
							question: args.question,
							follow_up: args.follow_up,
						} as NativeArgsFor<TName>
					}
					break

				case "codebase_search":
					if (args.query !== undefined) {
						nativeArgs = {
							query: args.query,
							path: args.path,
						} as NativeArgsFor<TName>
					}
					break

				case "generate_image":
					if (args.prompt !== undefined && args.path !== undefined) {
						nativeArgs = {
							prompt: args.prompt,
							path: args.path,
							image: args.image,
						} as NativeArgsFor<TName>
					}
					break

				case "web_search":
					if (args.search_query !== undefined) {
						nativeArgs = {
							search_query: args.search_query,
							count: typeof args.count === "number" ? args.count : undefined,
						} as NativeArgsFor<TName>
					}
					break

				case "run_slash_command":
					if (args.command !== undefined) {
						nativeArgs = {
							command: args.command,
							args: args.args,
						} as NativeArgsFor<TName>
					}
					break

				case "skill":
					if (args.skill !== undefined) {
						nativeArgs = {
							skill: args.skill,
							args: args.args,
						} as NativeArgsFor<TName>
					}
					break

				case "search_files":
					if (args.path !== undefined && args.regex !== undefined) {
						nativeArgs = {
							path: args.path,
							regex: args.regex,
							file_pattern: args.file_pattern,
							semantic_query: args.semantic_query,
						} as NativeArgsFor<TName>
					}
					break

				case "switch_mode":
					if (args.mode_slug !== undefined && args.reason !== undefined) {
						nativeArgs = {
							mode_slug: args.mode_slug,
							reason: args.reason,
						} as NativeArgsFor<TName>
					}
					break

				case "update_todo_list":
					if (args.todos !== undefined) {
						nativeArgs = {
							todos: args.todos,
						} as NativeArgsFor<TName>
					}
					break

				case "read_command_output":
					if (args.artifact_id !== undefined) {
						nativeArgs = {
							artifact_id: args.artifact_id,
							search: args.search,
							offset: args.offset,
							limit: args.limit,
						} as NativeArgsFor<TName>
					}
					break

				case "write_to_file":
					if (args.path !== undefined && args.content !== undefined) {
						nativeArgs = {
							path: args.path,
							content: args.content,
						} as NativeArgsFor<TName>
					}
					break

				case "use_mcp_tool":
					if (args.server_name !== undefined && args.tool_name !== undefined) {
						nativeArgs = {
							server_name: args.server_name,
							tool_name: args.tool_name,
							arguments: args.arguments,
						} as NativeArgsFor<TName>
					}
					break

				case "access_mcp_resource":
					if (args.server_name !== undefined && args.uri !== undefined) {
						nativeArgs = {
							server_name: args.server_name,
							uri: args.uri,
						} as NativeArgsFor<TName>
					}
					break

				case "apply_patch":
					if (args.patch !== undefined) {
						nativeArgs = {
							patch: args.patch,
						} as NativeArgsFor<TName>
					}
					break

				case "search_replace":
					if (
						args.file_path !== undefined &&
						args.old_string !== undefined &&
						args.new_string !== undefined
					) {
						nativeArgs = {
							file_path: args.file_path,
							old_string: args.old_string,
							new_string: args.new_string,
						} as NativeArgsFor<TName>
					}
					break

				case "edit_file":
					if (
						args.file_path !== undefined &&
						args.old_string !== undefined &&
						args.new_string !== undefined
					) {
						nativeArgs = {
							file_path: args.file_path,
							old_string: args.old_string,
							new_string: args.new_string,
							expected_replacements: args.expected_replacements,
						} as NativeArgsFor<TName>
					}
					break

				case "list_files": {
					const rawPath = args.path
					const pathNorm =
						typeof rawPath === "string"
							? rawPath.trim()
							: typeof rawPath === "number"
								? String(rawPath)
								: ""
					const coercedRec = NativeToolCallFormatter.coerceOptionalBoolean(args.recursive)
					nativeArgs = {
						path: pathNorm || ".",
						recursive: coercedRec ?? false,
					} as NativeArgsFor<TName>
					break
				}

				case "new_task":
					if (args.mode !== undefined && args.message !== undefined) {
						nativeArgs = {
							mode: args.mode,
							message: args.message,
							todos: args.todos,
						} as NativeArgsFor<TName>
					}
					break

				default:
					if (toolNames.includes(resolvedName as ToolName) || customToolRegistry.has(resolvedName)) {
						nativeArgs = args as NativeArgsFor<TName>
					}

					break
			}

			if (!nativeArgs && !customToolRegistry.has(resolvedName)) {
				throw new Error(
					`[NativeToolCallFormatter] Invalid arguments for tool '${resolvedName}'. ` +
						`Native tool calls require a valid JSON payload matching the tool schema. ` +
						`Received: ${JSON.stringify(args)}`,
				)
			}

			const result: ToolUse<TName> = {
				type: "tool_use" as const,
				name: resolvedName,
				params,
				partial: false,
				nativeArgs,
			}

			if (toolCall.name !== resolvedName) {
				result.originalName = toolCall.name
			}

			if (usedLegacyFormat) {
				result.usedLegacyFormat = true
			}

			return result
		} catch (error) {
			logger.error("NativeToolCallFormatter", `Failed to parse tool call arguments: ${getErrorMessage(error)}`)

			logger.error("NativeToolCallFormatter", `Tool call: ${JSON.stringify(toolCall, null, 2)}`)
			TelemetryService.reportError(error, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
			return null
		}
	}

	static parseDynamicMcpTool(toolCall: { id: string; name: string; arguments: string }): McpToolUse | null {
		try {
			const args = JSON.parse(toolCall.arguments || "{}")

			const normalizedName = normalizeMcpToolName(toolCall.name)

			const parsed = parseMcpToolName(normalizedName)
			if (!parsed) {
				logger.error(
					"NativeToolCallFormatter",
					`Invalid dynamic MCP tool name format: ${toolCall.name} (normalized: ${normalizedName})`,
				)
				return null
			}

			const { serverName, toolName } = parsed

			const result: McpToolUse = {
				type: "mcp_tool_use" as const,
				id: toolCall.id,
				name: toolCall.name,
				serverName,
				toolName,
				arguments: args,
				partial: false,
			}

			return result
		} catch (error) {
			logger.error("NativeToolCallFormatter", `Failed to parse dynamic MCP tool:`, error)
			TelemetryService.reportError(error, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
			return null
		}
	}
}
