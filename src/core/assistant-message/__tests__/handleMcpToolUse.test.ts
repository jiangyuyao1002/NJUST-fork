import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("serialize-error", () => ({
	serializeError: vi.fn((e) => ({ message: e.message, name: e.name })),
}))
vi.mock("../../shared/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((s) => s),
		toolDenied: vi.fn(() => "tool_denied"),
		toolDeniedWithFeedback: vi.fn((text) => text),
		toolResult: vi.fn((r) => r),
		toolApprovedWithFeedback: vi.fn((t) => t),
		imageBlocks: vi.fn((imgs) => imgs.map(() => ({}))),
	},
}))
vi.mock("../../utils/tool-id", () => ({
	sanitizeToolUseId: vi.fn((id) => id),
}))
vi.mock("../../task/TaskStateMachine", () => ({
	TaskState: { WAITING_APPROVAL: "waiting_approval", PROCESSING_TOOLS: "processing_tools" },
}))
vi.mock("../../task/AskIgnoredError", () => ({
	AskIgnoredError: class AskIgnoredError extends Error {},
}))
vi.mock("../toolUseHelpers", () => ({
	applyToolResultTokenBudget: vi.fn((_cline, s) => s),
}))
vi.mock("../../tools/ToolRegistry", () => ({
	toolRegistry: {
		get: vi.fn(),
	},
}))

const { handleMcpToolUseBlock } = await import("../handleMcpToolUse")
const { toolRegistry } = await import("../../tools/ToolRegistry")
const { AskIgnoredError } = await import("../../task/AskIgnoredError")

function makeMockCline(overrides: Record<string, unknown> = {}) {
	const cline: any = {
		taskId: "test-task",
		didRejectTool: false,
		userMessageContent: [],
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
		pushToolResultToUserContent: vi.fn().mockReturnValue(true),
		forceTaskState: vi.fn(),
		recordToolUsage: vi.fn(),
		providerRef: { deref: () => ({ getMcpHub: vi.fn(() => null) }) },
		...overrides,
	}
	return cline
}

function makeMcpToolUse(overrides: Record<string, unknown> = {}): any {
	return {
		id: "mcp_123",
		name: "test_tool",
		serverName: "test-server",
		toolName: "test_action",
		arguments: { key: "val" },
		partial: false,
		...overrides,
	}
}

