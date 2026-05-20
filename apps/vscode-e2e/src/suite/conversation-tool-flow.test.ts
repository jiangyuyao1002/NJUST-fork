import * as assert from "assert"

import { NJUST_AI_CJEventName, type ClineMessage } from "@njust-ai-cj/types"

import { waitFor } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("NJUST_AI_CJ Conversation Tool Flow", function () {
	setDefaultSuiteTimeout(this)

	test("(a) Complete conversation with tool call and continued dialogue", async () => {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let toolCalled = false
		let toolResultShown = false
		let taskCompleted = false

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)

			if (message.type === "ask" && message.ask === "tool") {
				toolCalled = true
			}

			if (message.type === "say" && message.say === "tool") {
				toolResultShown = true
			}
		}
		api.on(NJUST_AI_CJEventName.Message, messageHandler)

		const taskCompletedHandler = (id: string) => {
			if (id === taskId) {
				taskCompleted = true
			}
		}
		api.on(NJUST_AI_CJEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Phase 1: Start a task that should trigger a tool call
			taskId = await api.startNewTask({
				configuration: {
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
				},
				text: "What files are in the current workspace directory? Use list_files to find out, then tell me the result.",
			})

			// Wait for tool call
			await waitFor(() => toolCalled, { timeout: 60_000 })
			assert.ok(toolCalled, "AI should have called a tool (list_files)")

			// Wait for tool result to be shown
			await waitFor(() => toolResultShown, { timeout: 30_000 })
			assert.ok(toolResultShown, "Tool result should be displayed")

			// Wait for task completion
			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI continued the dialogue after tool result
			const hasFollowUp = messages.some(
				(m) =>
					m.type === "say" &&
					(m.say === "text" || m.say === "completion_result") &&
					m.text && m.text.length > 10,
			)
			assert.ok(hasFollowUp, "AI should continue conversation after tool result")
		} finally {
			api.off(NJUST_AI_CJEventName.Message, messageHandler)
			api.off(NJUST_AI_CJEventName.TaskCompleted, taskCompletedHandler)
		}
	})
})
