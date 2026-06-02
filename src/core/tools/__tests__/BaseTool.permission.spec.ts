import { describe, expect, it, vi } from "vitest"
import type { ToolUse } from "../../../shared/tools"
import { BaseTool, type ToolCallbacks } from "../BaseTool"

const { recordSecurityMetricMock } = vi.hoisted(() => ({
	recordSecurityMetricMock: vi.fn(),
}))
vi.mock("../../security/metrics", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		recordSecurityMetric: recordSecurityMetricMock,
		startTraceSpan: vi.fn(function () {
			return {
				traceId: "test-trace",
				spanId: "test-span",
				end: vi.fn(),
			}
		}),
	}
})

class TestTool extends BaseTool<"read_file"> {
	readonly name = "read_file" as const
	executed = false
	override isReadOnly(): boolean {
		return false
	}
	async execute(): Promise<void> {
		this.executed = true
	}
}

describe("BaseTool permission gating", () => {
	it("denies execution when rule engine returns deny", async () => {
		const tool = new TestTool()
		const block = {
			type: "tool_use",
			id: "1",
			name: "read_file",
			partial: false,
			params: {},
			nativeArgs: {},
		} as ToolUse<"read_file">

		const pushToolResult = vi.fn()
		const callbacks: ToolCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult,
		}

		const task = {
			taskId: "t1",
			cwd: ".",
			api: undefined,
			permissionRuleEngine: { evaluate: vi.fn().mockReturnValue("deny") },
		} as any

		await tool.handle(task, block, callbacks)
		expect(tool.executed).toBe(false)
		expect(pushToolResult).toHaveBeenCalled()
	})

	it("does not request a generic tool approval when no rule engine is configured", async () => {
		const tool = new TestTool()
		const block = {
			type: "tool_use",
			id: "no-engine",
			name: "read_file",
			partial: false,
			params: {},
			nativeArgs: {},
		} as ToolUse<"read_file">

		const askApproval = vi.fn().mockResolvedValue(true)
		const callbacks: ToolCallbacks = {
			askApproval,
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}

		const task = {
			taskId: "t-no-engine",
			cwd: ".",
			api: undefined,
		} as any

		await tool.handle(task, block, callbacks)

		expect(tool.executed).toBe(true)
		expect(askApproval).not.toHaveBeenCalled()
	})

	it("requests approval when the rule engine returns ask", async () => {
		const tool = new TestTool()
		const block = {
			type: "tool_use",
			id: "ask-engine",
			name: "read_file",
			partial: false,
			params: {},
			nativeArgs: {},
		} as ToolUse<"read_file">

		const askApproval = vi.fn().mockResolvedValue(true)
		const callbacks: ToolCallbacks = {
			askApproval,
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}

		const task = {
			taskId: "t-ask-engine",
			cwd: ".",
			api: undefined,
			permissionRuleEngine: { evaluate: vi.fn().mockReturnValue("ask") },
		} as any

		await tool.handle(task, block, callbacks)

		expect(tool.executed).toBe(true)
		expect(askApproval).toHaveBeenCalledWith("tool")
	})

	it("records performance metrics in finally", async () => {
		recordSecurityMetricMock.mockClear()
		const tool = new TestTool()
		tool.isReadOnly = () => true
		const block = {
			type: "tool_use",
			id: "2",
			name: "read_file",
			partial: false,
			params: {},
			nativeArgs: {},
		} as ToolUse<"read_file">
		const callbacks: ToolCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
		const task = {
			taskId: "t2",
			cwd: ".",
			api: undefined,
		} as any

		await tool.handle(task, block, callbacks)

		expect(recordSecurityMetricMock).toHaveBeenCalledWith(
			"tool_exec_duration_ms",
			expect.objectContaining({ tool: "read_file" }),
		)
		expect(recordSecurityMetricMock).toHaveBeenCalledWith(
			"tool_memory_rss_mb",
			expect.objectContaining({ tool: "read_file" }),
		)
		expect(recordSecurityMetricMock).toHaveBeenCalledWith(
			"tool_memory_delta_mb",
			expect.objectContaining({ tool: "read_file" }),
		)
	})
})
