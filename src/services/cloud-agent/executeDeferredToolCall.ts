import {
	execReadFile,
	execWriteFile,
	execListFiles,
	execSearchFiles,
	execCommand,
	execApplyDiff,
} from "../mcp-server/tool-executors"
import type { DeferredToolCall, DeferredToolResult } from "./types"
import { getErrorMessage } from "../../shared/error-utils"

/**
 * Execute a single deferred tool call locally and return an MCP-shaped result.
 * Unknown tools yield an is_error result rather than throwing.
 */
export async function executeDeferredToolCall(
	cwd: string,
	call: DeferredToolCall,
): Promise<DeferredToolResult> {
	try {
		const args = call.arguments
		if (args._arguments_parse_failed === true) {
			const raw = typeof args._raw_arguments === "string" ? args._raw_arguments : ""
			return {
				call_id: call.call_id,
				content: `Invalid JSON in tool arguments (parse failed before execution). Raw: ${raw.slice(0, 2000)}`,
				is_error: true,
			}
		}

		let content: string

		switch (call.tool) {
			case "read_file":
				content = await execReadFile(cwd, {
					path: args.path as string,
					start_line: args.start_line as number | undefined,
					end_line: args.end_line as number | undefined,
				})
				break

			case "write_file":
				content = await execWriteFile(cwd, {
					path: args.path as string,
					content: args.content as string,
				})
				break

			case "apply_diff":
				content = await execApplyDiff(cwd, {
					path: args.path as string,
					diff: args.diff as string,
				})
				break

			case "list_files": {
				const raw = args.path
				const p = typeof raw === "string" ? raw.trim() : ""
				content = await execListFiles(cwd, {
					path: p || ".",
					recursive: args.recursive as boolean | undefined,
				})
				break
			}

			case "search_files":
				content = await execSearchFiles(cwd, {
					path: (args.path as string) ?? ".",
					regex: args.regex as string,
					file_pattern: args.file_pattern as string | undefined,
				})
				break

			case "execute_command":
				content = await execCommand(cwd, {
					command: args.command as string,
					cwd: args.cwd as string | undefined,
					timeout: args.timeout as number | undefined,
				})
				break

			default:
				return {
					call_id: call.call_id,
					content: `Unknown tool: ${call.tool}`,
					is_error: true,
				}
		}

		return { call_id: call.call_id, content, is_error: false }
	} catch (error) {
		const msg = getErrorMessage(error)
		return { call_id: call.call_id, content: msg, is_error: true }
	}
}
