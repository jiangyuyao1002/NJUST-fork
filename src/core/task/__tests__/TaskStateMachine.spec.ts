import { describe, expect, it } from "vitest"

import { TaskStateMachine, TaskState } from "../TaskStateMachine"

describe("TaskStateMachine", () => {
	it("starts in IDLE", () => {
		const sm = new TaskStateMachine()
		expect(sm.state).toBe(TaskState.IDLE)
	})

	it("allows valid transitions", () => {
		const sm = new TaskStateMachine()
		sm.transition(TaskState.PREPARING)
		sm.transition(TaskState.STREAMING)
		sm.transition(TaskState.PROCESSING_TOOLS)
		sm.transition(TaskState.PREPARING)
		expect(sm.state).toBe(TaskState.PREPARING)
	})

	it("rejects invalid transitions", () => {
		const sm = new TaskStateMachine()
		expect(() => sm.transition(TaskState.STREAMING)).toThrow("Invalid task state transition")
	})

	it("force allows direct override", () => {
		const sm = new TaskStateMachine()
		sm.force(TaskState.ERROR)
		expect(sm.state).toBe(TaskState.ERROR)
	})

	it("should allow ERROR -> PREPARING for retry recovery", () => {
		const sm = new TaskStateMachine()
		sm.force(TaskState.ERROR)
		expect(sm.canTransition(TaskState.PREPARING)).toBe(true)
	})

	it("should allow ERROR -> RECOVERING_MAX_TOKENS for token recovery", () => {
		const sm = new TaskStateMachine()
		sm.force(TaskState.ERROR)
		expect(sm.canTransition(TaskState.RECOVERING_MAX_TOKENS)).toBe(true)
	})
})
