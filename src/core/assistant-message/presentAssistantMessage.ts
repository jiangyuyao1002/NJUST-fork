import { serializeError } from "serialize-error"
import { Anthropic } from "@anthropic-ai/sdk"

import type { ToolName, ClineAsk, ToolProgressStatus } from "@njust-ai/types"
import { TelemetryEventName } from "@njust-ai/types"
import { customToolRegistry } from "@njust-ai/core"

import { t } from "../../i18n"

import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import type { ToolResponse, ToolUse, McpToolUse, PushToolResultOptions } from "../../shared/tools"
import { getErrorMessage, wrapAsError } from "../../shared/error-utils"

import { logger } from "../../shared/logger"
import { TelemetryService } from "@njust-ai/telemetry"
import { AskIgnoredError } from "../task/AskIgnoredError"
import { Task } from "../task/Task"
import { TaskState } from "../task/TaskStateMachine"

// Tool registry: single source of truth for all tool instances
import "../tools/registerAllTools" // side-effect: populates toolRegistry
import { toolRegistry } from "../tools/ToolRegistry"
import { AttemptCompletionCallbacks } from "../tools/AttemptCompletionTool"
import { ReadFileTool } from "../tools/ReadFileTool" // for getReadFileToolDescription
import { isValidToolName, mergeToolParamsForValidation, validateToolUse } from "../tools/validateToolUse"
import { validateToolParams } from "../tools/toolParamValidator"
import { StreamingToolExecutor } from "../tools/StreamingToolExecutor"
import { dedupeReadonlyToolCalls, partitionToolCalls } from "../tools/toolOrchestration"
import type { ToolCallbacks } from "../tools/BaseTool"

import { formatResponse } from "../prompts/responses"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { getToolResultBudget, truncateToolResult, estimateTokens } from "../tools/toolResultBudget"
import type { AssistantMessageContent, TypedBlock } from "./types"
import { markUserContentReadyIfDrained } from "./streamState"

export { markUserContentReadyIfDrained } from "./streamState"

// Tool registry is populated by the side-effect import of registerAllTools above.
// CONCURRENCY_SAFE_TOOL_NAMES is now provided by toolRegistry.getConcurrencySafeNames()

