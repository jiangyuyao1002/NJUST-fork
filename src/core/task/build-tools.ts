import path from "path"
import { createHash } from "crypto"

import type OpenAI from "openai"
import { z } from "zod"

import type { ProviderSettings, ModeConfig, ModelInfo } from "@njust-ai-cj/types"
import { customToolRegistry, formatNative } from "@njust-ai-cj/core"

import type { ITaskHost } from "./interfaces/ITaskHost"
import { getRooDirectoriesForCwd } from "../../services/roo-config/index.js"

import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import {
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	resolveToolAlias,
} from "../prompts/tools/filter-tools-for-mode"
import { globalToolSchemaCache } from "../tools/toolSchemaCache"

const allowedFunctionNamesSchema = z.array(z.string())

interface BuildToolsOptions {
	provider: ITaskHost
	cwd: string
	mode: string | undefined
	customModes: ModeConfig[] | undefined
	experiments: Record<string, boolean> | undefined
	apiConfiguration: ProviderSettings | undefined
	disabledTools?: string[]
	enableWebSearch?: boolean
	modelInfo?: ModelInfo
	/**
	 * If true, returns all tools without mode filtering, but also includes
	 * the list of allowed tool names for use with allowedFunctionNames.
	 * This enables providers that support function call restrictions (e.g., Gemini)
	 * to pass all tool definitions while restricting callable tools.
	 */
	includeAllToolsWithRestrictions?: boolean
}

interface BuildToolsResult {
	/**
	 * The tools to pass to the model.
	 * If includeAllToolsWithRestrictions is true, this includes ALL tools.
	 * Otherwise, it includes only mode-filtered tools.
	 */
	tools: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * The names of tools that are allowed to be called based on mode restrictions.
	 * Only populated when includeAllToolsWithRestrictions is true.
	 * Use this with allowedFunctionNames in providers that support it.
	 */
	allowedFunctionNames?: string[]
}

/**
 * Extracts the function name from a tool definition.
 */
