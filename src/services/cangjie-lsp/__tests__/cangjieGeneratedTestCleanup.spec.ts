import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockExistsSync, mockStatSync, mockUnlinkSync, mockReadFileSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockStatSync: vi.fn(),
	mockUnlinkSync: vi.fn(),
	mockReadFileSync: vi.fn(),
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			existsSync: mockExistsSync,
			statSync: mockStatSync,
			unlinkSync: mockUnlinkSync,
			readFileSync: mockReadFileSync,
		},
		existsSync: mockExistsSync,
		statSync: mockStatSync,
		unlinkSync: mockUnlinkSync,
		readFileSync: mockReadFileSync,
	}
})

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockResolvedValue("/mock/storage"),
}))

vi.mock("../../../shared/globalFileNames", () => ({
	GlobalFileNames: { historyIndex: "_index.json" },
}))

vi.mock("../../../shared/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn() },
}))

vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))

vi.mock("@njust-ai/types", () => ({
	TelemetryEventName: { CANGJIE_LSP_ERROR: "cangjie_lsp_error" },
}))

import {
	initTestCleanup,
	registerGeneratedCangjieTestFile,
	deleteGeneratedCangjieTestFilesForTask,
	pruneStaleRegistrations,
	purgeAllTrackedCangjieTestFiles,
	WORKSPACE_STATE_KEY,
} from "../cangjieGeneratedTestCleanup"

function createMockMemento(initial?: Record<string, string[]>): {
	get: <T>(key: string, defaultValue?: T) => T
	update: ReturnType<typeof vi.fn>
} {
	const store: Record<string, unknown> = { ...initial }
	return {
		get: <T>(key: string, defaultValue?: T): T => (key in store ? (store[key] as T) : (defaultValue as T)),
		update: vi.fn(async (key: string, value: unknown) => {
			store[key] = value
		}),
	}
}

let uniqueCounter = 0
function uniqueTaskId(): string {
	return `task_${Date.now()}_${++uniqueCounter}`
}

describe("cangjieGeneratedTestCleanup", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockExistsSync.mockReturnValue(false)
		// Purge any leftover state from previous test runs
		purgeAllTrackedCangjieTestFiles()
	})

	describe("initTestCleanup", () => {
		it("loads saved state from memento", () => {
			const memento = createMockMemento({
				[WORKSPACE_STATE_KEY]: { task1: ["/path/to/test.cj"] },
			})
			initTestCleanup(memento as any)
		})

		it("handles empty memento", () => {
			const memento = createMockMemento()
			expect(() => initTestCleanup(memento as any)).not.toThrow()
		})

		it("ignores non-array entries in saved state", () => {
			const memento = createMockMemento({
				[WORKSPACE_STATE_KEY]: { task1: "not-an-array" } as any,
			})
			expect(() => initTestCleanup(memento as any)).not.toThrow()
		})
	})

	describe("registerGeneratedCangjieTestFile", () => {
		it("registers file with task id", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			registerGeneratedCangjieTestFile(uniqueTaskId(), "/path/to/test_test.cj")
			expect(memento.update).toHaveBeenCalled()
		})

		it("registers file with NO_TASK_KEY when task id is undefined", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			registerGeneratedCangjieTestFile(undefined, "/path/to/test_test.cj")
			expect(memento.update).toHaveBeenCalled()
		})

		it("normalizes paths", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			registerGeneratedCangjieTestFile(uniqueTaskId(), "/path/to/../to/test_test.cj")
			expect(memento.update).toHaveBeenCalled()
		})
	})

	describe("deleteGeneratedCangjieTestFilesForTask", () => {
		it("deletes registered files", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			const taskId = uniqueTaskId()
			const filePath = "/path/to/test_test.cj"
			registerGeneratedCangjieTestFile(taskId, filePath)
			mockExistsSync.mockReturnValue(true)
			mockStatSync.mockReturnValue({ isFile: () => true })
			deleteGeneratedCangjieTestFilesForTask(taskId)
			expect(mockUnlinkSync).toHaveBeenCalled()
		})

		it("skips non-_test.cj files", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			const taskId = uniqueTaskId()
			registerGeneratedCangjieTestFile(taskId, "/path/to/regular.cj")
			mockExistsSync.mockReturnValue(true)
			mockStatSync.mockReturnValue({ isFile: () => true })
			deleteGeneratedCangjieTestFilesForTask(taskId)
			expect(mockUnlinkSync).not.toHaveBeenCalled()
		})

		it("handles missing files gracefully", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			const taskId = uniqueTaskId()
			registerGeneratedCangjieTestFile(taskId, "/path/to/test_test.cj")
			mockExistsSync.mockReturnValue(false)
			expect(() => deleteGeneratedCangjieTestFilesForTask(taskId)).not.toThrow()
		})
	})

	describe("pruneStaleRegistrations", () => {
		it("removes entries where shouldRetainTaskId returns false", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			const task1 = uniqueTaskId()
			const task2 = uniqueTaskId()
			registerGeneratedCangjieTestFile(task1, "/path/to/test_test.cj")
			registerGeneratedCangjieTestFile(task2, "/path/to/test2_test.cj")
			const result = pruneStaleRegistrations((id) => id === task2)
			expect(result.taskEntriesRemoved).toBe(1)
		})

		it("retains entries where shouldRetainTaskId returns true", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			const taskId = uniqueTaskId()
			registerGeneratedCangjieTestFile(taskId, "/path/to/test_test.cj")
			const result = pruneStaleRegistrations(() => true)
			expect(result.taskEntriesRemoved).toBe(0)
		})
	})

	describe("purgeAllTrackedCangjieTestFiles", () => {
		it("removes all tracked entries", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			registerGeneratedCangjieTestFile(uniqueTaskId(), "/path/to/test_test.cj")
			registerGeneratedCangjieTestFile(uniqueTaskId(), "/path/to/test2_test.cj")
			const result = purgeAllTrackedCangjieTestFiles()
			expect(result.taskEntriesRemoved).toBe(2)
		})

		it("returns zero when nothing tracked", () => {
			const memento = createMockMemento()
			initTestCleanup(memento as any)
			const result = purgeAllTrackedCangjieTestFiles()
			expect(result.taskEntriesRemoved).toBe(0)
			expect(result.filesRemoved).toBe(0)
		})
	})
})
