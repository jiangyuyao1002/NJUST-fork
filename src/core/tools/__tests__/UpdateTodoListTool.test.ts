import { describe, it, expect, vi } from "vitest"

import {
	parseMarkdownChecklist,
	addTodoToTask,
	updateTodoStatusForTask,
	removeTodoFromTask,
	getTodoListForTask,
	setTodoListForTask,
	restoreTodoListForTask,
	setPendingTodoList,
} from "../UpdateTodoListTool"

// Minimal mock for Task-like objects
function makeTask(todoList?: any[]) {
	return {
		todoList,
		clineMessages: [],
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue(true),
	} as any
}

describe("parseMarkdownChecklist", () => {
	it("parses completed items", () => {
		const r = parseMarkdownChecklist("[x] done task")
		expect(r).toHaveLength(1)
		expect(r[0]!.content).toBe("done task")
		expect(r[0]!.status).toBe("completed")
	})

	it("parses pending items", () => {
		const r = parseMarkdownChecklist("[ ] pending task")
		expect(r).toHaveLength(1)
		expect(r[0]!.status).toBe("pending")
	})

	it("parses in_progress items with dash", () => {
		const r = parseMarkdownChecklist("[-] in progress")
		expect(r[0]!.status).toBe("in_progress")
	})

	it("parses in_progress items with tilde", () => {
		const r = parseMarkdownChecklist("[~] also in progress")
		expect(r[0]!.status).toBe("in_progress")
	})

	it("parses uppercase X as completed", () => {
		const r = parseMarkdownChecklist("[X] uppercase done")
		expect(r[0]!.status).toBe("completed")
	})

	it("handles multiple lines", () => {
		const r = parseMarkdownChecklist("[x] task 1\n[ ] task 2\n[-] task 3")
		expect(r).toHaveLength(3)
		expect(r[0]!.status).toBe("completed")
		expect(r[1]!.status).toBe("pending")
		expect(r[2]!.status).toBe("in_progress")
	})

	it("handles dash prefix", () => {
		const r = parseMarkdownChecklist("- [x] dashed task")
		expect(r).toHaveLength(1)
		expect(r[0]!.content).toBe("dashed task")
	})

	it("skips non-matching lines", () => {
		const r = parseMarkdownChecklist("not a checklist\n[x] valid")
		expect(r).toHaveLength(1)
	})

	it("returns empty for non-string input", () => {
		expect(parseMarkdownChecklist(null as any)).toEqual([])
		expect(parseMarkdownChecklist(undefined as any)).toEqual([])
		expect(parseMarkdownChecklist(123 as any)).toEqual([])
	})

	it("returns empty for empty string", () => {
		expect(parseMarkdownChecklist("")).toEqual([])
	})

	it("generates deterministic ids", () => {
		const r1 = parseMarkdownChecklist("[x] same task")
		const r2 = parseMarkdownChecklist("[x] same task")
		expect(r1[0]!.id).toBe(r2[0]!.id)
	})

	it("generates different ids for different status", () => {
		const r1 = parseMarkdownChecklist("[x] task")
		const r2 = parseMarkdownChecklist("[ ] task")
		expect(r1[0]!.id).not.toBe(r2[0]!.id)
	})
})

describe("addTodoToTask", () => {
	it("adds todo to empty list", () => {
		const task = makeTask()
		const todo = addTodoToTask(task, "new task")
		expect(task.todoList).toHaveLength(1)
		expect(todo.content).toBe("new task")
		expect(todo.status).toBe("pending")
	})

	it("adds todo with custom status", () => {
		const task = makeTask()
		const todo = addTodoToTask(task, "task", "in_progress")
		expect(todo.status).toBe("in_progress")
	})

	it("adds todo with custom id", () => {
		const task = makeTask()
		const todo = addTodoToTask(task, "task", "pending", "custom-id")
		expect(todo.id).toBe("custom-id")
	})

	it("initializes todoList if undefined", () => {
		const task = makeTask(undefined)
		addTodoToTask(task, "task")
		expect(task.todoList).toHaveLength(1)
	})
})

