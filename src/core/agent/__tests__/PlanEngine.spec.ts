import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PlanEngine } from "../PlanEngine"
import type { AgentLogSink, AgentTaskController, AgentTaskLike } from "../AgentTaskController"

const makeTask = (overrides: Partial<AgentTaskLike> = {}): AgentTaskLike => ({
	taskId: `task-${Math.random().toString(36).slice(2)}`,
	clineMessages: [
		{
			type: "say",
			say: "completion_result",
			text: "done",
		},
	],
	...overrides,
})

const flushPoll = async () => {
	await vi.advanceTimersByTimeAsync(500)
}

const queueTask = (provider: AgentTaskController, task: AgentTaskLike, prompts: string[]) => {
	vi.mocked(provider.createTask).mockImplementationOnce(async (message: string) => {
		prompts.push(message)
		return task
	})
}

describe("PlanEngine", () => {
	let provider: AgentTaskController
	let outputChannel: AgentLogSink
	let createdTasks: AgentTaskLike[]
	let createdPrompts: string[]

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-01-02T03:04:05Z"))

		createdTasks = []
		createdPrompts = []
		provider = {
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn(async function (message: string) {
				createdPrompts.push(message)
				const task = makeTask()
				createdTasks.push(task)
				return task
			}),
		}
		outputChannel = {
			appendLine: vi.fn(),
		}
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("generates a plan from JSON embedded in the task result", async () => {
		const planJson = {
			title: "Ship fix",
			description: "Add tests and validate coverage",
			steps: [
				{ description: "Inspect gaps", mode: "ask", dependencies: [] },
				{ description: "Add tests", mode: "code", dependencies: [0] },
			],
		}
		queueTask(
			provider,
			makeTask({
				clineMessages: [
					{
						type: "say",
						say: "completion_result",
						text: `Here is the plan:\n${JSON.stringify(planJson)}`,
					},
				],
			}),
			createdPrompts,
		)

		const engine = new PlanEngine(provider, outputChannel)
		const pendingPlan = engine.generatePlan({ task: "increase coverage", context: "src only", maxSteps: 2 })
		await flushPoll()
		const plan = await pendingPlan

		expect(plan.title).toBe("Ship fix")
		expect(plan.description).toBe("Add tests and validate coverage")
		expect(plan.steps).toHaveLength(2)
		expect(plan.steps[1]?.dependencies).toEqual([plan.steps[0]?.id])
		expect(plan.status).toBe("draft")
		expect(engine.getPlan(plan.id)).toBe(plan)
		expect(createdPrompts[0]).toContain("Maximum steps: 2")
		expect(createdPrompts[0]).toContain("Additional context:")
	})

	it("falls back to a default one-step plan when JSON parsing fails", async () => {
		queueTask(
			provider,
			makeTask({
				clineMessages: [{ type: "say", say: "completion_result", text: "not json" }],
			}),
			createdPrompts,
		)

		const engine = new PlanEngine(provider, outputChannel)
		const pendingPlan = engine.generatePlan({ task: "do the work" })
		await flushPoll()
		const plan = await pendingPlan

		expect(plan.title).toBe("Default Plan")
		expect(plan.steps).toMatchObject([{ index: 0, description: expect.stringContaining("do the work") }])
		expect(plan.totalSteps).toBe(1)
	})

	it("approves, updates, reorders, lists, and deletes plans", async () => {
		const engine = new PlanEngine(provider, outputChannel)
		const pendingPlan = engine.generatePlan({ task: "organize work" })
		await flushPoll()
		const plan = await pendingPlan
		const stepId = plan.steps[0]!.id

		engine.approvePlan(plan.id)
		engine.updateStep(plan.id, stepId, { description: "Updated step", mode: "debug" })
		engine.reorderSteps(plan.id, [stepId])

		expect(engine.getAllPlans()).toEqual([plan])
		expect(plan.status).toBe("approved")
		expect(plan.steps[0]).toMatchObject({ index: 0, description: "Updated step", mode: "debug" })

		engine.deletePlan(plan.id)
		expect(engine.getPlan(plan.id)).toBeUndefined()
	})

	it("executes dependency-ordered steps and passes prior results into dependent prompts", async () => {
		const planJson = {
			title: "Two step plan",
			description: "Run dependency chain",
			steps: [
				{ description: "First", mode: "ask", dependencies: [] },
				{ description: "Second", mode: "code", dependencies: [0] },
			],
		}
		queueTask(
			provider,
			makeTask({
				clineMessages: [{ type: "say", say: "completion_result", text: JSON.stringify(planJson) }],
			}),
			createdPrompts,
		)
		queueTask(
			provider,
			makeTask({
				taskId: "step-1",
				clineMessages: [{ type: "say", say: "completion_result", text: "first result" }],
			}),
			createdPrompts,
		)
		queueTask(
			provider,
			makeTask({
				taskId: "step-2",
				clineMessages: [{ type: "say", say: "completion_result", text: "second result" }],
			}),
			createdPrompts,
		)
		const onStepStart = vi.fn()
		const onStepComplete = vi.fn()
		const onPlanUpdate = vi.fn()
		const engine = new PlanEngine(provider, outputChannel)

		const pendingPlan = engine.generatePlan({ task: "chain" })
		await flushPoll()
		const plan = await pendingPlan

		const pendingExecution = engine.executePlan(plan.id, { onStepStart, onStepComplete, onPlanUpdate })
		await flushPoll()
		await flushPoll()
		const executed = await pendingExecution

		expect(executed.status).toBe("completed")
		expect(executed.completedSteps).toBe(2)
		expect(executed.steps.map((step) => step.result)).toEqual(["first result", "second result"])
		expect(provider.handleModeSwitch).toHaveBeenNthCalledWith(1, "ask")
		expect(provider.handleModeSwitch).toHaveBeenNthCalledWith(2, "code")
		expect(createdPrompts[2]).toContain("Results from previous steps:")
		expect(createdPrompts[2]).toContain("first result")
		expect(onStepStart).toHaveBeenCalledTimes(2)
		expect(onStepComplete).toHaveBeenCalledTimes(2)
		expect(onPlanUpdate).toHaveBeenCalled()
	})

	it("marks a failed step and cancels pending dependents", async () => {
		const planJson = {
			title: "Failure plan",
			description: "Cancel dependent work",
			steps: [
				{ description: "Break", mode: "debug", dependencies: [] },
				{ description: "Dependent", mode: "code", dependencies: [0] },
			],
		}
		queueTask(
			provider,
			makeTask({
				clineMessages: [{ type: "say", say: "completion_result", text: JSON.stringify(planJson) }],
			}),
			createdPrompts,
		)
		queueTask(
			provider,
			makeTask({
				didFinishAbortingStream: true,
				clineMessages: [{ type: "say", say: "error", text: "tool failed" }],
			}),
			createdPrompts,
		)
		const engine = new PlanEngine(provider, outputChannel)

		const pendingPlan = engine.generatePlan({ task: "fail branch" })
		await flushPoll()
		const plan = await pendingPlan

		const pendingExecution = engine.executePlan(plan.id)
		await flushPoll()
		const executed = await pendingExecution

		expect(executed.status).toBe("failed")
		expect(executed.steps[0]).toMatchObject({ status: "failed", error: "tool failed" })
		expect(executed.steps[1]).toMatchObject({ status: "pending" })
	})
})
