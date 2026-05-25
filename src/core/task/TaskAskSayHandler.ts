/**
 * TaskAskSayHandler — Ask/say operation handling.
 *
 * Extracted from Task.ts to decompose the monolithic file. Handles all ask()
 * and say() operations including auto-approval, message queuing, and response
 * processing.
 *
 * Phase 1: Extract ask/say logic from Task.ts
 * Phase 2 (future): Move webview response handling here once host surface is reduced
 */
import type { ClineAsk, ClineAskResponse, ClineSay, ToolProgressStatus, ContextCondense, ContextTruncation, ToolName } from "@njust-ai-cj/types"
import {
	isInteractiveAsk,
	isIdleAsk,
	isResumableAsk,
} from "@njust-ai-cj/types"
import { findLastIndex } from "../../shared/array"
import { formatResponse } from "../../core/prompts/responses"
import { NJUST_AI_CJEventName, TelemetryEventName } from "@njust-ai-cj/types"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import type { TaskAskSayHost } from "./interfaces/TaskAskSayHost"
import { logger } from "../../shared/logger"
import pWaitFor from "p-wait-for"
import { AskIgnoredError } from "./AskIgnoredError"
import { TaskAbortedError } from "./TaskErrors"
import { checkAutoApproval } from "../auto-approval"

export class TaskAskSayHandler {
	constructor(private host: TaskAskSayHost) {}

	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		if (this.host.abort) {
			throw new TaskAbortedError(this.host.taskId, this.host.instanceId)
		}

		let askTs: number

