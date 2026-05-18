import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	writeFile: vi.fn(),
	readFile: vi.fn(),
}))

vi.mock("crypto", () => ({
	randomUUID: vi.fn(),
}))

import * as fs from "fs/promises"
import * as crypto from "crypto"
import { TaskBoard, type TaskBoardItem } from "../TaskBoard"

function storedTask(overrides: Partial<TaskBoardItem>): TaskBoardItem {
	return {
		id: "stored-1",
		title: "stored",
		status: "pending",
		priority: "medium",
		createdAt: 100,
		updatedAt: 100,
		...overrides,
	}
}

describe("TaskBoard", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockRejectedValue(new Error("missing"))
		vi.mocked(crypto.randomUUID).mockReturnValue("task-1")
		vi.spyOn(Date, "now").mockReturnValue(1000)
	})

	it("creates tasks with defaults and persists JSON", async () => {
		const board = new TaskBoard("C:\\work", "session")

		const item = await board.createTask({ title: "Implement", metadata: { owner: "test" } })

		expect(item).toMatchObject({
			id: "task-1",
			title: "Implement",
			status: "pending",
			priority: "medium",
			createdAt: 1000,
			updatedAt: 1000,
			metadata: { owner: "test" },
		})
		expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining(".roo"), { recursive: true })
		expect(fs.writeFile).toHaveBeenCalledWith(
			expect.stringContaining("session.json"),
			expect.stringContaining('"title": "Implement"'),
			"utf8",
		)
	})

	it("loads existing tasks once and filters by status priority and limit", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce(
			JSON.stringify([
				storedTask({ id: "a", status: "completed", priority: "low", updatedAt: 1 }),
				storedTask({ id: "b", status: "pending", priority: "high", updatedAt: 3 }),
				storedTask({ id: "c", status: "pending", priority: "high", updatedAt: 2 }),
				{ title: "ignored" },
			]),
		)
		const board = new TaskBoard("C:\\work", "session")

		const tasks = await board.listTasks({ status: "pending", priority: "high", limit: 1 })

		expect(tasks.map((task) => task.id)).toEqual(["b"])
		expect(fs.readFile).toHaveBeenCalledTimes(1)
		await board.listTasks()
		expect(fs.readFile).toHaveBeenCalledTimes(1)
	})

	it("updates tasks while preserving immutable fields", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify([storedTask({ id: "a", createdAt: 10 })]))
		vi.spyOn(Date, "now").mockReturnValue(2000)
		const board = new TaskBoard("C:\\work", "session")

		const updated = await board.updateTask("a", { title: "new", status: "completed", priority: "high" })

		expect(updated).toMatchObject({
			id: "a",
			title: "new",
			status: "completed",
			priority: "high",
			createdAt: 10,
			updatedAt: 2000,
		})
	})

	it("throws when updating missing task", async () => {
		const board = new TaskBoard("C:\\work", "session")

		await expect(board.updateTask("missing", { title: "x" })).rejects.toThrow("Task not found: missing")
	})

	it("gets and deletes tasks", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify([storedTask({ id: "a" })]))
		const board = new TaskBoard("C:\\work", "session")

		await expect(board.getTask("a")).resolves.toMatchObject({ id: "a" })
		await expect(board.deleteTask("a")).resolves.toBe(true)
		await expect(board.deleteTask("a")).resolves.toBe(false)
		expect(fs.writeFile).toHaveBeenCalledTimes(1)
	})

	it("reports unfinished dependencies as blockers", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce(
			JSON.stringify([
				storedTask({ id: "a", status: "pending" }),
				storedTask({ id: "b", status: "completed" }),
				storedTask({ id: "c", dependsOn: ["a", "b", "missing"] }),
			]),
		)
		const board = new TaskBoard("C:\\work", "session")
		await board.listTasks()

		expect(board.isBlocked("c")).toBe(true)
		expect(board.getBlockedBy("c")).toEqual(["a"])
		expect(board.getBlockedBy("missing")).toEqual([])
	})

	it("starts empty when persisted JSON is corrupt", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce("not json")
		const board = new TaskBoard("C:\\work", "session")

		await expect(board.listTasks()).resolves.toEqual([])
	})

	it("ignores persisted task entries that do not match the task schema", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce(
			JSON.stringify([
				storedTask({ id: "valid" }),
				storedTask({ id: "invalid-status", status: "done" as TaskBoardItem["status"] }),
				{ id: "missing-fields" },
			]),
		)
		const board = new TaskBoard("C:\\work", "session")

		const tasks = await board.listTasks()

		expect(tasks.map((task) => task.id)).toEqual(["valid"])
	})
})
