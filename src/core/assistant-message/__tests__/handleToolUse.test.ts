import { describe, it, expect, vi } from "vitest"

vi.mock("serialize-error", () => ({ serializeError: vi.fn((e) => ({ message: e.message, name: e.name })) }))
vi.mock("../../shared/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((s) => s),
		toolDenied: vi.fn(() => "tool_denied"),
		toolDeniedWithFeedback: vi.fn((t) => t),
		toolResult: vi.fn((r) => r),
		toolApprovedWithFeedback: vi.fn((t) => t),
		imageBlocks: vi.fn((i) => i?.map(() => ({})) ?? []),
	},
}))
vi.mock("../../utils/tool-id", () => ({ sanitizeToolUseId: vi.fn((id) => id) }))
vi.mock("../../i18n", () => ({ t: vi.fn((k) => k) }))
vi.mock("../../shared/modes", () => ({ defaultModeSlug: "code" }))
vi.mock("../../task/TaskStateMachine", () => ({
	TaskState: { WAITING_APPROVAL: "waiting", PROCESSING_TOOLS: "processing" },
}))
vi.mock("../../task/AskIgnoredError", () => ({ AskIgnoredError: class extends Error {} }))
vi.mock("../../tools/ToolRegistry", () => ({ toolRegistry: { get: vi.fn() } }))
vi.mock("../../tools/validateToolUse", () => ({ isValidToolName: vi.fn(() => true) }))
vi.mock("@njust-ai/telemetry", () => ({ TelemetryService: { reportError: vi.fn() } }))
vi.mock("@njust-ai/core", () => ({ customToolRegistry: { get: vi.fn(), has: vi.fn(() => false) } }))
vi.mock("../toolUseHelpers", () => ({
	applyToolResultTokenBudget: vi.fn((_c, s) => s),
	buildToolDescription: vi.fn(() => "[test_tool]"),
	validateToolUseBlock: vi.fn().mockResolvedValue(true),
	checkToolRepetition: vi.fn().mockResolvedValue(true),
	tryEagerBatch: vi.fn().mockResolvedValue(false),
}))

const { handleToolUseBlock } = await import("../handleToolUse")
const mocks = {
	toolRegistry: (await import("../../tools/ToolRegistry")).toolRegistry,
	isValidToolName: (await import("../../tools/validateToolUse")).isValidToolName,
	validateToolUseBlock: (await import("../toolUseHelpers")).validateToolUseBlock,
	tryEagerBatch: (await import("../toolUseHelpers")).tryEagerBatch,
	checkToolRepetition: (await import("../toolUseHelpers")).checkToolRepetition,
	AskIgnoredError: (await import("../../task/AskIgnoredError")).AskIgnoredError,
	TelemetryService: (await import("@njust-ai/telemetry")).TelemetryService,
	customToolRegistry: (await import("@njust-ai/core")).customToolRegistry,
}

function mkTask(o: any = {}) {
	return {
		taskId: "t1",
		didRejectTool: false,
		didAlreadyUseTool: false,
		consecutiveMistakeCount: 0,
		currentStreamingDidCheckpoint: false,
		userMessageContent: [] as any[],
		allowedTools: undefined,
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "" }),
		pushToolResultToUserContent: vi.fn().mockReturnValue(true),
		forceTaskState: vi.fn(),
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		checkpointSave: vi.fn().mockResolvedValue(undefined),
		providerRef: { deref: () => ({ getState: vi.fn().mockResolvedValue({ mode: "code", customModes: [] }) }) },
		api: { getModel: vi.fn(() => ({ id: "test" })) },
		...o,
	}
}

function mkBlock(o: any = {}) {
	return { type: "tool_use", id: "b1", name: "read_file", params: {}, partial: false, nativeArgs: {}, ...o }
}

describe("handleToolUseBlock", () => {
	it("returns continue when tryEagerBatch returns true", async () => {
		vi.mocked(mocks.tryEagerBatch).mockResolvedValueOnce(true)
		expect(await handleToolUseBlock(mkTask(), mkBlock())).toBe("continue")
	})

	it("returns break for missing tool_use_id", async () => {
		const task = mkTask()
		const result = await handleToolUseBlock(task, { ...mkBlock(), id: undefined } as any)
		expect(result).toBe("break")
		expect(task.didAlreadyUseTool).toBe(true)
	})

	it("returns break when didRejectTool is true", async () => {
		expect(await handleToolUseBlock(mkTask({ didRejectTool: true }), mkBlock())).toBe("break")
	})

	it("returns break when tool result already exists", async () => {
		const task = mkTask({ userMessageContent: [{ type: "tool_result", tool_use_id: "b1" }] })
		expect(await handleToolUseBlock(task, mkBlock())).toBe("break")
	})

	it("returns break for known tool without nativeArgs", async () => {
		const task = mkTask()
		const result = await handleToolUseBlock(task, mkBlock({ nativeArgs: undefined }))
		expect(result).toBe("break")
	})

	it("returns break when validateToolUseBlock returns false", async () => {
		vi.mocked(mocks.validateToolUseBlock).mockResolvedValueOnce(false)
		expect(await handleToolUseBlock(mkTask(), mkBlock())).toBe("break")
	})

	it("returns break when checkToolRepetition returns false", async () => {
		vi.mocked(mocks.checkToolRepetition).mockResolvedValueOnce(false)
		expect(await handleToolUseBlock(mkTask(), mkBlock())).toBe("break")
	})

	it("dispatches to toolRegistry handle", async () => {
		const h = vi.fn().mockResolvedValue(undefined)
		vi.mocked(mocks.toolRegistry.get).mockReturnValue({ handle: h })
		await handleToolUseBlock(mkTask(), mkBlock())
		expect(mocks.toolRegistry.get).toHaveBeenCalledWith("read_file")
		expect(h).toHaveBeenCalledTimes(1)
	})

	it("saves checkpoint for tools that require it", async () => {
		const h = vi.fn().mockResolvedValue(undefined)
		vi.mocked(mocks.toolRegistry.get).mockReturnValue({ handle: h, requiresCheckpoint: true })
		const task = mkTask()
		await handleToolUseBlock(task, mkBlock())
		expect(task.checkpointSave).toHaveBeenCalledWith(true)
	})

	it("reports errors when tool execution throws", async () => {
		vi.mocked(mocks.toolRegistry.get).mockReturnValue({ handle: vi.fn().mockRejectedValue(new Error("crash")) })
		await handleToolUseBlock(mkTask(), mkBlock())
		expect(mocks.TelemetryService.reportError).toHaveBeenCalled()
	})

	it("handleError swallows AskIgnoredError", async () => {
		const h = vi
			.fn()
			.mockImplementation(async (_t, _b, cb: any) => cb.handleError("x", new mocks.AskIgnoredError("ok")))
		vi.mocked(mocks.toolRegistry.get).mockReturnValue({ handle: h })
		const task = mkTask()
		await handleToolUseBlock(task, mkBlock())
		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
	})
})
