import { describe, it, expect, beforeEach } from "vitest"
import { toolNames } from "@njust-ai/types"
import { NativeToolCallParser } from "../NativeToolCallParser"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { toolParamNames } from "../../../shared/tools"

function sampleValueForSchema(schema: any): unknown {
	if (!schema || typeof schema !== "object") {
		return "value"
	}
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		return schema.enum.find((value: unknown) => value !== null) ?? schema.enum[0]
	}
	const type = Array.isArray(schema.type) ? schema.type.find((value: string) => value !== "null") : schema.type
	switch (type) {
		case "integer":
		case "number":
			return 1
		case "boolean":
			return false
		case "array":
			return [sampleValueForSchema(schema.items)]
		case "object": {
			const result: Record<string, unknown> = {}
			for (const key of schema.required ?? []) {
				result[key] = sampleValueForSchema(schema.properties?.[key])
			}
			return result
		}
		case "string":
		default:
			return "value"
	}
}

function sampleArgsForTool(tool: ReturnType<typeof getNativeTools>[number]): Record<string, unknown> {
	const parameters = "function" in tool ? (tool.function.parameters as any) : undefined
	const result: Record<string, unknown> = {}
	for (const key of parameters?.required ?? []) {
		result[key] = sampleValueForSchema(parameters.properties?.[key])
	}

	switch ("function" in tool ? tool.function.name : "") {
		case "read_file":
			result.path = "src/package.json"
			break
		case "ask_followup_question":
			result.question = "Choose an option"
			result.follow_up = [{ text: "Continue" }]
			break
		case "notebook_edit":
			result.action = "delete"
			break
		case "lsp":
			result.action = "symbols"
			result.filePath = "."
			result.symbolName = "Task"
			break
	}

	return result
}

