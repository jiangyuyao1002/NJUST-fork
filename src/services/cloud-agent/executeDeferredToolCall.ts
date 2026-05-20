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

function expectString(args: Record<string, UnsafeAny>, key: string): string {
	const val = args[key]
	if (typeof val !== "string") {
		throw new TypeError(`Expected "${key}" to be a string, got ${typeof val}`)
	}
	return val
}

function expectOptionalString(args: Record<string, UnsafeAny>, key: string): string | undefined {
	const val = args[key]
	if (val === undefined || val === null) return undefined
	if (typeof val !== "string") {
		throw new TypeError(`Expected "${key}" to be a string or undefined, got ${typeof val}`)
	}
	return val
}

function expectOptionalNumber(args: Record<string, UnsafeAny>, key: string): number | undefined {
	const val = args[key]
	if (val === undefined || val === null) return undefined
	if (typeof val !== "number" || Number.isNaN(val)) {
		throw new TypeError(`Expected "${key}" to be a number or undefined, got ${typeof val}`)
	}
	return val
}

function expectOptionalBoolean(args: Record<string, UnsafeAny>, key: string): boolean | undefined {
	const val = args[key]
	if (val === undefined || val === null) return undefined
	if (typeof val !== "boolean") {
		throw new TypeError(`Expected "${key}" to be a boolean or undefined, got ${typeof val}`)
	}
	return val
}

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
					path: expectString(args, "path"),
					start_line: expectOptionalNumber(args, "start_line"),
					end_line: expectOptionalNumber(args, "end_line"),
				})
				break

			case "write_file":
				content = await execWriteFile(cwd, {
					path: expectString(args, "path"),
					content: expectString(args, "content"),
				})
				break

			case "apply_diff":
				content = await execApplyDiff(cwd, {
					path: expectString(args, "path"),
					diff: expectString(args, "diff"),
				})
				break

			case "list_files": {
				const raw = args.path
				const p = typeof raw === "string" ? raw.trim() : ""
				content = await execListFiles(cwd, {
					path: p || ".",
					recursive: expectOptionalBoolean(args, "recursive"),
				})
				break
			}

			case "search_files":
				content = await execSearchFiles(cwd, {
					path: expectOptionalString(args, "path") ?? ".",
					regex: expectString(args, "regex"),
					file_pattern: expectOptionalString(args, "file_pattern"),
				})
				break

			case "execute_command":
				content = await execCommand(cwd, {
					command: expectString(args, "command"),
					cwd: expectOptionalString(args, "cwd"),
					timeout: expectOptionalNumber(args, "timeout"),
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
