import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: vi.fn(() => ({
			onDidCreate: vi.fn(),
			onDidChange: vi.fn(),
			onDidDelete: vi.fn(),
			dispose: vi.fn(),
		})),
	},
	RelativePattern: vi.fn(),
}))

vi.mock("../../../shared/logger", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

import { logger } from "../../../shared/logger"
import { TaskExecutor } from "../TaskExecutor"

function host(overrides: Record<string, unknown> = {}) {
	return {
		parentTask: {
			getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 1000 }),
		},
		getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 500 }),
		api: {
			getModel: vi.fn().mockReturnValue({ info: { contextWindow: 2000 } }),
		},
		taskId: "task-1",
		...overrides,
	} as any
}

describe("TaskExecutor", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does not warn when task has no parent", () => {
		const executor = new TaskExecutor(host({ parentTask: undefined }))

		;(executor as any).checkSubtaskTokenBudget()

		expect(logger.warn).not.toHaveBeenCalled()
	})

	it("warns when subtask token usage approaches parent remaining budget", () => {
		const executor = new TaskExecutor(
			host({
				parentTask: { getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 1500 }) },
				getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 450 }),
				api: { getModel: vi.fn().mockReturnValue({ info: { contextWindow: 2000 } }) },
			}),
		)

		;(executor as any).checkSubtaskTokenBudget()

		expect(logger.warn).toHaveBeenCalledWith("TaskExecutor", expect.stringContaining("approaching parent's remaining budget"))
	})

	it("uses default context window when model omits one", () => {
		const executor = new TaskExecutor(
			host({
				parentTask: { getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 199_000 }) },
				getTokenUsage: vi.fn().mockReturnValue({ contextTokens: 700 }),
				api: { getModel: vi.fn().mockReturnValue({ info: {} }) },
			}),
		)

		;(executor as any).checkSubtaskTokenBudget()

		expect(logger.warn).not.toHaveBeenCalled()
	})

	it("appends finalized streaming tool calls when tracking index is missing", () => {
		const executor = new TaskExecutor(host({ parentTask: undefined }))
		const taskHost = {
			assistantMessageContent: [],
			streamingToolCallIndices: new Map(),
			userMessageContentReady: true,
		}
		const finalToolUse = {
			type: "tool_use",
			name: "read_file",
			params: { path: "simple.txt" },
			partial: false,
		}

		const placed = (executor as any).placeFinalizedStreamingToolUse(taskHost, "call_missing", finalToolUse)

		expect(placed).toBe(finalToolUse)
		expect(taskHost.assistantMessageContent).toEqual([{ ...finalToolUse, id: "call_missing" }])
		expect(taskHost.userMessageContentReady).toBe(false)
	})
})
