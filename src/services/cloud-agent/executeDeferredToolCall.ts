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
import { allowRooIgnorePathAccess, type RooIgnoreController } from "../../core/ignore/RooIgnoreController"
import type { RooProtectedController } from "../../core/protect/RooProtectedController"

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
	allowedCommands?: string[],
	deniedCommands?: string[],
	rooIgnoreController?: RooIgnoreController,
	rooProtectedController?: RooProtectedController,
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
			case "read_file": {
				const readPath = expectString(args, "path")
				const readAccessAllowed = allowRooIgnorePathAccess(rooIgnoreController, readPath)
				if (!readAccessAllowed) {
					return {
						call_id: call.call_id,
						content: `Access denied by .rooignore: ${readPath}`,
						is_error: true,
					}
				}
				content = await execReadFile(cwd, {
					path: readPath,
					start_line: expectOptionalNumber(args, "start_line"),
					end_line: expectOptionalNumber(args, "end_line"),
				})
				break
			}

			case "write_file": {
				const writePath = expectString(args, "path")
				const accessAllowed = allowRooIgnorePathAccess(rooIgnoreController, writePath)
				if (!accessAllowed) {
					return {
						call_id: call.call_id,
						content: `Access denied by .rooignore: ${writePath}`,
						is_error: true,
					}
				}
				const isWriteProtected = (await rooProtectedController?.isWriteProtected(writePath)) || false
				if (isWriteProtected) {
					return {
						call_id: call.call_id,
						content: `Write protected: ${writePath}`,
						is_error: true,
					}
				}
				content = await execWriteFile(cwd, { path: writePath, content: expectString(args, "content") }, rooProtectedController)
				break
			}

			case "apply_diff": {
				const diffPath = expectString(args, "path")
				const accessAllowed = allowRooIgnorePathAccess(rooIgnoreController, diffPath)
				if (!accessAllowed) {
					return {
						call_id: call.call_id,
						content: `Access denied by .rooignore: ${diffPath}`,
						is_error: true,
					}
				}
				const isWriteProtected = (await rooProtectedController?.isWriteProtected(diffPath)) || false
				if (isWriteProtected) {
					return {
						call_id: call.call_id,
						content: `Write protected: ${diffPath}`,
						is_error: true,
					}
				}
				content = await execApplyDiff(cwd, { path: diffPath, diff: expectString(args, "diff") }, rooProtectedController)
				break
			}

			case "list_files": {
				const raw = args.path
				const listPath = typeof raw === "string" ? raw.trim() : ""
				const listAccessAllowed = allowRooIgnorePathAccess(rooIgnoreController, listPath || ".")
				if (!listAccessAllowed) {
					return {
						call_id: call.call_id,
						content: `Access denied by .rooignore: ${listPath || "."}`,
						is_error: true,
					}
				}
				content = await execListFiles(
					cwd,
					{ path: listPath || ".", recursive: expectOptionalBoolean(args, "recursive") },
					rooIgnoreController,
				)
				break
			}

			case "search_files": {
				const searchPath = expectOptionalString(args, "path") ?? "."
				const searchAccessAllowed = allowRooIgnorePathAccess(rooIgnoreController, searchPath)
				if (!searchAccessAllowed) {
					return {
						call_id: call.call_id,
						content: `Access denied by .rooignore: ${searchPath}`,
						is_error: true,
					}
				}
				content = await execSearchFiles(
					cwd,
					{ path: searchPath, regex: expectString(args, "regex"), file_pattern: expectOptionalString(args, "file_pattern") },
					rooIgnoreController,
				)
				break
			}

			case "execute_command": {
				const command = expectString(args, "command")
				const blockedPath = rooIgnoreController?.validateCommand(command)
				if (blockedPath) {
					return {
						call_id: call.call_id,
						content: `Access denied by .rooignore: ${blockedPath}`,
						is_error: true,
					}
				}
				content = await execCommand(cwd, {
					command,
					cwd: expectOptionalString(args, "cwd"),
					timeout: expectOptionalNumber(args, "timeout"),
				}, allowedCommands, deniedCommands)
				break
			}

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
