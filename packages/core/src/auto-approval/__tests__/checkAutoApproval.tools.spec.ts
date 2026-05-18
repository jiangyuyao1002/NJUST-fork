import { describe, expect, it } from "vitest"

import { checkAutoApproval } from "../index.js"
import { isReadOnlyToolAction } from "../tools.js"

const baseState = (patch: Record<string, unknown> = {}) => ({
	autoApprovalEnabled: true,
	...patch,
})

describe("isReadOnlyToolAction", () => {
	it("treats web, LSP and command output tools as read-only", () => {
		expect(
			isReadOnlyToolAction({
				tool: "readCommandOutput",
			}),
		).toBe(true)
		expect(
			isReadOnlyToolAction({
				tool: "web_search",
			}),
		).toBe(true)
		expect(
			isReadOnlyToolAction({
				tool: "web_fetch",
			}),
		).toBe(true)
		expect(
			isReadOnlyToolAction({
				tool: "lsp",
			}),
		).toBe(true)
	})
})

describe("checkAutoApproval tool routing", () => {
	it("approves read-only inspection tools when 读取 is allowed", async () => {
		const state = baseState({ alwaysAllowReadOnly: true })
		for (const t of ["readCommandOutput", "web_search", "web_fetch", "lsp"] as const) {
			await expect(
				checkAutoApproval({
					state,
					ask: "tool",
					text: JSON.stringify({ tool: t }),
				}),
			).resolves.toEqual({ decision: "approve" })
		}
	})

	it("asks outside-workspace read when 读取 outside is off", async () => {
		const state = baseState({
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: false,
		})
		const r = await checkAutoApproval({
			state,
			ask: "tool",
			text: JSON.stringify({ tool: "web_search", isOutsideWorkspace: true }),
		})
		expect(r).toEqual({ decision: "ask" })
	})

	it("approves send_message and agent when 子任务 is allowed", async () => {
		const state = baseState({ alwaysAllowSubtasks: true })
		for (const t of ["send_message", "agent"] as const) {
			await expect(
				checkAutoApproval({
					state,
					ask: "tool",
					text: JSON.stringify({ tool: t }),
				}),
			).resolves.toEqual({ decision: "approve" })
		}
	})
})