describe("updateTodoStatusForTask", () => {
	it("updates pending to in_progress", () => {
		const task = makeTask([{ id: "1", content: "t", status: "pending" }])
		expect(updateTodoStatusForTask(task, "1", "in_progress")).toBe(true)
		expect(task.todoList[0].status).toBe("in_progress")
	})

	it("updates in_progress to completed", () => {
		const task = makeTask([{ id: "1", content: "t", status: "in_progress" }])
		expect(updateTodoStatusForTask(task, "1", "completed")).toBe(true)
		expect(task.todoList[0].status).toBe("completed")
	})

	it("allows same status", () => {
		const task = makeTask([{ id: "1", content: "t", status: "pending" }])
		expect(updateTodoStatusForTask(task, "1", "pending")).toBe(true)
	})

	it("rejects invalid transition completed to pending", () => {
		const task = makeTask([{ id: "1", content: "t", status: "completed" }])
		expect(updateTodoStatusForTask(task, "1", "pending")).toBe(false)
	})

	it("returns false for missing id", () => {
		const task = makeTask([{ id: "1", content: "t", status: "pending" }])
		expect(updateTodoStatusForTask(task, "999", "in_progress")).toBe(false)
	})

	it("returns false for undefined todoList", () => {
		const task = makeTask(undefined)
		expect(updateTodoStatusForTask(task, "1", "in_progress")).toBe(false)
	})
})

describe("removeTodoFromTask", () => {
	it("removes existing todo", () => {
		const task = makeTask([{ id: "1", content: "t", status: "pending" }])
		expect(removeTodoFromTask(task, "1")).toBe(true)
		expect(task.todoList).toHaveLength(0)
	})

	it("returns false for missing id", () => {
		const task = makeTask([{ id: "1", content: "t", status: "pending" }])
		expect(removeTodoFromTask(task, "999")).toBe(false)
	})

	it("returns false for undefined todoList", () => {
		const task = makeTask(undefined)
		expect(removeTodoFromTask(task, "1")).toBe(false)
	})
})

describe("getTodoListForTask", () => {
	it("returns copy of todoList", () => {
		const list = [{ id: "1", content: "t", status: "pending" as const }]
		const task = makeTask(list)
		const r = getTodoListForTask(task)
		expect(r).toEqual(list)
		expect(r).not.toBe(list) // should be a copy
	})

	it("returns undefined for undefined todoList", () => {
		expect(getTodoListForTask(makeTask(undefined))).toBeUndefined()
	})
})

describe("setTodoListForTask", () => {
	it("sets todoList", () => {
		const task = makeTask()
		const todos = [{ id: "1", content: "t", status: "pending" as const }]
		setTodoListForTask(task, todos)
		expect(task.todoList).toEqual(todos)
	})

	it("sets empty array for undefined todos", () => {
		const task = makeTask()
		setTodoListForTask(task, undefined)
		expect(task.todoList).toEqual([])
	})

	it("does nothing for undefined task", () => {
		expect(() => setTodoListForTask(undefined, [])).not.toThrow()
	})
})

describe("restoreTodoListForTask", () => {
	it("restores from provided list", () => {
		const task = makeTask()
		const todos = [{ id: "1", content: "t", status: "pending" as const }]
		restoreTodoListForTask(task, todos)
		expect(task.todoList).toEqual(todos)
	})

	it("restores empty array for undefined todoList", () => {
		const task = makeTask()
		restoreTodoListForTask(task, undefined)
		// Falls back to getLatestTodo which returns undefined from empty messages
		expect(task.todoList).toBeDefined()
	})
})

describe("setPendingTodoList", () => {
	it("sets the pending todo list", () => {
		const todos = [{ id: "1", content: "t", status: "pending" as const }]
		expect(() => setPendingTodoList(todos)).not.toThrow()
	})
})