describe("handleMcpToolUseBlock", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("skips tool when didRejectTool is true (non-partial)", async () => {
		const cline = makeMockCline({ didRejectTool: true })
		await handleMcpToolUseBlock(cline, makeMcpToolUse())
		expect(cline.pushToolResultToUserContent).toHaveBeenCalledWith(expect.objectContaining({ is_error: true }))
	})

	it("pushes partial-specific message when partial is true and didRejectTool", async () => {
		const cline = makeMockCline({ didRejectTool: true })
		await handleMcpToolUseBlock(cline, makeMcpToolUse({ partial: true }))
		const callArgs = cline.pushToolResultToUserContent.mock.calls[0][0]
		expect(callArgs.content).toContain("interrupted")
	})

	it("records tool usage when block is not partial", async () => {
		const handleMock = vi.fn().mockResolvedValue(undefined)
		vi.mocked(toolRegistry.get).mockReturnValue({ handle: handleMock })
		const cline = makeMockCline()
		await handleMcpToolUseBlock(cline, makeMcpToolUse())
		expect(cline.recordToolUsage).toHaveBeenCalledWith("use_mcp_tool")
	})

	it("does not record tool usage when block is partial", async () => {
		const handleMock = vi.fn().mockResolvedValue(undefined)
		vi.mocked(toolRegistry.get).mockReturnValue({ handle: handleMock })
		const cline = makeMockCline()
		await handleMcpToolUseBlock(cline, makeMcpToolUse({ partial: true }))
		expect(cline.recordToolUsage).not.toHaveBeenCalled()
	})

	it("calls toolRegistry.get with use_mcp_tool and invokes handle", async () => {
		const handleMock = vi.fn().mockResolvedValue(undefined)
		vi.mocked(toolRegistry.get).mockReturnValue({ handle: handleMock })
		const cline = makeMockCline()
		await handleMcpToolUseBlock(cline, makeMcpToolUse())
		expect(toolRegistry.get).toHaveBeenCalledWith("use_mcp_tool")
		expect(handleMock).toHaveBeenCalledTimes(1)
		const syntheticTool = handleMock.mock.calls[0][1]
		expect(syntheticTool.name).toBe("use_mcp_tool")
		expect(syntheticTool.params.server_name).toBe("test-server")
	})

	it("prevents duplicate pushToolResult calls", async () => {
		const handleMock = vi.fn().mockImplementation(async (_c, _t, cb) => {
			cb.pushToolResult("result1")
			cb.pushToolResult("result2")
		})
		vi.mocked(toolRegistry.get).mockReturnValue({ handle: handleMock })
		const cline = makeMockCline()
		await handleMcpToolUseBlock(cline, makeMcpToolUse())
		expect(cline.pushToolResultToUserContent).toHaveBeenCalledTimes(1)
	})

	it("sets didRejectTool when user rejects approval", async () => {
		const cline = makeMockCline({
			ask: vi.fn().mockResolvedValue({ response: "no", text: "" }),
		})
		const handleMock = vi.fn().mockImplementation(async (_c, _t, cb) => {
			const approved = await cb.askApproval("tool")
			expect(approved).toBe(false)
		})
		vi.mocked(toolRegistry.get).mockReturnValue({ handle: handleMock })
		await handleMcpToolUseBlock(cline, makeMcpToolUse())
		expect(cline.didRejectTool).toBe(true)
	})

	it("includes approval feedback text in tool result", async () => {
		const cline = makeMockCline({
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "go ahead", images: [] }),
		})
		const handleMock = vi.fn().mockImplementation(async (_c, _t, cb) => {
			await cb.askApproval("tool")
			cb.pushToolResult("result")
		})
		vi.mocked(toolRegistry.get).mockReturnValue({ handle: handleMock })
		await handleMcpToolUseBlock(cline, makeMcpToolUse())
		const arg = cline.pushToolResultToUserContent.mock.calls[0][0]
		expect(arg.content).toContain("go ahead")
	})

	it("handleError swallows AskIgnoredError", async () => {
		const handleMock = vi.fn().mockImplementation(async (_c, _t, cb) => {
			cb.handleError("test", new AskIgnoredError("ignored"))
		})
		vi.mocked(toolRegistry.get).mockReturnValue({ handle: handleMock })
		const cline = makeMockCline()
		await handleMcpToolUseBlock(cline, makeMcpToolUse())
		expect(cline.say).not.toHaveBeenCalledWith("error", expect.anything())
	})

	it("handleError pushes error for regular errors", async () => {
		const handleMock = vi.fn().mockImplementation(async (_c, _t, cb) => {
			cb.handleError("test", new Error("bad"))
		})
		vi.mocked(toolRegistry.get).mockReturnValue({ handle: handleMock })
		const cline = makeMockCline()
		await handleMcpToolUseBlock(cline, makeMcpToolUse())
		expect(cline.say).toHaveBeenCalledWith("error", expect.stringContaining("bad"))
	})

	it("resolves original server name via mcpHub", async () => {
		const handleMock = vi.fn().mockResolvedValue(undefined)
		vi.mocked(toolRegistry.get).mockReturnValue({ handle: handleMock })
		const mcpHub = { findServerNameBySanitizedName: vi.fn().mockReturnValue("original-server") }
		const cline = makeMockCline({
			providerRef: { deref: () => ({ getMcpHub: vi.fn(() => mcpHub) }) },
		})
		await handleMcpToolUseBlock(cline, makeMcpToolUse())
		expect(handleMock.mock.calls[0][1].params.server_name).toBe("original-server")
	})
})