function applyToolResultTokenBudget(cline: Task, text: string): string {
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

/**
 * Handle concurrency-safe tool execution using the ToolRegistry.
 * Replaces the previous 15-case switch-case with a dynamic registry lookup.
 */
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

/**
 * Processes and presents assistant message content to the user interface.
 *
 * This function is the core message handling system that:
 * - Sequentially processes content blocks from the assistant's response.
 * - Displays text content to the user.
 * - Executes tool use requests with appropriate user approval.
 * - Manages the flow of conversation by determining when to proceed to the next content block.
 * - Coordinates file system checkpointing for modified files.
 * - Controls the conversation state to determine when to continue to the next request.
 *
 * The function uses a locking mechanism to prevent concurrent execution and handles
 * partial content blocks during streaming. It's designed to work with the streaming
 * API response pattern, where content arrives incrementally and needs to be processed
 * as it becomes available.
 */

export async function presentAssistantMessage(cline: Task) {
	if (cline.abort) {
		throw new Error(`[Task#presentAssistantMessage] task ${cline.taskId}.${cline.instanceId} aborted`)
	}

	if (cline.presentAssistantMessageLocked) {
		cline.presentAssistantMessageHasPendingUpdates = true
		return
	}

	cline.presentAssistantMessageLocked = true
	cline.presentAssistantMessageHasPendingUpdates = false
	const _lockAcquiredAt = performance.now()

	try {
		// Dispatch loop: replaces tail-recursive presentAssistantMessage(cline) calls
		// with an explicit while-loop. Each iteration processes one content block (or
		// an eager batch). The loop exits when there is nothing left to process or when
		// we must wait for more streaming data.

		while (true) {
			if (cline.currentStreamingContentIndex >= cline.assistantMessageContent.length) {
				// This may happen if the last content block was completed before
				// streaming could finish. If streaming is finished, and we're out of
				// bounds then this means we already  presented/executed the last
				// content block and are ready to continue to next request.
				markUserContentReadyIfDrained(cline)

				break // exit loop → unlock below
			}

			let block: AssistantMessageContent
			try {
				// Performance optimization: Use shallow copy instead of deep clone.
				// The block is used read-only throughout this function - we never mutate its properties.
				// We only need to protect against the reference changing during streaming, not nested mutations.
				// This provides 80-90% reduction in cloning overhead (5-100ms saved per block).
				block = {
					...cline.assistantMessageContent[cline.currentStreamingContentIndex],
				} as AssistantMessageContent
			} catch (error) {
				logger.error("PresentAssistantMessage", "ERROR cloning block:", error)
				logger.error(
					"PresentAssistantMessage",
					`Block content:`,
					JSON.stringify(cline.assistantMessageContent[cline.currentStreamingContentIndex], null, 2),
				)
				TelemetryService.reportError(error, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
				cline.presentAssistantMessageLocked = false
				return
			}

			switch (block.type) {
				case "mcp_tool_use": {
					// Handle native MCP tool calls (from mcp_serverName_toolName dynamic tools)
					// These are converted to the same execution path as use_mcp_tool but preserve
					// their original name in API history
					const mcpBlock = block as McpToolUse

					if (cline.didRejectTool) {
						// For native protocol, we must send a tool_result for every tool_use to avoid API errors
						const toolCallId = mcpBlock.id
						const errorMessage = !mcpBlock.partial
							? `Skipping MCP tool ${mcpBlock.name} due to user rejecting a previous tool.`
							: `MCP tool ${mcpBlock.name} was interrupted and not executed due to user rejecting a previous tool.`

						if (toolCallId) {
							cline.pushToolResultToUserContent({
								type: "tool_result",
								tool_use_id: sanitizeToolUseId(toolCallId),
								content: errorMessage,
								is_error: true,
							})
						}
						break
					}

					// Track if we've already pushed a tool result
					let hasToolResult = false
					const toolCallId = mcpBlock.id

					// Store approval feedback to merge into tool result (GitHub #10465)
					let approvalFeedback: { text: string; images?: string[] } | undefined

					const pushToolResult = (content: ToolResponse, second?: string[] | PushToolResultOptions) => {
						if (hasToolResult) {
							logger.warn(
								"PresentAssistantMessage",
								`[presentAssistantMessage] Skipping duplicate tool_result for mcp_tool_use: ${toolCallId}`,
							)
							return
						}
						const feedbackImages = Array.isArray(second) ? second : undefined
						const optErr = second && !Array.isArray(second) ? second : undefined

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

						// Merge approval feedback into tool result (GitHub #10465)
						if (approvalFeedback) {
							const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
							resultContent = `${feedbackText}\n\n${resultContent}`

							// Add feedback images to the image blocks
							if (approvalFeedback.images) {
								const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
								imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
							}
						}

						if (feedbackImages && feedbackImages.length > 0) {
							const extra = formatResponse.imageBlocks(feedbackImages)
							imageBlocks = [...extra, ...imageBlocks]
						}

						resultContent = applyToolResultTokenBudget(cline, resultContent)

						if (toolCallId) {
							cline.pushToolResultToUserContent({
								type: "tool_result",
								tool_use_id: sanitizeToolUseId(toolCallId),
								content: resultContent,
								is_error: optErr?.isError || undefined,
							})

							if (imageBlocks.length > 0) {
								cline.userMessageContent.push(...imageBlocks)
							}
						}

						hasToolResult = true
					}

					const _toolDescription = () => `[mcp_tool: ${mcpBlock.serverName}/${mcpBlock.toolName}]`

					const askApproval = async (
						type: ClineAsk,
						partialMessage?: string,
						progressStatus?: ToolProgressStatus,
						isProtected?: boolean,
					) => {
						cline.forceTaskState(TaskState.WAITING_APPROVAL)
						const { response, text, images } = await cline.ask(
							type,
							partialMessage,
							false,
							progressStatus,
							isProtected || false,
						)

						if (response !== "yesButtonClicked") {
							if (text) {
								await cline.say("user_feedback", text, images)
								pushToolResult(
									formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images),
								)
							} else {
								pushToolResult(formatResponse.toolDenied())
							}
							cline.didRejectTool = true
							return false
						}

						// Store approval feedback to be merged into tool result (GitHub #10465)
						// Don't push it as a separate tool_result here - that would create duplicates.
						// The tool will call pushToolResult, which will merge the feedback into the actual result.
						if (text) {
							await cline.say("user_feedback", text, images)
							approvalFeedback = { text, images }
						}

						cline.forceTaskState(TaskState.PROCESSING_TOOLS)
						return true
					}

					const handleError = async (action: string, error: Error) => {
						// Silently ignore AskIgnoredError - this is an internal control flow
						// signal, not an actual error. It occurs when a newer ask supersedes an older one.
						if (error instanceof AskIgnoredError) {
							return
						}
						const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`
						await cline.say("error", `Error ${action}:\n${getErrorMessage(error)}`)
						pushToolResult(formatResponse.toolError(errorString))
					}

					if (!mcpBlock.partial) {
						cline.recordToolUsage("use_mcp_tool") // Record as use_mcp_tool for analytics
					}

					// Resolve sanitized server name back to original server name
					// The serverName from parsing is sanitized (e.g., "my_server" from "my server")
					// We need the original name to find the actual MCP connection
					const mcpHub = cline.providerRef.deref()?.getMcpHub()
					let resolvedServerName = mcpBlock.serverName
					if (mcpHub) {
						const originalName = mcpHub.findServerNameBySanitizedName(mcpBlock.serverName)
						if (originalName) {
							resolvedServerName = originalName
						}
					}

					// Execute the MCP tool using the same handler as use_mcp_tool
					// Create a synthetic ToolUse block that the registered use_mcp_tool handler can process
					const syntheticToolUse: ToolUse<"use_mcp_tool"> = {
						type: "tool_use",
						id: mcpBlock.id,
						name: "use_mcp_tool",
						params: {
							server_name: resolvedServerName,
							tool_name: mcpBlock.toolName,
							arguments: JSON.stringify(mcpBlock.arguments),
						},
						partial: mcpBlock.partial,
						nativeArgs: {
							server_name: resolvedServerName,
							tool_name: mcpBlock.toolName,
							arguments: mcpBlock.arguments,
						},
					}

					await toolRegistry.get("use_mcp_tool")!.handle(cline, syntheticToolUse, {
						askApproval,
						handleError,
						pushToolResult,
					})
					break
				}
				case "text": {
					if (cline.didRejectTool || cline.didAlreadyUseTool) {
						break
					}

					let content = block.content

					if (content) {
						// Have to do this for partial and complete since sending
						// content in thinking tags to markdown renderer will
						// automatically be removed.
						// Strip any streamed <thinking> tags from text output.
						content = content.replace(/<thinking>\s?/g, "")
						content = content.replace(/\s?<\/thinking>/g, "")
					}

					await cline.say("text", content, undefined, block.partial)
					break
				}
				case "tool_use": {
					cline.forceTaskState(TaskState.PROCESSING_TOOLS)
					// Phase-B: auto-approve + consecutive safe tool_use blocks can execute concurrently.
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
								const batches = partitionToolCalls(runUnique, (call) =>
									isConcurrencySafeToolUseBlock(call),
								)
								let cascadeStop = false
								// Cache allowedTools once per batch instead of per-call Array.from
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
									const pushToolResult = (
										content: ToolResponse,
										second?: string[] | PushToolResultOptions,
									) => {
										if (hasToolResult) return
										const opts = second && !Array.isArray(second) ? second : undefined
										let resultContent: string
										let imageBlocks: Anthropic.ImageBlockParam[] = []
										if (typeof content === "string") {
											resultContent = content || "(tool did not return anything)"
										} else {
											const textBlocks = content.filter((item) => item.type === "text")
											imageBlocks = content.filter(
												(item) => item.type === "image",
											) as Anthropic.ImageBlockParam[]
											resultContent =
												textBlocks
													.map((item) => (item as Anthropic.TextBlockParam).text)
													.join("\n") || "(tool did not return anything)"
										}
										// Prefer explicit isError flag; fall back to heuristic for backward compat
										const isErrorResult =
											opts?.isError ??
											(typeof content === "string" && content.includes("<error>"))
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
											.ask(
												"tool",
												JSON.stringify({ tool: "progress", text: status?.text }),
												true,
												status,
											)
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
												tool_use_id: sanitizeToolUseId(
													(skipped as UnsafeAny as TypedBlock).id as string,
												),
												content: formatResponse.toolError(
													"Skipped due to prior execute_command failure in this tool batch.",
												),
												is_error: true,
											})
										}
										continue
									}
									if (batch.mode === "parallel") {
										await streamingToolExecutor.runEagerBatch(
											cline,
											batch.calls,
											async (toolBlock, signal) => runOne(toolBlock, signal),
										)
									} else {
										await runOne(batch.calls[0]!)
									}
								}
								// Replay tool_result for duplicated readonly calls so provider receives
								// a matching tool_result for every tool_use id.
								for (const [dupId, originId] of duplicateToOriginal.entries()) {
									const existing = cline.userMessageContent.find(
										(block): block is Anthropic.ToolResultBlockParam =>
											block.type === "tool_result" &&
											block.tool_use_id === sanitizeToolUseId(originId),
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
								continue // next iteration of dispatch loop
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
					// Native tool calling is the only supported tool calling mechanism.
					// A tool_use block without an id is invalid and cannot be executed.
					const toolCallId = (block as UnsafeAny as TypedBlock).id as string | undefined
					if (!toolCallId) {
						const errorMessage =
							"Invalid tool call: missing tool_use.id. XML tool calls are no longer supported. Remove any XML tool markup (e.g. <read_file>...</read_file>) and use native tool calling instead."
						// Record a tool error for visibility/telemetry. Use the reported tool name if present.
						try {
							if (
								typeof (cline as Record<string, UnsafeAny>).recordToolError === "function" &&
								typeof (block as Record<string, UnsafeAny>).name === "string"
							) {
								;(cline as Record<string, UnsafeAny>).recordToolError(
									(block as Record<string, UnsafeAny>).name as ToolName,
									errorMessage,
								)
							}
						} catch {
							// Best-effort only
						}
						cline.consecutiveMistakeCount++
						await cline.say("error", errorMessage)
						cline.userMessageContent.push({ type: "text", text: errorMessage })
						cline.didAlreadyUseTool = true
						break
					}

					// Skip if this tool_use_id already has a tool_result (e.g., executed in eager batch)
					const existingToolResult = cline.userMessageContent.find(
						(content): content is Anthropic.ToolResultBlockParam =>
							content.type === "tool_result" && content.tool_use_id === sanitizeToolUseId(toolCallId),
					)
					if (existingToolResult) {
						break
					}

					// Fetch state early so it's available for toolDescription and validation
					const state = await cline.providerRef.deref()?.getState()
					const { mode, customModes, experiments: stateExperiments, disabledTools } = state ?? {}
					const allowedTools = cline.allowedTools ? Array.from(cline.allowedTools) : undefined

					const toolDescription = (): string => {
						switch (block.name) {
							case "execute_command":
								return `[${block.name} for '${block.params.command}']`
							case "read_file":
								// Prefer native typed args when available; fall back to legacy params
								// Check if nativeArgs exists (native protocol)
								if (block.nativeArgs) {
									return (toolRegistry.get("read_file") as ReadFileTool).getReadFileToolDescription(
										block.name,
										block.nativeArgs as UnsafeAny,
									)
								}
								return (toolRegistry.get("read_file") as ReadFileTool).getReadFileToolDescription(
									block.name,
									block.params,
								)
							case "write_to_file": {
								const na = block.nativeArgs as { path?: string } | undefined
								const p = block.params?.path ?? na?.path ?? ""
								return `[${block.name} for '${p}']`
							}
							case "apply_diff":
								// Native-only: tool args are structured (no XML payloads).
								return block.params?.path
									? `[${block.name} for '${block.params.path}']`
									: `[${block.name}]`
							case "search_files":
								return `[${block.name} for '${block.params.regex}'${
									block.params.file_pattern ? ` in '${block.params.file_pattern}'` : ""
								}]`
							case "edit":
							case "search_and_replace":
								return `[${block.name} for '${block.params.file_path}']`
							case "search_replace":
								return `[${block.name} for '${block.params.file_path}']`
							case "edit_file":
								return `[${block.name} for '${block.params.file_path}']`
							case "apply_patch":
								return `[${block.name}]`
							case "list_files": {
								const na = block.nativeArgs as { path?: string } | undefined
								const p = (block.params?.path as string | undefined) ?? na?.path ?? "."
								return `[${block.name} for '${p}']`
							}
							case "use_mcp_tool":
								return `[${block.name} for '${block.params.server_name}']`
							case "access_mcp_resource":
								return `[${block.name} for '${block.params.server_name}']`
							case "ask_followup_question":
								return `[${block.name} for '${block.params.question}']`
							case "attempt_completion":
								return `[${block.name}]`
							case "switch_mode":
								return `[${block.name} to '${block.params.mode_slug}'${block.params.reason ? ` because: ${block.params.reason}` : ""}]`
							case "codebase_search":
								return `[${block.name} for '${block.params.query}']`
							case "read_command_output":
								return `[${block.name} for '${block.params.artifact_id}']`
							case "update_todo_list":
								return `[${block.name}]`
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

					if (cline.didRejectTool) {
						// Ignore any tool content after user has rejected tool once.
						// For native tool calling, we must send a tool_result for every tool_use to avoid API errors
						const errorMessage = !block.partial
							? `Skipping tool ${toolDescription()} due to user rejecting a previous tool.`
							: `Tool ${toolDescription()} was interrupted and not executed due to user rejecting a previous tool.`

						cline.pushToolResultToUserContent({
							type: "tool_result",
							tool_use_id: sanitizeToolUseId(toolCallId),
							content: errorMessage,
							is_error: true,
						})

						break
					}

					// Track if we've already pushed a tool result for this tool call (native tool calling only)
					let hasToolResult = false

					// If this is a native tool call but the parser couldn't construct nativeArgs
					// (e.g., malformed/unfinished JSON in a streaming tool call), we must NOT attempt to
					// execute the tool. Instead, emit exactly one structured tool_result so the provider
					// receives a matching tool_result for the tool_use_id.
					//
					// This avoids executing an invalid tool_use block and prevents duplicate/fragmented
					// error reporting.
					if (!block.partial) {
						const customTool = stateExperiments?.customTools
							? customToolRegistry.get(block.name)
							: undefined
						const isKnownTool = isValidToolName(String(block.name), stateExperiments)
						if (isKnownTool && !block.nativeArgs && !customTool) {
							const errorMessage =
								`Invalid tool call for '${block.name}': missing nativeArgs. ` +
								`This usually means the model streamed invalid or incomplete arguments and the call could not be finalized.`

							cline.consecutiveMistakeCount++
							try {
								cline.recordToolError(block.name as ToolName, errorMessage)
							} catch {
								// Best-effort only
							}

							// Push tool_result directly without setting didAlreadyUseTool so streaming can
							// continue gracefully.
							cline.pushToolResultToUserContent({
								type: "tool_result",
								tool_use_id: sanitizeToolUseId(toolCallId),
								content: formatResponse.toolError(errorMessage),
								is_error: true,
							})

							break
						}
					}

					// Store approval feedback to merge into tool result (GitHub #10465)
					let approvalFeedback: { text: string; images?: string[] } | undefined

					const pushToolResult = (content: ToolResponse) => {
						// Native tool calling: only allow ONE tool_result per tool call
						if (hasToolResult) {
							logger.warn(
								"PresentAssistantMessage",
								`[presentAssistantMessage] Skipping duplicate tool_result for tool_use_id: ${toolCallId}`,
							)
							return
						}

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

						// Merge approval feedback into tool result (GitHub #10465)
						if (approvalFeedback) {
							const feedbackText = formatResponse.toolApprovedWithFeedback(approvalFeedback.text)
							resultContent = `${feedbackText}\n\n${resultContent}`
							if (approvalFeedback.images) {
								const feedbackImageBlocks = formatResponse.imageBlocks(approvalFeedback.images)
								imageBlocks = [...feedbackImageBlocks, ...imageBlocks]
							}
						}

						resultContent = applyToolResultTokenBudget(cline, resultContent)

						cline.pushToolResultToUserContent({
							type: "tool_result",
							tool_use_id: sanitizeToolUseId(toolCallId),
							content: resultContent,
						})

						if (imageBlocks.length > 0) {
							cline.userMessageContent.push(...imageBlocks)
						}

						hasToolResult = true
					}

					const askApproval = async (
						type: ClineAsk,
						partialMessage?: string,
						progressStatus?: ToolProgressStatus,
						isProtected?: boolean,
					) => {
						const { response, text, images } = await cline.ask(
							type,
							partialMessage,
							false,
							progressStatus,
							isProtected || false,
						)

						if (response !== "yesButtonClicked") {
							// Handle both messageResponse and noButtonClicked with text.
							if (text) {
								await cline.say("user_feedback", text, images)
								pushToolResult(
									formatResponse.toolResult(formatResponse.toolDeniedWithFeedback(text), images),
								)
							} else {
								pushToolResult(formatResponse.toolDenied())
							}
							cline.didRejectTool = true
							return false
						}

						// Store approval feedback to be merged into tool result (GitHub #10465)
						// Don't push it as a separate tool_result here - that would create duplicates.
						// The tool will call pushToolResult, which will merge the feedback into the actual result.
						if (text) {
							await cline.say("user_feedback", text, images)
							approvalFeedback = { text, images }
						}
						cline.forceTaskState(TaskState.PROCESSING_TOOLS)

						return true
					}

					const askFinishSubTaskApproval = async () => {
						// Ask the user to approve this task has completed, and he has
						// reviewed it, and we can declare task is finished and return
						// control to the parent task to continue running the rest of
						// the sub-tasks.
						const toolMessage = JSON.stringify({ tool: "finishTask" })
						return await askApproval("tool", toolMessage)
					}

					const handleError = async (action: string, error: Error) => {
						// Silently ignore AskIgnoredError - this is an internal control flow
						// signal, not an actual error. It occurs when a newer ask supersedes an older one.
						if (error instanceof AskIgnoredError) {
							return
						}
						const errorString = `Error ${action}: ${JSON.stringify(serializeError(error))}`

						await cline.say("error", `Error ${action}:\n${getErrorMessage(error)}`)

						pushToolResult(formatResponse.toolError(errorString))
					}
					const reportProgress: ToolCallbacks["reportProgress"] = async (status) => {
						await cline
							.ask("tool", JSON.stringify({ tool: "progress", text: status?.text }), true, status)
							.catch(() => undefined)
					}

					if (!block.partial) {
						// Check if this is a custom tool - if so, record as "custom_tool" (like MCP tools)
						const isCustomTool = stateExperiments?.customTools && customToolRegistry.has(block.name)
						const recordName = isCustomTool ? "custom_tool" : block.name
						cline.recordToolUsage(recordName)

						// Track legacy format usage for read_file tool (for migration monitoring)
						if (block.name === "read_file" && block.usedLegacyFormat) {
							cline.api.getModel()
							// Legacy format tracking removed
						}
					}

					// Validate tool use before execution - ONLY for complete (non-partial) blocks.
					// Validating partial blocks would cause validation errors to be thrown repeatedly
					// during streaming, pushing multiple tool_results for the same tool_use_id and
					// potentially causing the stream to appear frozen.
					if (!block.partial) {
						const modelInfo = cline.api.getModel()
						// Resolve aliases in includedTools before validation
						// e.g., "edit_file" should resolve to "apply_diff"
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
								stateExperiments,
								includedTools,
								allowedTools,
							)

							// Schema-level parameter validation (zod)
							if (!block.partial) {
								const merged = mergeToolParamsForValidation(block)
								const paramCheck = validateToolParams(block.name, merged)
								if (!paramCheck.valid) {
									throw new Error(paramCheck.error!)
								}
							}
						} catch (error) {
							cline.consecutiveMistakeCount++
							// For validation errors (UnsafeAny tool, tool not allowed for mode), we need to:
							// 1. Send a tool_result with the error (required for native tool calling)
							// 2. NOT set didAlreadyUseTool = true (the tool was never executed, just failed validation)
							// This prevents the stream from being interrupted with "Response interrupted by tool use result"
							// which would cause the extension to appear to hang
							const errorContent = formatResponse.toolError(getErrorMessage(error))
							// Push tool_result directly without setting didAlreadyUseTool
							cline.pushToolResultToUserContent({
								type: "tool_result",
								tool_use_id: sanitizeToolUseId(toolCallId),
								content: typeof errorContent === "string" ? errorContent : "(validation error)",
								is_error: true,
							})
							TelemetryService.reportError(error, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)

							break
						}
					}

					// Check for identical consecutive tool calls.
					if (!block.partial) {
						// Use the detector to check for repetition, passing the ToolUse
						// block directly.
						const repetitionCheck = cline.toolRepetitionDetector.check(block)

						// If execution is not allowed, notify user and break.
						if (!repetitionCheck.allowExecution && repetitionCheck.askUser) {
							// Handle repetition similar to mistake_limit_reached pattern.
							const { response, text, images } = await cline.ask(
								repetitionCheck.askUser.messageKey as ClineAsk,
								repetitionCheck.askUser.messageDetail.replace("{toolName}", block.name),
							)

							if (response === "messageResponse") {
								// Add user feedback to userContent.
								cline.userMessageContent.push(
									{
										type: "text" as const,
										text: `Tool repetition limit reached. User feedback: ${text}`,
									},
									...formatResponse.imageBlocks(images),
								)

								// Add user feedback to chat.
								await cline.say("user_feedback", text, images)
							}

							// Track tool repetition in telemetry via PostHog exception tracking and event.
							// Telemetry removed

							// Return tool result message about the repetition
							pushToolResult(
								formatResponse.toolError(
									`Tool call repetition limit reached for ${block.name}. Please try a different approach.`,
								),
							)
							break
						}
					}

					// ── Registry-based tool dispatch ──────────────────────────────
					// Replaces the previous 40-case switch-case with a dynamic lookup.
					// Special cases: attempt_completion needs extended callbacks.
					{
						const tool = toolRegistry.get(block.name)
						if (tool) {
							// Checkpoint save for write/mutating tools
							if (tool.requiresCheckpoint) {
								await checkpointSaveAndMark(cline)
							}

							// Build callbacks — attempt_completion needs extended callbacks
							let effectiveCallbacks: ToolCallbacks | AttemptCompletionCallbacks
							if (block.name === "attempt_completion") {
								effectiveCallbacks = {
									askApproval,
									handleError,
									pushToolResult,
									askFinishSubTaskApproval,
									toolDescription,
								} as AttemptCompletionCallbacks
							} else {
								effectiveCallbacks = {
									askApproval,
									handleError,
									pushToolResult,
									reportProgress,
									toolCallId: block.id,
								}
							}

							try {
								await tool.handle(cline, block as ToolUse, effectiveCallbacks)
							} catch (err) {
								// Tool execution threw after exhausting retries. Push an error
								// result so the API always gets a tool_result for every tool_use.
								logger.error(
									"PresentAssistantMessage",
									`[presentAssistantMessage] Tool ${block.name} failed after retries:`,
									getErrorMessage(err),
								)
								TelemetryService.reportError(err, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
								pushToolResult(
									formatResponse.toolError(`Tool ${block.name} failed: ${getErrorMessage(err)}`),
								)
							}
						} else {
							// Handle UnsafeAny/invalid tool names OR custom tools
							// This is critical for native tool calling where every tool_use MUST have a tool_result

							// CRITICAL: Don't process partial blocks for UnsafeAny tools - just let them stream in.
							if (!block.partial) {
								const customTool = stateExperiments?.customTools
									? customToolRegistry.get(block.name)
									: undefined

								if (customTool) {
									try {
										let customToolArgs

										if (customTool.parameters) {
											try {
												customToolArgs = customTool.parameters.parse(
													block.nativeArgs || block.params || {},
												)
											} catch (parseParamsError: unknown) {
												const message = `Custom tool "${block.name}" argument validation failed: ${getErrorMessage(parseParamsError)}`
												logger.error("PresentAssistantMessage", message)
												TelemetryService.reportError(
													parseParamsError,
													TelemetryEventName.ASSISTANT_MESSAGE_ERROR,
												)
												cline.consecutiveMistakeCount++
												await cline.say("error", message)
												pushToolResult(formatResponse.toolError(message))
											}
										}

										if (customToolArgs !== undefined || !customTool.parameters) {
											const result = await customTool.execute(customToolArgs, {
												mode: mode ?? defaultModeSlug,
												task: cline,
											})

											logger.info(
												"PresentAssistantMessage",
												`${customTool.name}.execute(): ${JSON.stringify(customToolArgs)} -> ${JSON.stringify(result)}`,
											)

											pushToolResult(result)
											cline.consecutiveMistakeCount = 0
										}
									} catch (executionError: unknown) {
										cline.consecutiveMistakeCount++
										cline.recordToolError("custom_tool", getErrorMessage(executionError))
										TelemetryService.reportError(
											executionError,
											TelemetryEventName.ASSISTANT_MESSAGE_ERROR,
										)
										await handleError(
											`executing custom tool "${block.name}"`,
											wrapAsError(executionError),
										)
									}
								} else {
									// Not a custom tool - handle as UnsafeAny tool error
									const errorMessage = `Unknown tool "${block.name}". This tool does not exist. Please use one of the available tools.`
									cline.consecutiveMistakeCount++
									cline.recordToolError(block.name as ToolName, errorMessage)
									await cline.say("error", t("tools:unknownToolError", { toolName: block.name }))
									cline.pushToolResultToUserContent({
										type: "tool_result",
										tool_use_id: sanitizeToolUseId(toolCallId),
										content: formatResponse.toolError(errorMessage),
										is_error: true,
									})
								}
							}
						}
					}

					break
				}
			}

			// ── Advance & loop control ────────────────────────────────────────────
			// When tool is rejected, iterator stream is interrupted and it waits
			// for `userMessageContentReady` to be true. Future calls to present will
			// skip execution since `didRejectTool` and iterate until `contentIndex` is
			// set to message length and it sets userMessageContentReady to true itself.
			if (!block.partial || cline.didRejectTool || cline.didAlreadyUseTool) {
				if (cline.currentStreamingContentIndex === cline.assistantMessageContent.length - 1) {
					cline.userMessageContentReady = true
				}

				// Single point of index advancement
				cline.currentStreamingContentIndex++

				if (cline.currentStreamingContentIndex < cline.assistantMessageContent.length) {
					continue // process next block in loop
				} else {
					markUserContentReadyIfDrained(cline)
					break // nothing more to process → exit loop
				}
			}

			// Block is still partial. If pending updates arrived while we were
			// processing, loop again; otherwise exit and wait for the next call.
			if (cline.presentAssistantMessageHasPendingUpdates) {
				cline.presentAssistantMessageHasPendingUpdates = false
				continue
			}

			break // no more work — exit loop
		} // end while(true)

		// ── Unlock ─────────────────────────────────────────────────────────────
		const _lockHeldMs = performance.now() - _lockAcquiredAt
		if (_lockHeldMs > 5_000) {
			logger.warn(
				"PresentAssistantMessage",
				`[presentAssistantMessage] Lock held for ${_lockHeldMs.toFixed(0)}ms ` +
					`(task=${cline.taskId}, blockIndex=${cline.currentStreamingContentIndex})`,
			)
		}
	} finally {
		cline.presentAssistantMessageLocked = false
	}
}

/**
 * save checkpoint and mark done in the current streaming task.
 * @param task The Task instance to checkpoint save and mark.
 * @returns
 */
async function checkpointSaveAndMark(task: Task) {
	if (task.currentStreamingDidCheckpoint) {
		return
	}
	try {
		await task.checkpointSave(true)
		task.currentStreamingDidCheckpoint = true
	} catch (error) {
		logger.error(
			"PresentAssistantMessage",
			`[Task#presentAssistantMessage] Error saving checkpoint: ${error instanceof Error ? getErrorMessage(error) : String(error)}`,
			error,
		)
		TelemetryService.reportError(error, TelemetryEventName.ASSISTANT_MESSAGE_ERROR)
	}
}
