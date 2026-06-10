import { serializeError } from "serialize-error"
import { Anthropic } from "@anthropic-ai/sdk"
import type { ToolName, ClineAsk } from "@njust-ai/types"
import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"
import type { ToolResponse, ToolUse, PushToolResultOptions } from "../../shared/tools"
import { getErrorMessage } from "../../shared/error-utils"
import { logger } from "../../shared/logger"
import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { Task } from "../task/Task"
import { toolRegistry } from "../tools/ToolRegistry"
import { ReadFileTool } from "../tools/ReadFileTool"
import { StreamingToolExecutor } from "../tools/StreamingToolExecutor"
import { dedupeReadonlyToolCalls, partitionToolCalls } from "../tools/toolOrchestration"
import type { ToolCallbacks } from "../tools/BaseTool"
import { mergeToolParamsForValidation, validateToolUse } from "../tools/validateToolUse"
import { validateToolParams } from "../tools/toolParamValidator"
import { getToolResultBudget, truncateToolResult, estimateTokens } from "../tools/toolResultBudget"
import type { ModeConfig } from "@njust-ai/types"
import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { markUserContentReadyIfDrained } from "./streamState"
import type { TypedBlock } from "./types"

export function applyToolResultTokenBudget(cline: Task, text: string): string {
	const contextWindow = cline.api.getModel().info?.contextWindow ?? 200_000
	const budget = getToolResultBudget(contextWindow)
	if (estimateTokens(text) <= budget.singleMax) {
		return text
	}
	return truncateToolResult(text, budget.singleMax)
}
function isConcurrencySafeToolUseBlock(block: ToolUse): boolean {
	return toolRegistry.getConcurrencySafeNames().has(block.name as ToolName)
}
const streamingToolExecutor = new StreamingToolExecutor(
	Math.max(1, Number(process.env.NJUST_AI_MAX_TOOL_CONCURRENCY ?? 10) || 10),
)
async function handleConcurrencySafeToolUse(
	cline: Task,
	block: ToolUse,
	callbacks: ToolCallbacks,
	abortSignal?: AbortSignal,
): Promise<boolean> {
	const tool = toolRegistry.get(block.name)
	if (tool && toolRegistry.getConcurrencySafeNames().has(block.name as ToolName)) {
		const merged: ToolCallbacks = abortSignal ? { ...callbacks, abortSignal } : callbacks
		await tool.handle(cline, block as ToolUse, merged)
		return true
	}
	return false
}
export function buildToolDescription(block: ToolUse, customModes?: ModeConfig[]): string {
	switch (block.name) {
		case "execute_command":
			return `[${block.name} for '${block.params.command}']`
		case "read_file":
			if (block.nativeArgs) {
				return (toolRegistry.get("read_file") as ReadFileTool).getReadFileToolDescription(
					block.name,
					block.nativeArgs as UnsafeAny,
				)
			}
			return (toolRegistry.get("read_file") as ReadFileTool).getReadFileToolDescription(block.name, block.params)
		case "write_to_file": {
			const na = block.nativeArgs as { path?: string } | undefined
			const p = block.params?.path ?? na?.path ?? ""
			return `[${block.name} for '${p}']`
		}
		case "apply_diff":
			return block.params?.path ? `[${block.name} for '${block.params.path}']` : `[${block.name}]`
		case "search_files":
			return `[${block.name} for '${block.params.regex}'${
				block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
			}]`
		case "edit":
		case "search_and_replace":
		case "search_replace":
		case "edit_file":
			return `[${block.name} for '${block.params.file_path}']`
		case "apply_patch":
		case "attempt_completion":
		case "update_todo_list":
			return `[${block.name}]`
		case "list_files": {
			const na = block.nativeArgs as { path?: string } | undefined
			const p = (block.params?.path as string | undefined) ?? na?.path ?? "."
			return `[${block.name} for '${p}']`
		}
		case "use_mcp_tool":
		case "access_mcp_resource":
			return `[${block.name} for '${block.params.server_name}']`
		case "ask_followup_question":
			return `[${block.name} for '${block.params.question}']`
		case "switch_mode":
			return `[${block.name} to '${block.params.mode_slug}'${block.params.reason ? ` because: ${block.params.reason}` : ""}]`
		case "codebase_search":
			return `[${block.name} for '${block.params.query}']`
		case "read_command_output":
			return `[${block.name} for '${block.params.artifact_id}']`
		case "new_task": {
			const mode = block.params.mode ?? defaultModeSlug
			const message = block.params.message ?? "(no message)"
			const modeName = getModeBySlug(mode, customModes)?.name ?? mode
			return `[${block.name} in ${modeName} mode: '${message}']`
		}
		case "run_slash_command":
			return `[${block.name} for '${block.params.command}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
		case "skill":
			return `[${block.name} for '${block.params.skill}'${block.params.args ? ` with args: ${block.params.args}` : ""}]`
		case "generate_image":
			return `[${block.name} for '${block.params.path}']`
		case "web_search":
			return `[${block.name} for '${block.params.search_query}']`
		default:
			return `[${block.name}]`
	}
}
export async function validateToolUseBlock(
	cline: Task,
	block: ToolUse,
	toolCallId: string,
	mode: string | undefined,
	customModes: ModeConfig[] | undefined,
	stateExperiments: Record<string, unknown> | undefined,
	disabledTools: string[] | undefined,
	allowedTools: string[] | undefined,
): Promise<boolean> {
	if (block.partial) return true
	const modelInfo = cline.api.getModel()
	const rawIncludedTools = modelInfo?.info?.includedTools
	const { resolveToolAlias } = await import("../prompts/tools/filter-tools-for-mode")
	const includedTools = Array.isArray(rawIncludedTools)
		? rawIncludedTools
				.filter((tool): tool is string => typeof tool === "string")
				.map((tool) => resolveToolAlias(tool))
		: undefined
	try {
		const toolRequirements =
			disabledTools?.reduce(
				(acc: Record<string, boolean>, tool: string) => {
					acc[tool] = false
					const resolvedToolName = resolveToolAlias(tool)
					acc[resolvedToolName] = false
					return acc
				},
				{} as Record<string, boolean>,
			) ?? {}
		validateToolUse(
			block.name as ToolName,
			mode ?? defaultModeSlug,
			customModes ?? [],
			toolRequirements,
			mergeToolParamsForValidation(block),
			stateExperiments as Record<string, boolean> | undefined,
			includedTools,
			allowedTools,
		)
		if (!block.partial) {
			const merged = mergeToolParamsForValidation(block)
			const paramCheck = validateToolParams(block.name, merged)
			if (!paramCheck.valid) {
				throw new Error(paramCheck.error!)
			}
		}
	} catch (error) {
		cline.consecutiveMistakeCount++
		const errorContent = formatResponse.toolError(getErrorMessage(error))
		cline.pushToolResultToUserContent({
			type: "tool_result",
			tool_use_id: sanitizeToolUseId(toolCallId),
			content: typeof errorContent === "string" ? errorContent : "(validation error)",
			is_error: true,
		})
		TelemetryService.reportError(error, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
		return false
	}
	return true
}
export async function checkToolRepetition(
	cline: Task,
	block: ToolUse,
	pushToolResult: (content: ToolResponse) => void,
): Promise<boolean> {
	if (block.partial) return true
	const repetitionCheck = cline.toolRepetitionDetector.check(block)
	if (!repetitionCheck.allowExecution && repetitionCheck.askUser) {
		const { response, text, images } = await cline.ask(
			repetitionCheck.askUser.messageKey as ClineAsk,
			repetitionCheck.askUser.messageDetail.replace("{toolName}", block.name),
		)

		if (response === "messageResponse") {
			cline.userMessageContent.push(
				{
					type: "text" as const,
					text: `Tool repetition limit reached. User feedback: ${text}`,
				},
				...formatResponse.imageBlocks(images),
			)
			await cline.say("user_feedback", text, images)
		}
		pushToolResult(
			formatResponse.toolError(
				`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
			),
		)
		return false
	}
	return true
}
export async function tryEagerBatch(cline: Task): Promise<boolean> {
	try {
		const state = await cline.providerRef.deref()?.getState()
		const autoApproveOn = Boolean(state?.autoApprovalEnabled)
		if (autoApproveOn && !cline.didRejectTool) {
			const start = cline.currentStreamingContentIndex
			const run: ToolUse[] = []
			for (let i = start; i < cline.assistantMessageContent.length; i++) {
				const b = cline.assistantMessageContent[i] as unknown as TypedBlock
				if (!b || b.type !== "tool_use") break
				if (!b.id) break
				const tb = b as unknown as ToolUse
				if (!isConcurrencySafeToolUseBlock(tb)) break
				if (streamingToolExecutor.shouldEagerExecute(cline, tb) !== "eager") break
				run.push(tb)
			}
			if (run.length > 1) {
				const deduped = dedupeReadonlyToolCalls(run)
				const duplicateToOriginal = deduped.duplicateToOriginal
				const runUnique = deduped.uniqueCalls
				const batches = partitionToolCalls(runUnique, (call) => isConcurrencySafeToolUseBlock(call))
				let cascadeStop = false
				const allowedToolsSet: ReadonlySet<string> | undefined = cline.allowedTools
					? cline.allowedTools instanceof Set
						? cline.allowedTools
						: new Set(cline.allowedTools)
					: undefined
				const runOne = async (toolBlock: ToolUse, batchSignal?: AbortSignal) => {
					if (cline.abort || cline.didRejectTool || cascadeStop) return
					if (batchSignal?.aborted) return
					const toolCallId = (toolBlock as UnsafeAny as TypedBlock).id as string
					if (allowedToolsSet && !allowedToolsSet.has(toolBlock.name)) {
						cline.pushToolResultToUserContent({
							type: "tool_result",
							tool_use_id: sanitizeToolUseId(toolCallId),
							content: formatResponse.toolError(
								`Tool "${toolBlock.name}" is not allowed for this delegated agent context.`,
							),
							is_error: true,
						})
						return
					}
					let hasToolResult = false
					const pushToolResult = (content: ToolResponse, second?: string[] | PushToolResultOptions) => {
						if (hasToolResult) return
						const opts = second && !Array.isArray(second) ? second : undefined
						let resultContent: string
						let imageBlocks: Anthropic.ImageBlockParam[] = []
						if (typeof content === "string") {
							resultContent = content || "(tool did not return anything)"
						} else {
							const textBlocks = content.filter((item) => item.type === "text")
							imageBlocks = content.filter((item) => item.type === "image") as Anthropic.ImageBlockParam[]
							resultContent =
								textBlocks.map((item) => (item as Anthropic.TextBlockParam).text).join("\n") ||
								"(tool did not return anything)"
						}
						const isErrorResult =
							opts?.isError ?? (typeof content === "string" && content.includes("<error>"))
						const budgetedResultContent = applyToolResultTokenBudget(cline, resultContent)
						cline.pushToolResultToUserContent({
							type: "tool_result",
							tool_use_id: sanitizeToolUseId(toolCallId),
							content: budgetedResultContent,
							is_error: isErrorResult || undefined,
						})
						if (imageBlocks.length > 0) cline.userMessageContent.push(...imageBlocks)
						if (toolBlock.name === "execute_command" && isErrorResult) {
							cascadeStop = true
						}
						hasToolResult = true
					}
					const askApproval: ToolCallbacks["askApproval"] = async (
						type,
						partialMessage,
						progressStatus,
						isProtected,
					) => {
						if (!autoApproveOn) return false
						if (type === "tool") return true
						return await cline
							.ask(type, partialMessage, false, progressStatus, isProtected || false)
							.then((r) => r.response === "yesButtonClicked")
					}
					const handleError: ToolCallbacks["handleError"] = async (action, error) => {
						const err = error instanceof Error ? error : new Error(String(error))
						const errorString = `Error ${action}: ${JSON.stringify(serializeError(err))}`
						await cline.say("error", `Error ${action}:\n${getErrorMessage(err)}`)
						pushToolResult(formatResponse.toolError(errorString), { isError: true })
						if (toolBlock.name === "execute_command") {
							cascadeStop = true
						}
					}
					const reportProgress: ToolCallbacks["reportProgress"] = async (status) => {
						await cline
							.ask("tool", JSON.stringify({ tool: "progress", text: status?.text }), true, status)
							.catch(() => undefined)
					}
					await handleConcurrencySafeToolUse(
						cline,
						toolBlock,
						{
							askApproval,
							handleError,
							pushToolResult,
							reportProgress,
						},
						batchSignal,
					)
				}
				for (const batch of batches) {
					if (cascadeStop) {
						for (const skipped of batch.calls) {
							cline.pushToolResultToUserContent({
								type: "tool_result",
								tool_use_id: sanitizeToolUseId((skipped as UnsafeAny as TypedBlock).id as string),
								content: formatResponse.toolError(
									"Skipped due to prior execute_command failure in this tool batch.",
								),
								is_error: true,
							})
						}
						continue
					}
					if (batch.mode === "parallel") {
						await streamingToolExecutor.runEagerBatch(cline, batch.calls, async (toolBlock, signal) =>
							runOne(toolBlock, signal),
						)
					} else {
						await runOne(batch.calls[0]!)
					}
				}
				for (const [dupId, originId] of duplicateToOriginal.entries()) {
					const existing = cline.userMessageContent.find(
						(block): block is Anthropic.ToolResultBlockParam =>
							block.type === "tool_result" && block.tool_use_id === sanitizeToolUseId(originId),
					)
					if (existing) {
						cline.pushToolResultToUserContent({
							type: "tool_result",
							tool_use_id: sanitizeToolUseId(dupId),
							content: existing.content,
							is_error: existing.is_error,
						})
					}
				}
				cline.currentStreamingContentIndex += run.length
				markUserContentReadyIfDrained(cline)
				return true
			}
		}
	} catch (err) {
		logger.error(
			"PresentAssistantMessage",
			"[presentAssistantMessage] Auto-approve eager batch path failed; falling back to serial execution:",
			err,
		)
		TelemetryService.reportError(err, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
	}
	return false
}
