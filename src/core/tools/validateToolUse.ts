import type { ToolName, ModeConfig, GroupOptions, GroupEntry } from "@njust-ai/types"
import { toolNames as validToolNames, TelemetryEventName } from "@njust-ai/types"
import { customToolRegistry } from "@njust-ai/core/custom-tools"

import { type Mode, FileRestrictionError, getModeBySlug, getGroupName } from "../../shared/modes"
import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS, TOOL_ALIASES } from "../../shared/tools"
import { isAllowedCangjieCommand } from "../task/CangjieRuntimePolicy"
import { logger } from "../../shared/logger"
import { TelemetryService } from "@njust-ai/telemetry"

/**
 * Merge `params` with typed `nativeArgs` for mode and schema validation.
 * Some tool blocks only populate `nativeArgs`; validating with empty `params` can skip path checks
 * or mis-classify edit operations in modes with `edit` group options.
 *
 * **Important:** Preserve booleans, numbers, and structured values from `nativeArgs`.
 * Previously, non-string values were `JSON.stringify`d, which turned `false` into the string `"false"`
 * and `60` into `"60"`, breaking zod validation and tool execution.
 */
function mergeNativeValueForValidation(value: UnsafeAny): UnsafeAny {
	if (value === undefined || value === null) {
		return value
	}
	const t = typeof value
	if (t === "string" || t === "boolean" || t === "number" || t === "bigint") {
		return value
	}
	if (t === "object") {
		return value
	}
	return String(value)
}

export function mergeToolParamsForValidation(block: {
	params?: Record<string, UnsafeAny>
	nativeArgs?: UnsafeAny
}): Record<string, UnsafeAny> {
	const merged: Record<string, UnsafeAny> = { ...(block.params ?? {}) }
	const na = block.nativeArgs
	if (na && typeof na === "object" && !Array.isArray(na)) {
		for (const [key, value] of Object.entries(na as Record<string, UnsafeAny>)) {
			const currentValue = merged[key]
			const shouldUseNativeStructuredValue =
				typeof currentValue === "string" &&
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value)
			if (currentValue !== undefined && currentValue !== "" && !shouldUseNativeStructuredValue) {
				continue
			}
			if (value === undefined || value === null) {
				continue
			}
			merged[key] = mergeNativeValueForValidation(value)
		}
	}
	return merged
}

/**
 * Checks if a tool name is a valid, known tool.
 * Note: This does NOT check if the tool is allowed for a specific mode,
 * only that the tool actually exists.
 */
export function isValidToolName(toolName: string, experiments?: Record<string, boolean>): toolName is ToolName {
	// Check if it's a valid static tool
	if ((validToolNames as readonly string[]).includes(toolName)) {
		return true
	}

	if (experiments?.customTools && customToolRegistry.has(toolName)) {
		return true
	}

	// Check if it's a dynamic MCP tool (mcp_serverName_toolName format).
	if (toolName.startsWith("mcp_")) {
		return true
	}

	return false
}

export function validateToolUse(
	toolName: ToolName,
	mode: Mode,
	customModes?: ModeConfig[],
	toolRequirements?: Record<string, boolean>,
	toolParams?: Record<string, UnsafeAny>,
	experiments?: Record<string, boolean>,
	includedTools?: string[],
	allowedTools?: string[],
): void {
	// First, check if the tool name is actually a valid/known tool
	// This catches completely invalid tool names like "edit_file" that don't exist
	if (!isValidToolName(toolName, experiments)) {
		throw new Error(
			`Unknown tool "${toolName}". This tool does not exist. Please use one of the available tools: ${validToolNames.join(", ")}.`,
		)
	}

	if (allowedTools && allowedTools.length > 0 && !allowedTools.includes(toolName)) {
		throw new Error(`Tool "${toolName}" is not allowed for this delegated agent context.`)
	}

	// Then check if the tool is allowed for the current mode
	if (
		!isToolAllowedForMode(
			toolName,
			mode,
			customModes ?? [],
			toolRequirements,
			toolParams,
			experiments,
			includedTools,
		)
	) {
		throw new Error(`Tool "${toolName}" is not allowed in ${mode} mode.`)
	}
}

const EDIT_OPERATION_PARAMS = [
	"diff",
	"content",
	"operations",
	"search",
	"replace",
	"args",
	"line",
	"patch", // Used by apply_patch
	"old_string", // Used by search_replace and edit_file
	"new_string", // Used by search_replace and edit_file
] as const

// Markers used in apply_patch format to identify file operations
const PATCH_FILE_MARKERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "] as const

// Standard unified diff markers (--- a/path, +++ b/path)
const UNIFIED_DIFF_MARKERS = ["--- a/", "+++ b/", "--- ", "+++ "] as const

/**
 * Extract file paths from apply_patch content.
 * The patch format uses markers like "*** Add File: path", "*** Delete File: path", "*** Update File: path"
 * @param patchContent The patch content string
 * @returns Array of file paths found in the patch
 */
function extractFilePathsFromPatch(patchContent: string): string[] {
	const filePaths: string[] = []
	const lines = patchContent.split("\n")

	for (const line of lines) {
		// Check custom patch markers first
		for (const marker of PATCH_FILE_MARKERS) {
			if (line.startsWith(marker)) {
				const path = line.substring(marker.length).trim()
				if (path) {
					filePaths.push(path)
				}
				break
			}
		}

		// Check standard unified diff markers (--- a/path or +++ b/path)
		for (const marker of UNIFIED_DIFF_MARKERS) {
			if (line.startsWith(marker)) {
				// Extract path, handling optional tab-separated timestamp (e.g., "--- a/file.txt\t2024-01-01")
				const rawPath = line.substring(marker.length).split("\t")[0]!.trim()
				// Skip /dev/null entries (used for new/deleted files in unified diff)
				if (rawPath && rawPath !== "/dev/null") {
					filePaths.push(rawPath)
				}
				break
			}
		}
	}

	return filePaths
}

