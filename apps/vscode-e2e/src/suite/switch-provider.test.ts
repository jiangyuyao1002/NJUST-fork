import * as assert from "assert"

import { NJUST_AIEventName, type ClineMessage } from "@njust-ai/types"

import { waitFor } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("NJUST_AI Provider Switch Flow", function () {
	setDefaultSuiteTimeout(this)

	test("(b) Switch provider and continue conversation normally", async () => {
		const api = globalThis.api
		const messages: ClineMessage[] = []
		let taskCompleted = false

		const messageHandler = ({ message }: { message: ClineMessage }) => {
			messages.push(message)
		}
		api.on(NJUST_AIEventName.Message, messageHandler)

		const taskCompletedHandler = (id: string) => {
			if (id === taskId) {
				taskCompleted = true
			}
		}
		api.on(NJUST_AIEventName.TaskCompleted, taskCompletedHandler)

		let taskId: string
		try {
			// Phase 1: Start a conversation with the current provider
			taskId = await api.startNewTask({
				configuration: {
					mode: "ask",
					autoApprovalEnabled: true,
				},
				text: "Say 'Hello from first provider' exactly.",
			})

			await waitFor(() => taskCompleted, { timeout: 60_000 })
			const firstResponse = messages.find(
				(m) => m.type === "say" && (m.say === "text" || m.say === "completion_result"),
			)
			assert.ok(firstResponse, "Should get a response from the first provider")

			// Phase 2: Switch provider via API configuration change
			await api.setConfiguration({
				apiProvider: "openrouter",
				openRouterModelId: "openai/gpt-4o-mini",
			})

			// Phase 3: Start a new task with the new provider
			messages.length = 0
			taskCompleted = false

			taskId = await api.startNewTask({
				configuration: {
					mode: "ask",
					autoApprovalEnabled: true,
				},
				text: "Say 'Hello from switched provider' exactly.",
			})

			await waitFor(() => taskCompleted, { timeout: 60_000 })
			const secondResponse = messages.find(
				(m) => m.type === "say" && (m.say === "text" || m.say === "completion_result"),
			)
			assert.ok(secondResponse, "Should get a response after provider switch")
			assert.ok(
				secondResponse.text?.toLowerCase().includes("switched provider") ||
					secondResponse.text?.toLowerCase().includes("hello"),
				"New provider should produce a valid response",
			)
		} finally {
			api.off(NJUST_AIEventName.Message, messageHandler)
			api.off(NJUST_AIEventName.TaskCompleted, taskCompletedHandler)
		}
	})
})
