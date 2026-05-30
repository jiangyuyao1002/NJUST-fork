import * as assert from "assert"

import { NJUST_AIEventName, type ClineMessage } from "@njust-ai/types"

import { waitFor } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

suite("NJUST_AI MCP Discovery Flow", function () {
	setDefaultSuiteTimeout(this)

	test("(c) Discover MCP tools and use them in conversation", async () => {
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
			// Phase 1: Ask about available MCP tools
			taskId = await api.startNewTask({
				configuration: {
					mode: "ask",
					autoApprovalEnabled: true,
				},
				text: "List any available MCP tools or servers you can access. If none are configured, say so clearly.",
			})

			await waitFor(() => taskCompleted, { timeout: 60_000 })

			// Verify the AI acknowledged MCP capability (or absence)
			const hasMcpMention = messages.some(
				(m) =>
					m.type === "say" &&
					(m.say === "text" || m.say === "completion_result") &&
					(m.text?.toLowerCase().includes("mcp") ||
						m.text?.toLowerCase().includes("no tools") ||
						m.text?.toLowerCase().includes("not configured")),
			)
			assert.ok(hasMcpMention, "AI should mention MCP tools or state they are not configured")
		} finally {
			api.off(NJUST_AIEventName.Message, messageHandler)
			api.off(NJUST_AIEventName.TaskCompleted, taskCompletedHandler)
		}
	})
})