function getGroupOptions(group: GroupEntry): GroupOptions | undefined {
	return Array.isArray(group) ? group[1] : undefined
}

function doesFileMatchRegex(filePath: string, pattern: string): boolean {
	// ReDoS protection: reject overly long or potentially catastrophic patterns
	if (pattern.length > 500) return false
	if (/([+*?{])\s*\1/.test(pattern)) return false
	try {
		const regex = new RegExp(pattern)
		return regex.test(filePath)
	} catch (error) {
		logger.error("ValidateToolUse", `Invalid regex pattern: ${pattern}`, error)
		TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR)
		return false
	}
}

export function isToolAllowedForMode(
	tool: string,
	modeSlug: string,
	customModes: ModeConfig[],
	toolRequirements?: Record<string, boolean>,
	toolParams?: Record<string, UnsafeAny>, // All tool parameters
	experiments?: Record<string, boolean>,
	includedTools?: string[], // Opt-in tools explicitly included (e.g., from modelInfo)
): boolean {
	// Resolve alias to canonical name (e.g., "search_and_replace" → "edit")
	const resolvedTool = TOOL_ALIASES[tool] ?? tool
	const resolvedIncludedTools = includedTools?.map((t) => TOOL_ALIASES[t] ?? t)

	if (modeSlug === "cangjie") {
		if (resolvedTool === "web_fetch" || resolvedTool === "config" || resolvedTool === "sleep") {
			return false
		}
		if (resolvedTool === "execute_command") {
			const command = typeof toolParams?.command === "string" ? toolParams.command : undefined
			if (command && !isAllowedCangjieCommand(command)) {
				return false
			}
		}
	}

	// Check tool requirements first — explicit disabling takes priority over everything,
	// including ALWAYS_AVAILABLE_TOOLS. This ensures disabledTools works consistently
	// at both the filtering layer and the execution-time validation layer.
	if (toolRequirements && typeof toolRequirements === "object") {
		if (
			(tool in toolRequirements && !toolRequirements[tool]) ||
			(resolvedTool in toolRequirements && !toolRequirements[resolvedTool])
		) {
			return false
		}
	} else if (toolRequirements === false) {
		// If toolRequirements is a boolean false, all tools are disabled
		return false
	}

	// Always allow these tools (unless explicitly disabled above)
	if (ALWAYS_AVAILABLE_TOOLS.includes(tool as UnsafeAny)) {
		return true
	}

	// For now, allow all custom tools in any mode.
	// As a follow-up we should expand the custom tool definition to include mode restrictions.
	if (experiments?.customTools && customToolRegistry.has(tool)) {
		return true
	}

	// Check if this is a dynamic MCP tool (mcp_serverName_toolName)
	// These should be allowed if the mcp group is allowed for the mode
	const isDynamicMcpTool = tool.startsWith("mcp_")

	const mode = getModeBySlug(modeSlug, customModes)

	if (!mode) {
		return false
	}

	// Check if tool is in any of the mode's groups and respects any group options
	for (const group of mode.groups) {
		const groupName = getGroupName(group)
		const options = getGroupOptions(group)

		const groupConfig = TOOL_GROUPS[groupName]

		// Check if this is a dynamic MCP tool and the mcp group is allowed
		if (isDynamicMcpTool && groupName === "mcp") {
			// Dynamic MCP tools are allowed if the mcp group is in the mode's groups
			return true
		}

		// Check if the tool is in the group's regular tools
		const isRegularTool = groupConfig.tools.includes(resolvedTool)

		// Check if the tool is a custom tool that has been explicitly included
		const isCustomTool =
			groupConfig.customTools?.includes(resolvedTool) && resolvedIncludedTools?.includes(resolvedTool)

		// If the tool isn't in regular tools and isn't an included custom tool, continue to next group
		if (!isRegularTool && !isCustomTool) {
			continue
		}

		// If there are no options, allow the tool
		if (!options) {
			return true
		}

		// For the edit group, check file regex if specified
		if (groupName === "edit" && options.fileRegex) {
			const filePath = toolParams?.path || toolParams?.file_path
			// Check if this is an actual edit operation (not just path-only for streaming)
			const isEditOperation = EDIT_OPERATION_PARAMS.some((param) => toolParams?.[param])

			// Handle single file path validation
			if (filePath && isEditOperation && !doesFileMatchRegex(filePath, options.fileRegex)) {
				throw new FileRestrictionError(mode.name, options.fileRegex, options.description, filePath, tool)
			}

			// Handle apply_patch: extract file paths from patch content and validate each
			if (tool === "apply_patch" && typeof toolParams?.patch === "string") {
				const patchFilePaths = extractFilePathsFromPatch(toolParams.patch)
				for (const patchFilePath of patchFilePaths) {
					if (!doesFileMatchRegex(patchFilePath, options.fileRegex)) {
						throw new FileRestrictionError(
							mode.name,
							options.fileRegex,
							options.description,
							patchFilePath,
							tool,
						)
					}
				}
			}

			// Native-only: multi-file edits provide structured params; no legacy XML args parsing.
		}

		return true
	}

	return false
}