		if (partial !== undefined) {
			const lastMessage = this.host.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					void this.host.updateClineMessage(lastMessage)
					throw new AskIgnoredError("updating existing partial")
				} else {
					askTs = Date.now()
					this.host.lastMessageTs = askTs
					await this.host.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial, isProtected })
					throw new AskIgnoredError("new partial")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					this.host.askResponse = undefined
					this.host.askResponseText = undefined
					this.host.askResponseImages = undefined
					askTs = lastMessage.ts
					this.host.lastMessageTs = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					await this.host.saveClineMessages()
					void this.host.updateClineMessage(lastMessage)
				} else {
					this.host.askResponse = undefined
					this.host.askResponseText = undefined
					this.host.askResponseImages = undefined
					askTs = Date.now()
					this.host.lastMessageTs = askTs
					await this.host.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
				}
			}
		} else {
			this.host.askResponse = undefined
			this.host.askResponseText = undefined
			this.host.askResponseImages = undefined
			askTs = Date.now()
			this.host.lastMessageTs = askTs
			await this.host.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
		}

		const timeouts: NodeJS.Timeout[] = []

		const provider = this.host.hostRef.deref()
		const state = provider ? await provider.getState() : undefined
		const approval = await checkAutoApproval({ state, ask: type, text, isProtected })

		if (approval.decision === "approve") {
			this.host.approveAsk()
		} else if (approval.decision === "deny") {
			this.host.denyAsk()
		} else if (approval.decision === "timeout") {
			this.host.autoApprovalTimeoutRef = setTimeout(() => {
				const { askResponse, text, images } = approval.fn!()
				this.host.handleWebviewAskResponse(askResponse, text, images)
				this.host.autoApprovalTimeoutRef = undefined
			}, approval.timeout) as NodeJS.Timeout
			timeouts.push(this.host.autoApprovalTimeoutRef)
		}

		const isBlocking = !(this.host.askResponse !== undefined || this.host.lastMessageTs !== askTs)
		const isMessageQueued = !this.host.messageQueueService.isEmpty()
		const shouldDrainQueuedMessageForAsk = type !== "command_output" && !isIdleAsk(type)
		const isStatusMutable = !partial && isBlocking && !isMessageQueued && approval.decision === "ask"

		if (isStatusMutable) {
			const statusMutationTimeout = 2_000

			if (isInteractiveAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.host.findMessageByTimestamp(askTs)
						if (message) {
							this.host.interactiveAsk = message
							this.host.emit(NJUST_AI_CJEventName.TaskInteractive, this.host.taskId)
							provider?.postMessageToWebview({ type: "interactionRequired" })
						}
					}, statusMutationTimeout),
				)
			} else if (isResumableAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.host.findMessageByTimestamp(askTs)
						if (message) {
							this.host.resumableAsk = message
							this.host.emit(NJUST_AI_CJEventName.TaskResumable, this.host.taskId)
						}
					}, statusMutationTimeout),
				)
			} else if (isIdleAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.host.findMessageByTimestamp(askTs)
						if (message) {
							this.host.idleAsk = message
							this.host.emit(NJUST_AI_CJEventName.TaskIdle, this.host.taskId)
						}
					}, statusMutationTimeout),
				)
			}
		} else if (isMessageQueued && shouldDrainQueuedMessageForAsk) {
			const message = this.host.messageQueueService.dequeueMessage()
			if (message) {
				if (type === "tool" || type === "command" || type === "use_mcp_server") {
					this.host.handleWebviewAskResponse("yesButtonClicked", message.text, message.images)
				} else {
					this.host.handleWebviewAskResponse("messageResponse", message.text, message.images)
				}
			}
		}

		await pWaitFor(
			() => {
				if (this.host.askResponse !== undefined || this.host.lastMessageTs !== askTs) {
					return true
				}
				if (shouldDrainQueuedMessageForAsk && !this.host.messageQueueService.isEmpty()) {
					const message = this.host.messageQueueService.dequeueMessage()
					if (message) {
						if (type === "tool" || type === "command" || type === "use_mcp_server") {
							this.host.handleWebviewAskResponse("yesButtonClicked", message.text, message.images)
						} else {
							this.host.handleWebviewAskResponse("messageResponse", message.text, message.images)
						}
					}
				}
				return false
			},
			{ interval: 100 },
		)

		if (this.host.lastMessageTs !== askTs) {
			throw new AskIgnoredError("superseded")
		}

		const result = {
			response: this.host.askResponse!,
			text: this.host.askResponseText,
			images: this.host.askResponseImages,
		}
		this.host.askResponse = undefined
		this.host.askResponseText = undefined
		this.host.askResponseImages = undefined

		timeouts.forEach((timeout) => clearTimeout(timeout))

		if (this.host.idleAsk || this.host.resumableAsk || this.host.interactiveAsk) {
			this.host.idleAsk = undefined
			this.host.resumableAsk = undefined
			this.host.interactiveAsk = undefined
			this.host.emit(NJUST_AI_CJEventName.TaskActive, this.host.taskId)
		}

		this.host.emit(NJUST_AI_CJEventName.TaskAskResponded)
		return result
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		this.host.cancelAutoApprovalTimeout()

		this.host.askResponse = askResponse
		this.host.askResponseText = text
		this.host.askResponseImages = images

		if (askResponse === "messageResponse") {
			void this.host.checkpointSave(false, true)
		}

		if (askResponse === "messageResponse" || askResponse === "yesButtonClicked") {
			const lastFollowUpIndex = findLastIndex(
				this.host.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "followup" && !msg.isAnswered,
			)
			if (lastFollowUpIndex !== -1) {
				this.host.clineMessages[lastFollowUpIndex]!.isAnswered = true
				this.host.saveClineMessages().catch((error) => {
					logger.error("TaskAskSayHandler", "Failed to save answered follow-up state:", error)
					TelemetryService.reportError(error, TelemetryEventName.TASK_LIFECYCLE_ERROR)
				})
			}
		}

		if (askResponse === "yesButtonClicked") {
			const lastToolAskIndex = findLastIndex(
				this.host.clineMessages,
				(msg) => msg.type === "ask" && msg.ask === "tool" && !msg.isAnswered,
			)
			if (lastToolAskIndex !== -1) {
				this.host.clineMessages[lastToolAskIndex]!.isAnswered = true
				void this.host.updateClineMessage(this.host.clineMessages[lastToolAskIndex]!)
				this.host.saveClineMessages().catch((error) => {
					logger.error("TaskAskSayHandler", "Failed to save answered tool-ask state:", error)
					TelemetryService.reportError(error, TelemetryEventName.TASK_LIFECYCLE_ERROR)
				})
			}
		}
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, UnsafeAny>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined> {
		if (this.host.abort) {
			throw new TaskAbortedError(this.host.taskId, this.host.instanceId)
		}

		if (partial !== undefined) {
			const lastMessage = this.host.clineMessages.at(-1)
			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					void this.host.updateClineMessage(lastMessage)
				} else {
					const sayTs = Date.now()
					if (!options.isNonInteractive) {
						this.host.lastMessageTs = sayTs
					}
					await this.host.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
						contextTruncation,
					})
				}
			} else {
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.host.lastMessageTs = lastMessage.ts
					}
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					await this.host.saveClineMessages()
					void this.host.updateClineMessage(lastMessage)
				} else {
					const sayTs = Date.now()
					if (!options.isNonInteractive) {
						this.host.lastMessageTs = sayTs
					}
					await this.host.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						contextCondense,
						contextTruncation,
					})
				}
			}
		} else {
			const sayTs = Date.now()
			if (!options.isNonInteractive) {
				this.host.lastMessageTs = sayTs
			}
			await this.host.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
				contextTruncation,
			})
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Roo tried to use ${toolName}${relPath ? ` for '${relPath.toPosix()}'` : ""} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}
}
