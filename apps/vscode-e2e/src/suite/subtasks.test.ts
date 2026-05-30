import * as assert from "assert"

import { NJUST_AIEventName, type ClineMessage } from "@njust-ai/types"

import { sleep, waitFor } from "./utils"

suite("NJUST_AI Subtasks", () => {
	test("Should handle subtask cancellation and resumption correctly", async () => {
		const api = globalThis.api

		const messages: Record<string, ClineMessage[]> = {}
		const completedTaskIds = new Set<string>()
		const abortedTaskIds = new Set<string>()
		let sawNewTaskTool = false

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "ask" && message.ask === "tool" && typeof message.text === "string") {
				try {
					sawNewTaskTool = sawNewTaskTool || JSON.parse(message.text).tool === "newTask"
			} catch {
				// Intentionally ignore JSON parse errors for non-tool messages.
			}
			}
			if (message.type === "say" && message.partial === false) {
				messages[taskId] = messages[taskId] || []
				messages[taskId].push(message)
			}
		}
		const taskCompletedHandler = (taskId: string) => completedTaskIds.add(taskId)
		const taskAbortedHandler = (taskId: string) => abortedTaskIds.add(taskId)

		api.on(NJUST_AIEventName.Message, messageHandler)
		api.on(NJUST_AIEventName.TaskCompleted, taskCompletedHandler)
		api.on(NJUST_AIEventName.TaskAborted, taskAbortedHandler)

		const childPrompt = "You are a calculator. Respond only with numbers. What is the square root of 9?"

		// Start a parent task that will create a subtask.
		const parentTaskId = await api.startNewTask({
			configuration: {
				mode: "ask",
				alwaysAllowModeSwitch: true,
				alwaysAllowSubtasks: true,
				autoApprovalEnabled: true,
				enableCheckpoints: false,
			},
			text:
				"You are the parent task. " +
				`Create a subtask by using the new_task tool with the message '${childPrompt}'.` +
				"After creating the subtask, wait for it to complete and then respond 'Parent task resumed'.",
		})

		// Wait for the subtask to be spawned and then cancel it.
		try {
			await waitFor(() => sawNewTaskTool, { timeout: 30_000 })
			await sleep(5_000) // Give the child task a chance to open and populate the history.
			await api.cancelCurrentTask()

			// Wait a bit to ensure any task resumption would have happened.
			await sleep(2_000)

			// The parent task should not have resumed yet, so we shouldn't see
			// "Parent task resumed".
			assert.ok(
				messages[parentTaskId]?.find(({ type, text }) => type === "say" && text === "Parent task resumed") ===
					undefined,
				"Parent task should not have resumed after subtask cancellation",
			)

			// Start a new task with the same message as the subtask.
			const anotherTaskId = await api.startNewTask({ text: childPrompt })
			await waitFor(() => completedTaskIds.has(anotherTaskId), { timeout: 60_000 })

			// Wait a bit to ensure any task resumption would have happened.
			await sleep(2_000)

			// The parent task should still not have resumed.
			assert.ok(
				messages[parentTaskId]?.find(({ type, text }) => type === "say" && text === "Parent task resumed") ===
					undefined,
				"Parent task should not have resumed after subtask cancellation",
			)

			// Clean up - cancel all tasks.
			await api.clearCurrentTask()
			await waitFor(() => completedTaskIds.has(parentTaskId) || abortedTaskIds.has(parentTaskId), { timeout: 10_000 }).catch(
				() => undefined,
			)
		} finally {
			api.off(NJUST_AIEventName.Message, messageHandler)
			api.off(NJUST_AIEventName.TaskCompleted, taskCompletedHandler)
			api.off(NJUST_AIEventName.TaskAborted, taskAbortedHandler)
		}
	})
})
