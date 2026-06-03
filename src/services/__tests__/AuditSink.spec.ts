import { describe, it, expect, vi, beforeEach } from "vitest"

import { AuditSink } from "../AuditSink"
import type { AuditLogger, AuditEntry } from "../AuditLogger"
import { ToolHookManager } from "../../core/tools/ToolHookManager"

describe("AuditSink", () => {
	let mockLogger: AuditLogger
	let hookManager: ToolHookManager
	let sink: AuditSink
	let loggedEntries: AuditEntry[]

	beforeEach(() => {
		loggedEntries = []
		mockLogger = {
			log: vi.fn((entry: AuditEntry) => {
				loggedEntries.push(entry)
			}),
			flush: vi.fn(),
			dispose: vi.fn(),
		} as unknown as AuditLogger

		// Use a fresh ToolHookManager instance to avoid cross-test pollution
		hookManager = new ToolHookManager()
		sink = new AuditSink(mockLogger, hookManager)
	})

	it("logs tool execution on PostToolUse hook", async () => {
		// Trigger the post hook directly through the hook manager
		await hookManager.runPostHooks("read_file", { path: "/foo.ts" }, undefined, {
			taskId: "task-1",
			toolUseId: "use-1",
			cwd: "/project",
		})

		expect(loggedEntries).toHaveLength(1)
		expect(loggedEntries[0]).toMatchObject({
			category: "tool.execution",
			action: "tool.read_file",
			tool: "read_file",
			taskId: "task-1",
			outcome: "success",
		})
		expect(loggedEntries[0].timestamp).toBeTruthy()
	})

	it("logs tool failure on PostToolUseFailure hook", async () => {
		const error = new Error("ENOENT")
		await hookManager.runFailureHooks("write_to_file", { path: "/readonly.txt" }, error, {
			taskId: "task-2",
			toolUseId: "use-2",
			cwd: "/project",
		})

		expect(loggedEntries).toHaveLength(1)
		expect(loggedEntries[0]).toMatchObject({
			category: "tool.execution",
			action: "tool.write_to_file",
			outcome: "error",
			meta: { errorMessage: "ENOENT" },
		})
	})

	it("logs permission denied on PermissionDenied hook", async () => {
		await hookManager.runPermissionDeniedHooks("execute_command", { command: "rm -rf /" }, "dangerous command", {
			taskId: "task-3",
			toolUseId: "use-3",
			cwd: "/project",
		})

		expect(loggedEntries).toHaveLength(1)
		expect(loggedEntries[0]).toMatchObject({
			category: "tool.permission",
			action: "permission.denied.execute_command",
			outcome: "denied",
			meta: { reason: "dangerous command" },
		})
	})

	it("logs session lifecycle events", async () => {
		await hookManager.runSessionStartHooks({ taskId: "task-4", cwd: "/project" })
		await hookManager.runSessionEndHooks({ taskId: "task-4", cwd: "/project" })

		expect(loggedEntries).toHaveLength(2)
		expect(loggedEntries[0].action).toBe("session.start")
		expect(loggedEntries[1].action).toBe("session.end")
	})

	it("logs aborted session with error outcome", async () => {
		await hookManager.runSessionEndHooks({ taskId: "task-5", cwd: "/project", aborted: true })

		expect(loggedEntries).toHaveLength(1)
		expect(loggedEntries[0]).toMatchObject({
			action: "session.aborted",
			outcome: "error",
		})
	})

	it("logs subagent lifecycle events", async () => {
		await hookManager.runSubagentStartHooks("parent-1", "Explore", { taskId: "child-1" })
		await hookManager.runSubagentStopHooks("parent-1", "Explore", true, { taskId: "child-1" })

		expect(loggedEntries).toHaveLength(2)
		expect(loggedEntries[0]).toMatchObject({
			category: "subagent.lifecycle",
			action: "subagent.start",
			taskId: "parent-1",
			meta: { agentType: "Explore", childTaskId: "child-1" },
		})
		expect(loggedEntries[1]).toMatchObject({
			action: "subagent.stop",
			outcome: "success",
		})
	})

	it("allows manual emit of custom entries", () => {
		sink.emit({
			timestamp: "2026-06-03T12:00:00.000Z",
			category: "config.change",
			action: "config.permissionMode",
			outcome: "success",
			meta: { from: "default", to: "bypass" },
		})

		expect(loggedEntries).toHaveLength(1)
		expect(loggedEntries[0]).toMatchObject({
			category: "config.change",
			action: "config.permissionMode",
		})
	})

	it("truncates large tool input summaries", async () => {
		const largeInput = { data: "x".repeat(500) }
		await hookManager.runPostHooks("read_file", largeInput, undefined, {
			taskId: "task-6",
			toolUseId: "use-6",
			cwd: "/project",
		})

		const meta = loggedEntries[0].meta as Record<string, unknown>
		const summary = meta.inputSummary as string
		expect(summary.length).toBeLessThanOrEqual(305) // 300 + "…"
		expect(summary.endsWith("…")).toBe(true)
	})
})
