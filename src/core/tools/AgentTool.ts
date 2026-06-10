import { z } from "zod"

import { Task } from "../task/Task"
import { ignoreAbortError } from "../../utils/errorHandling"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { SubAgentType, AGENT_TYPE_TOOLS } from "../task/SubTaskOptions"

/** Maximum number of concurrently active sub-agents. */
const MAX_CONCURRENT_AGENTS = 3

interface AgentToolParams {
	task: string
	agentType?: SubAgentType
	maxTurns?: number
}

export class AgentTool extends BaseTool<"agent"> {
	readonly name = "agent" as const

	override userFacingName(): string {
		return "Agent"
	}

	override get searchHint(): string {
		return "agent sub-agent spawn delegate fork"
	}

	protected override get inputSchema() {
		return z.object({
			task: z.string().min(1, "task is required"),
			agentType: z.enum(["explore", "implement", "verify", "custom"]).optional(),
			maxTurns: z.number().int().positive().optional(),
		})
	}

	async execute(params: AgentToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { task: taskDescription, agentType = "custom", maxTurns } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			const host = task.providerRef.deref()

			if (!host) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// Concurrency limit: count active children in the task stack
			const taskStackSize = host.getTaskStackSize()
			// The stack includes the current task, so active children = stackSize - 1
			// (each delegation pushes a child). We check against MAX_CONCURRENT_AGENTS.
			if (taskStackSize > MAX_CONCURRENT_AGENTS) {
				pushToolResult(
					formatResponse.toolError(
						`Cannot create sub-agent: concurrent agent limit reached (${MAX_CONCURRENT_AGENTS}). ` +
							`Wait for an existing sub-agent to complete before spawning a new one.`,
					),
				)
				return
			}

			task.consecutiveMistakeCount = 0

			// Build the agent message with context about its type and constraints
			const toolSetDescription =
				agentType !== "custom" ? AGENT_TYPE_TOOLS[agentType].join(", ") : "inherited from parent"
			const maxTurnsNote = maxTurns
				? `\n\nIMPORTANT: You have a maximum of ${maxTurns} conversation turns to complete this task. Be efficient and focused.`
				: ""

			const agentMessage = [
				`[Sub-Agent Type: ${agentType}]`,
				`[Available Tools: ${toolSetDescription}]`,
				``,
				taskDescription,
				maxTurnsNote,
			].join("\n")

			// Build approval message
			const toolMessage = JSON.stringify({
				tool: "agent",
				agentType,
				content: taskDescription,
				maxTurns: maxTurns ?? null,
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			// Delegate using forked isolation level for independent context
			const modeSlug = await task.getTaskMode()
			const child = await host.delegateParentAndOpenChild({
				parentTaskId: task.taskId,
				message: agentMessage,
				initialTodos: [],
				mode: modeSlug,
				isolationLevel: "forked",
			})

			// Race: child quick-completion vs user background request.
			// If background signal fires first, child continues asynchronously.
			const bgSignal = task.getBackgroundSignal()
			const childCompletion = new Promise<void>((resolve) => {
				let settled = false
				const timer = setInterval(() => {
					if (settled) return
					if (
						(child as Record<string, UnsafeAny>).taskCompleted ||
						(child as Record<string, UnsafeAny>).abort
					) {
						settled = true
						clearInterval(timer)
						resolve()
					}
				}, 200)
				setTimeout(() => {
					if (!settled) {
						settled = true
						clearInterval(timer)
						resolve()
					}
				}, 30_000)
			})

			const winner = await Promise.race([
				childCompletion.then(() => "completed"),
				bgSignal.then(() => "backgrounded"),
			])

			if (winner === "backgrounded") {
				pushToolResult(
					`Sub-agent (${agentType}) spawned in background. ` +
						`It will work independently and report when complete.`,
				)
			} else {
				pushToolResult(`Sub-agent (${agentType}) completed with forked isolation.`)
			}
			return
		} catch (error) {
			await handleError("creating sub-agent", error instanceof Error ? error : new Error(String(error)))
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"agent">): Promise<void> {
		const taskDesc: string | undefined = block.params.task
		// agentType is not in ToolParamName, read from nativeArgs
		const nativeArgs = block.nativeArgs as AgentToolParams | undefined
		const agentType: string | undefined = nativeArgs?.agentType

		const partialMessage = JSON.stringify({
			tool: "agent",
			agentType: agentType ?? "custom",
			content: taskDesc ?? "",
		})

		await task.ask("tool", partialMessage, block.partial).catch(ignoreAbortError)
	}
}

export const agentTool = new AgentTool()