describe("NativeToolCallParser", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	describe("parseToolCall", () => {
		it("keeps exposed native tool definitions aligned with shared tool metadata", () => {
			for (const tool of getNativeTools({ supportsImages: true })) {
				if (!("function" in tool)) continue
				const toolName = tool.function.name
				expect(toolNames, `Tool '${toolName}' must be listed in toolNames`).toContain(toolName)

				const parameters = tool.function.parameters as any
				for (const key of Object.keys(parameters?.properties ?? {})) {
					expect(
						toolParamNames,
						`Parameter '${key}' for '${toolName}' must be listed in toolParamNames`,
					).toContain(key)
				}
			}
		})

		describe("read_file tool", () => {
			it("should parse minimal single-file read_file args", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
				}
			})

			it("should parse slice-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
						mode: "slice",
						offset: 10,
						limit: 20,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						offset?: number
						limit?: number
					}
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
					expect(nativeArgs.mode).toBe("slice")
					expect(nativeArgs.offset).toBe(10)
					expect(nativeArgs.limit).toBe(20)
				}
			})

			it("should parse indentation-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/utils.ts",
						mode: "indentation",
						indentation: {
							anchor_line: 123,
							max_levels: 2,
							include_siblings: true,
							include_header: false,
						},
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						indentation?: {
							anchor_line?: number
							max_levels?: number
							include_siblings?: boolean
							include_header?: boolean
						}
					}
					expect(nativeArgs.path).toBe("src/utils.ts")
					expect(nativeArgs.mode).toBe("indentation")
					expect(nativeArgs.indentation?.anchor_line).toBe(123)
					expect(nativeArgs.indentation?.include_siblings).toBe(true)
					expect(nativeArgs.indentation?.include_header).toBe(false)
				}
			})

			// Legacy format backward compatibility tests
			describe("legacy format backward compatibility", () => {
				it("should parse legacy files array format with single file", () => {
					const toolCall = {
						id: "toolu_legacy_1",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/legacy/file.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(1)
						expect(nativeArgs.files[0].path).toBe("src/legacy/file.ts")
					}
				})

				it("should parse legacy files array format with multiple files", () => {
					const toolCall = {
						id: "toolu_legacy_2",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/file1.ts" }, { path: "src/file2.ts" }, { path: "src/file3.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs.files).toHaveLength(3)
						expect(nativeArgs.files[0].path).toBe("src/file1.ts")
						expect(nativeArgs.files[1].path).toBe("src/file2.ts")
						expect(nativeArgs.files[2].path).toBe("src/file3.ts")
					}
				})

				it("should parse legacy line_ranges as tuples", () => {
					const toolCall = {
						id: "toolu_legacy_3",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										[1, 50],
										[100, 150],
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
							_legacyFormat: true
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse legacy line_ranges as objects", () => {
					const toolCall = {
						id: "toolu_legacy_4",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										{ start: 10, end: 20 },
										{ start: 30, end: 40 },
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 10, end: 20 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 30, end: 40 })
					}
				})

				it("should parse legacy line_ranges as strings", () => {
					const toolCall = {
						id: "toolu_legacy_5",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: ["1-50", "100-150"],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse double-stringified files array (model quirk)", () => {
					// This tests the real-world case where some models double-stringify the files array
					// e.g., { files: "[{\"path\": \"...\"}]" } instead of { files: [{path: "..."}] }
					const toolCall = {
						id: "toolu_double_stringify",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: JSON.stringify([
								{ path: "src/services/example/service.ts" },
								{ path: "src/services/mcp/McpServerManager.ts" },
							]),
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string }>
							_legacyFormat: true
						}
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(2)
						expect(nativeArgs.files[0].path).toBe("src/services/example/service.ts")
						expect(nativeArgs.files[1].path).toBe("src/services/mcp/McpServerManager.ts")
					}
				})

				it("should NOT set usedLegacyFormat for new format", () => {
					const toolCall = {
						id: "toolu_new",
						name: "read_file" as const,
						arguments: JSON.stringify({
							path: "src/new/format.ts",
							mode: "slice",
							offset: 1,
							limit: 100,
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBeUndefined()
					}
				})
			})
		})

		describe("list_files tool", () => {
			it("defaults path to '.' when omitted", () => {
				const toolCall = {
					id: "toolu_list_1",
					name: "list_files" as const,
					arguments: JSON.stringify({ recursive: false }),
				}
				const result = NativeToolCallParser.parseToolCall(toolCall)
				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const na = result.nativeArgs as { path: string; recursive: boolean }
					expect(na.path).toBe(".")
					expect(na.recursive).toBe(false)
				}
			})

			it("defaults path and recursive for empty args", () => {
				const toolCall = {
					id: "toolu_list_2",
					name: "list_files" as const,
					arguments: "{}",
				}
				const result = NativeToolCallParser.parseToolCall(toolCall)
				expect(result).not.toBeNull()
				if (result?.type === "tool_use") {
					const na = result.nativeArgs as { path: string; recursive: boolean }
					expect(na.path).toBe(".")
					expect(na.recursive).toBe(false)
				}
			})
		})

		describe("registered tools without specialized parser cases", () => {
			it("preserves nativeArgs for a known deferred tool", () => {
				const toolCall = {
					id: "toolu_grep_1",
					name: "grep" as const,
					arguments: JSON.stringify({
						pattern: "TODO",
						path: "src",
						include: "*.ts",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("grep")
					expect(result.nativeArgs).toEqual({
						pattern: "TODO",
						path: "src",
						include: "*.ts",
					})
				}
			})

			it("does not rewrite existing tool names through compatibility aliases", () => {
				const toolCall = {
					id: "toolu_write_to_file_1",
					name: "write_to_file" as const,
					arguments: JSON.stringify({
						path: "src/a.ts",
						content: "new content",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("write_to_file")
					expect(result.nativeArgs).toEqual({
						path: "src/a.ts",
						content: "new content",
					})
				}
			})
		})

		it("constructs nativeArgs for every exposed native tool", () => {
			const tools = getNativeTools({ supportsImages: true }).filter((tool) => "function" in tool)

			for (const tool of tools) {
				const toolName = tool.function.name as any
				const result = NativeToolCallParser.parseToolCall({
					id: `toolu_${toolName}`,
					name: toolName,
					arguments: JSON.stringify(sampleArgsForTool(tool)),
				})

				expect(result, `Expected ${toolName} to parse`).not.toBeNull()
				expect(result?.type, `Expected ${toolName} to be a tool_use`).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs, `Expected ${toolName} to have nativeArgs`).toBeDefined()
				}
			}
		})
	})

	describe("processStreamingChunk", () => {
		describe("read_file tool", () => {
			it("should emit a partial ToolUse with nativeArgs.path during streaming", () => {
				const id = "toolu_streaming_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Simulate streaming chunks
				const fullArgs = JSON.stringify({ path: "src/test.ts" })

				// Process the complete args as a single chunk for simplicity
				const result = NativeToolCallParser.processStreamingChunk(id, fullArgs)

				expect(result).not.toBeNull()
				expect(result?.nativeArgs).toBeDefined()
				const nativeArgs = result?.nativeArgs as { path: string }
				expect(nativeArgs.path).toBe("src/test.ts")
			})
		})
	})

	describe("finalizeStreamingToolCall", () => {
		describe("read_file tool", () => {
			it("should parse read_file args on finalize", () => {
				const id = "toolu_finalize_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Add the complete arguments
				NativeToolCallParser.processStreamingChunk(
					id,
					JSON.stringify({
						path: "finalized.ts",
						mode: "slice",
						offset: 1,
						limit: 10,
					}),
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(id)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string; offset?: number; limit?: number }
					expect(nativeArgs.path).toBe("finalized.ts")
					expect(nativeArgs.offset).toBe(1)
					expect(nativeArgs.limit).toBe(10)
				}
			})
		})

		describe("use_mcp_tool", () => {
			it("should finalize streamed wrapper args with nested MCP arguments", () => {
				const parser = new NativeToolCallParser()
				const id = "call_use_mcp_tool"

				let events = parser.processRawChunk({
					index: 0,
					id,
					name: "use_mcp_tool",
					arguments: "",
				})
				expect(events).toEqual([{ type: "tool_call_start", id, name: "use_mcp_tool" }])
				parser.startStreamingToolCall(id, "use_mcp_tool")

				events = parser.processRawChunk({
					index: 0,
					arguments: JSON.stringify({
						server_name: "filesystem",
						tool_name: "read_file",
						arguments: { path: "simple.txt" },
					}),
				})
				expect(events).toHaveLength(1)
				expect(events[0]).toEqual({
					type: "tool_call_delta",
					id,
					delta: JSON.stringify({
						server_name: "filesystem",
						tool_name: "read_file",
						arguments: { path: "simple.txt" },
					}),
				})
				parser.processStreamingChunk(id, events[0]!.delta)

				const endEvents = parser.finalizeRawChunks()
				expect(endEvents).toEqual([{ type: "tool_call_end", id }])

				const result = parser.finalizeStreamingToolCall(id)
				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("use_mcp_tool")
					expect(result.nativeArgs).toEqual({
						server_name: "filesystem",
						tool_name: "read_file",
						arguments: { path: "simple.txt" },
					})
				}
			})
		})
	})
})
