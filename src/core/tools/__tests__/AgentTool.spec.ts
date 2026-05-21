import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AgentTool } from "../AgentTool"

function createCallbacks() {
	return {
		askApproval: vi.fn().mockResolvedValue(true),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
	}
}

function createTask(overrides: Record<string, unknown> = {}) {
	const host = {
		getTaskStackSize: vi.fn().mockReturnValue(1),
		delegateParentAndOpenChild: vi.fn().mockResolvedValue({ taskCompleted: true }),
	}
	return {
		taskId: "parent-1",
		consecutiveMistakeCount: 0,
		recordToolError: vi.fn(),
		didToolFailInCurrentTurn: false,
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing task"),
		providerRef: { deref: () => host },
		getTaskMode: vi.fn().mockResolvedValue("code"),
		getBackgroundSignal: vi.fn().mockReturnValue(new Promise(() => undefined)),
		ask: vi.fn().mockResolvedValue(true),
		host,
		...overrides,
	} as any
}

describe("AgentTool", () => {
	let tool: AgentTool

	beforeEach(() => {
		tool = new AgentTool()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllTimers()
	})

	it("exposes agent metadata", () => {
		expect(tool.userFacingName()).toBe("Agent")
		expect(tool.searchHint).toContain("sub-agent")
	})

	it("reports lost provider reference", async () => {
		const task = createTask({ providerRef: { deref: () => undefined } })
		const callbacks = createCallbacks()

		await tool.execute({ task: "inspect" }, task, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Provider reference lost"))
	})

	it("enforces the concurrent sub-agent limit", async () => {
		const task = createTask()
		task.host.getTaskStackSize.mockReturnValue(4)
		const callbacks = createCallbacks()

		await tool.execute({ task: "inspect" }, task, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("concurrent agent limit reached"))
		expect(task.host.delegateParentAndOpenChild).not.toHaveBeenCalled()
	})

	it("does not spawn when approval is denied", async () => {
		const task = createTask()
		const callbacks = createCallbacks()
		callbacks.askApproval.mockResolvedValueOnce(false)

		await tool.execute({ task: "inspect", agentType: "explore" }, task, callbacks as any)

		expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining('"agentType":"explore"'))
		expect(task.host.delegateParentAndOpenChild).not.toHaveBeenCalled()
	})

	it("spawns an approved explore sub-agent with forked isolation", async () => {
		vi.useFakeTimers()
		const task = createTask()
		const callbacks = createCallbacks()

		const run = tool.execute({ task: "inspect files", agentType: "explore", maxTurns: 3 }, task, callbacks as any)
		await vi.advanceTimersByTimeAsync(200)
		await run

		expect(task.host.delegateParentAndOpenChild).toHaveBeenCalledWith(
			expect.objectContaining({
				parentTaskId: "parent-1",
				mode: "code",
				isolationLevel: "forked",
				initialTodos: [],
				message: expect.stringContaining("[Sub-Agent Type: explore]"),
			}),
		)
		const message = task.host.delegateParentAndOpenChild.mock.calls[0][0].message as string
		expect(message).toContain("read_file, search_files")
		expect(message).toContain("maximum of 3 conversation turns")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Sub-agent (explore) completed with forked isolation.")
	})

	it("reports backgrounded sub-agents when the background signal wins", async () => {
		vi.useFakeTimers()
		const task = createTask({
			getBackgroundSignal: vi.fn().mockReturnValue(Promise.resolve()),
		})
		task.host.delegateParentAndOpenChild.mockResolvedValueOnce({ taskCompleted: false })
		const callbacks = createCallbacks()

		await tool.execute({ task: "long job", agentType: "verify" }, task, callbacks as any)

		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("spawned in background"))
		vi.clearAllTimers()
	})

	it("delegates spawn failures to handleError", async () => {
		const task = createTask()
		task.host.delegateParentAndOpenChild.mockRejectedValueOnce(new Error("spawn failed"))
		const callbacks = createCallbacks()

		await tool.execute({ task: "inspect" }, task, callbacks as any)

		expect(callbacks.handleError).toHaveBeenCalledWith("creating sub-agent", expect.objectContaining({ message: "spawn failed" }))
	})

	it("shows partial agent approval content", async () => {
		const task = createTask()

		await tool.handlePartial(task, {
			params: { task: "inspect files" },
			nativeArgs: { agentType: "verify" },
			partial: true,
		} as any)

		expect(task.ask).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({ tool: "agent", agentType: "verify", content: "inspect files" }),
			true,
		)
	})
})
