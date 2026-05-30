import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { taskStopTool } from "../TaskStopTool"

describe("TaskStopTool", () => {
	const prevMode = process.env.NJUST_AI_TASK_STOP_MODE
	beforeEach(() => {
		delete process.env.NJUST_AI_TASK_STOP_MODE
	})
	afterEach(() => {
		process.env.NJUST_AI_TASK_STOP_MODE = prevMode
	})

	it("stops a running task by id", async () => {
		const abortTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: "t-1" } }),
			getAllTaskInstances: vi.fn().mockReturnValue([{ taskId: "t-1", abortTask }]),
		}
		const task = {
			taskId: "t-1",
			providerRef: { deref: () => provider },
			sayAndCreateMissingParamError: vi.fn(),
		} as any
		const pushToolResult = vi.fn()

		await taskStopTool.execute({ taskId: "t-1" }, task, { pushToolResult } as any)

		expect(abortTask).toHaveBeenCalledWith(true)
		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Stopped task t-1"))
	})

	it("returns not found when task id does not exist", async () => {
		const provider = {
			getTaskWithId: vi.fn().mockResolvedValue(undefined),
			getAllTaskInstances: vi.fn().mockReturnValue([]),
		}
		const task = {
			providerRef: { deref: () => provider },
			sayAndCreateMissingParamError: vi.fn(),
			taskId: "caller",
			rootTaskId: "root-1",
		} as any
		const pushToolResult = vi.fn()

		await taskStopTool.execute({ taskId: "missing" }, task, { pushToolResult } as any)

		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Task not found"))
	})

	it("denies stopping task outside delegation tree", async () => {
		const provider = {
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: "t-2", rootTaskId: "root-2" } }),
			getAllTaskInstances: vi.fn().mockReturnValue([{ taskId: "t-2", abortTask: vi.fn() }]),
		}
		const task = {
			providerRef: { deref: () => provider },
			sayAndCreateMissingParamError: vi.fn(),
			taskId: "caller",
			rootTaskId: "root-1",
		} as any
		const pushToolResult = vi.fn()

		await taskStopTool.execute({ taskId: "t-2" }, task, { pushToolResult } as any)

		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Permission denied"))
	})

	it("enforces self_only mode", async () => {
		process.env.NJUST_AI_TASK_STOP_MODE = "self_only"
		const provider = {
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: "t-1", rootTaskId: "root-1" } }),
			getAllTaskInstances: vi.fn().mockReturnValue([{ taskId: "t-1", abortTask: vi.fn() }]),
		}
		const task = {
			providerRef: { deref: () => provider },
			sayAndCreateMissingParamError: vi.fn(),
			taskId: "caller",
			rootTaskId: "root-1",
		} as any
		const pushToolResult = vi.fn()

		await taskStopTool.execute({ taskId: "t-1" }, task, { pushToolResult } as any)

		expect(pushToolResult).toHaveBeenCalledWith(expect.stringContaining("self_only"))
	})

	it("allows cross-tree stop in admin mode", async () => {
		process.env.NJUST_AI_TASK_STOP_MODE = "admin"
		const abortTask = vi.fn().mockResolvedValue(undefined)
		const provider = {
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: "t-2", rootTaskId: "root-2" } }),
			getAllTaskInstances: vi.fn().mockReturnValue([{ taskId: "t-2", abortTask }]),
		}
		const task = {
			providerRef: { deref: () => provider },
			sayAndCreateMissingParamError: vi.fn(),
			taskId: "caller",
			rootTaskId: "root-1",
		} as any
		const pushToolResult = vi.fn()

		await taskStopTool.execute({ taskId: "t-2" }, task, { pushToolResult } as any)

		expect(abortTask).toHaveBeenCalledWith(true)
	})
})
