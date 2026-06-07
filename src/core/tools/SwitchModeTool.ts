import delay from "delay"
import * as vscode from "vscode"
import { z } from "zod"

import { Task } from "../task/Task"
import { ignoreAbortError } from "../../utils/errorHandling"
import { formatResponse } from "../prompts/responses"
import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

interface SwitchModeParams {
	mode_slug: string
	reason: string
}

export class SwitchModeTool extends BaseTool<"switch_mode"> {
	readonly name = "switch_mode" as const

	protected override get inputSchema() {
		return z.object({
			mode_slug: z.string().min(1, "mode_slug is required"),
			reason: z.string().optional(),
		})
	}

	async execute(params: SwitchModeParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode_slug, reason } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			task.consecutiveMistakeCount = 0

			// Verify the mode exists
			const targetMode = getModeBySlug(mode_slug, (await task.providerRef.deref()?.getState())?.customModes)

			if (!targetMode) {
				task.recordToolError("switch_mode")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(`Invalid mode: ${mode_slug}`))
				return
			}

			// Check if already in requested mode
			const currentMode = (await task.providerRef.deref()?.getState())?.mode ?? defaultModeSlug

			if (currentMode === mode_slug) {
				task.recordToolError("switch_mode")
				task.didToolFailInCurrentTurn = true
				pushToolResult(`Already in ${targetMode.name} mode.`)
				return
			}

			const completeMessage = JSON.stringify({ tool: "switchMode", mode: mode_slug, reason })
			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			// Switch the mode using shared handler
			await task.providerRef.deref()?.handleModeSwitch(mode_slug)

			if (currentMode === "cangjie" && mode_slug !== "cangjie") {
				const cjEditors = vscode.window.visibleTextEditors.filter((e) => e.document.fileName.endsWith(".cj"))
				if (cjEditors.length > 0) {
					void vscode.window.showInformationMessage(
						t("info.cangjie_mode_left_with_files", { count: cjEditors.length }),
					)
				}
			}

			pushToolResult(
				`Successfully switched from ${getModeBySlug(currentMode)?.name ?? currentMode} mode to ${
					targetMode.name
				} mode${reason ? ` because: ${reason}` : ""}.`,
			)

			await delay(500) // Delay to allow mode change to take effect before next tool is executed
		} catch (error) {
			await handleError("switching mode", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"switch_mode">): Promise<void> {
		const mode_slug: string | undefined = block.params.mode_slug
		const reason: string | undefined = block.params.reason

		const partialMessage = JSON.stringify({
			tool: "switchMode",
			mode: mode_slug ?? "",
			reason: reason ?? "",
		})

		await task.ask("tool", partialMessage, block.partial).catch(ignoreAbortError)
	}
}

export const switchModeTool = new SwitchModeTool()