function getToolName(tool: OpenAI.Chat.ChatCompletionTool): string {
	return (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name
}

/**
 * Builds the complete tools array for native protocol requests.
 * Combines native tools and MCP tools, filtered by mode restrictions.
 *
 * @param options - Configuration options for building the tools
 * @returns Array of filtered native and MCP tools
 */
export async function buildNativeToolsArray(options: BuildToolsOptions): Promise<OpenAI.Chat.ChatCompletionTool[]> {
	const result = await buildNativeToolsArrayWithRestrictions(options)
	return result.tools
}

/**
 * Builds the complete tools array for native protocol requests with optional mode restrictions.
 * When includeAllToolsWithRestrictions is true, returns ALL tools but also provides
 * the list of allowed tool names for use with allowedFunctionNames.
 *
 * This enables providers like Gemini to pass all tool definitions to the model
 * (so it can reference historical tool calls) while restricting which tools
 * can actually be invoked via allowedFunctionNames in toolConfig.
 *
 * @param options - Configuration options for building the tools
 * @returns BuildToolsResult with tools array and optional allowedFunctionNames
 */
export async function buildNativeToolsArrayWithRestrictions(options: BuildToolsOptions): Promise<BuildToolsResult> {
	const {
		provider,
		cwd,
		mode,
		customModes,
		experiments,
		apiConfiguration,
		disabledTools,
		enableWebSearch,
		modelInfo,
		includeAllToolsWithRestrictions,
	} = options

	const mcpHub = provider.getMcpHub()

	const effectiveDisabledTools = [...(disabledTools ?? [])]
	if (!enableWebSearch) {
		effectiveDisabledTools.push("web_search")
	}

	// Compute a config hash for schema cache validation.
	// Includes: mode, disabled tools, supportsImages, MCP server+tool names, custom tools flag.
	const mcpToolNames = mcpHub
		? getMcpServerTools(mcpHub).map((t) => getToolName(t)).sort().join(",")
		: ""
	const configKey = [
		mode ?? "",
		effectiveDisabledTools.sort().join(","),
		String(modelInfo?.supportsImages ?? false),
		String(apiConfiguration?.todoListEnabled ?? true),
		String(!!experiments?.customTools),
		String(!!includeAllToolsWithRestrictions),
		mcpToolNames,
	].join("|")
	const configHash = createHash("md5").update(configKey).digest("hex")

	const cacheValid = globalToolSchemaCache.validateConfig(configHash)

	// If cache is valid and has entries, return cached tools directly.
	if (cacheValid && globalToolSchemaCache.size > 0) {
		const cachedTools = globalToolSchemaCache.getAllTools()
		if (includeAllToolsWithRestrictions) {
			// We need allowedFunctionNames — retrieve from cache metadata
			const allowedNames = globalToolSchemaCache.get("__allowedFunctionNames__")
			return {
				tools: cachedTools.filter((t) => getToolName(t) !== "__allowedFunctionNames__").sort((a, b) => getToolName(a).localeCompare(getToolName(b))),
				allowedFunctionNames: allowedNames
					? allowedFunctionNamesSchema.parse(JSON.parse(allowedNames.hash))
					: undefined,
			}
		}
		return { tools: cachedTools.sort((a, b) => getToolName(a).localeCompare(getToolName(b))) }
	}

	// Build settings object for tool filtering.
	const filterSettings = {
		todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
		disabledTools: effectiveDisabledTools,
		modelInfo,
	}

	// Check if the model supports images for read_file tool description.
	const supportsImages = modelInfo?.supportsImages ?? false

	// Build native tools with dynamic read_file tool based on settings.
	const nativeTools = getNativeTools({
		supportsImages,
	})

	// Build independent prerequisites in parallel where possible.
	const codeIndexManagerPromise = import("../../services/code-index/manager").then(({ CodeIndexManager }) =>
		CodeIndexManager.getInstance(provider.context, cwd),
	)
	const mcpToolsPromise = Promise.resolve(getMcpServerTools(mcpHub))
	const [codeIndexManager, mcpTools] = await Promise.all([codeIndexManagerPromise, mcpToolsPromise])

	// Filter native tools based on mode restrictions.
	const filteredNativeTools = filterNativeToolsForMode(
		nativeTools,
		mode,
		customModes,
		experiments,
		codeIndexManager,
		filterSettings,
		mcpHub,
	)

	// Filter MCP tools based on mode restrictions.
	const filteredMcpTools = filterMcpToolsForMode(mcpTools, mode, customModes, experiments)

	// Add custom tools if they are available and the experiment is enabled.
	let nativeCustomTools: OpenAI.Chat.ChatCompletionFunctionTool[] = []

	if (experiments?.customTools) {
		const toolDirs = getRooDirectoriesForCwd(cwd).map((dir) => path.join(dir, "tools"))
		await customToolRegistry.loadFromDirectoriesIfStale(toolDirs)
		const customTools = customToolRegistry.getAllSerialized()

		if (customTools.length > 0) {
			nativeCustomTools = customTools.map(formatNative)
		}
	}

	// Combine filtered tools (for backward compatibility and for allowedFunctionNames)
	const filteredTools = [...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools]

	// If includeAllToolsWithRestrictions is true, return ALL tools but provide
	// allowed names based on mode filtering
	if (includeAllToolsWithRestrictions) {
		// Combine ALL tools (unfiltered native + all MCP + custom)
		const allTools = [...nativeTools, ...mcpTools, ...nativeCustomTools]

		// Extract names of tools that are allowed based on mode filtering.
		// Resolve any alias names to canonical names to ensure consistency with allTools
		// (which uses canonical names). This prevents Gemini errors when tools are renamed
		// to aliases in filteredTools but allTools contains the original canonical names.
		const allowedFunctionNames = filteredTools.map((tool) => resolveToolAlias(getToolName(tool)))

		// Cache each tool schema for future reuse.
		for (const tool of allTools) {
			const name = getToolName(tool)
			globalToolSchemaCache.set(name, { name, schema: tool, hash: configHash })
		}
		// Store allowedFunctionNames in cache as metadata.
		globalToolSchemaCache.set("__allowedFunctionNames__", {
			name: "__allowedFunctionNames__",
			schema: {} as OpenAI.Chat.ChatCompletionTool,
			hash: JSON.stringify(allowedFunctionNames),
		})

		return {
			tools: allTools.sort((a, b) => getToolName(a).localeCompare(getToolName(b))),
			allowedFunctionNames,
		}
	}

	// Cache each tool schema for future reuse.
	for (const tool of filteredTools) {
		const name = getToolName(tool)
		globalToolSchemaCache.set(name, { name, schema: tool, hash: configHash })
	}

	// Default behavior: return only filtered tools
	return {
		tools: filteredTools.sort((a, b) => getToolName(a).localeCompare(getToolName(b))),
	}
}
