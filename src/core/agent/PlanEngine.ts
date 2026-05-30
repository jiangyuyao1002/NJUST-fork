import { getErrorMessage } from "../../shared/error-utils"
import { v7 as uuidv7 } from "uuid"
import { TelemetryEventName } from "@njust-ai/types"
import { TelemetryService } from "@njust-ai/telemetry"

import type {
	Plan,
	PlanStep,
	PlanStepResult,
	PlanStepStatus,
	PlanGenerationOptions,
	PlanExecutionOptions,
} from "./types"
import type { AgentLogSink, AgentTaskController, AgentTaskLike } from "./AgentTaskController"
import { waitForTaskCompletion } from "./sharedTaskWait"

const PLAN_GENERATION_PROMPT = `You are a task planning assistant. Given a user's task description, generate a structured execution plan.

Output ONLY a valid JSON object with the following structure (no markdown, no explanation):
{
  "title": "Short title for the plan",
  "description": "Brief description of what the plan accomplishes",
  "steps": [
    {
      "description": "What this step does",
      "mode": "code|architect|ask|debug",
      "dependencies": []
    }
  ]
}

Rules:
- Each step should be a discrete, actionable unit of work
- Use "architect" mode for design/planning steps
- Use "code" mode for implementation steps
- Use "debug" mode for testing/debugging steps
- Use "ask" mode for research/analysis steps
- Dependencies are zero-indexed step numbers that must complete before this step
- Keep the plan concise (typically 3-8 steps)
- Order steps logically with proper dependency chains`

/**
 * PlanEngine provides Plan-and-Execute capability for the Agent.
 * It uses the LLM to generate structured plans, then executes them
 * step-by-step using the existing Task/ClineProvider infrastructure.
 */
export class PlanEngine {
	private plans: Map<string, Plan> = new Map()
	private activePlanId: string | undefined
	private abortController: AbortController | undefined

	constructor(
		private readonly provider: AgentTaskController,
		private readonly outputChannel: AgentLogSink,
	) {}

	async generatePlan(options: PlanGenerationOptions): Promise<Plan> {
		const { task, context, maxSteps = 10 } = options

		this.outputChannel.appendLine(`[PlanEngine] Generating plan for: ${task}`)

		const prompt = this.buildPlanGenerationPrompt(task, context, maxSteps)

		const plan = await this.callLLMForPlan(prompt)
		this.plans.set(plan.id, plan)

		this.outputChannel.appendLine(`[PlanEngine] Plan generated: ${plan.title} (${plan.steps.length} steps)`)

		return plan
	}

	async executePlan(planId: string, options: PlanExecutionOptions = {}): Promise<Plan> {
		const plan = this.plans.get(planId)
		if (!plan) {
			throw new Error(`Plan not found: ${planId}`)
		}

		if (plan.status !== "draft" && plan.status !== "approved" && plan.status !== "paused") {
			throw new Error(`Plan cannot be executed in status: ${plan.status}`)
		}

		plan.status = "executing"
		plan.updatedAt = Date.now()
		this.activePlanId = planId
		this.abortController = new AbortController()

		options.onPlanUpdate?.(plan)

		try {
			await this.executeSteps(plan, options)

			const allCompleted = plan.steps.every((s) => s.status === "completed" || s.status === "skipped")
			plan.status = allCompleted ? "completed" : "failed"
		} catch (error) {
			if (this.abortController?.signal.aborted) {
				plan.status = "paused"
			} else {
				plan.status = "failed"
			}
			this.outputChannel.appendLine(`[PlanEngine] Plan execution stopped: ${getErrorMessage(error)}`)
			TelemetryService.reportError(error, TelemetryEventName.EXTENSION_INIT_ERROR)
		} finally {
			plan.updatedAt = Date.now()
			plan.completedSteps = plan.steps.filter((s) => s.status === "completed").length
			this.activePlanId = undefined
			this.abortController = undefined
			options.onPlanUpdate?.(plan)
		}

		return plan
	}

	private async executeSteps(plan: Plan, options: PlanExecutionOptions): Promise<void> {
		this.updateReadySteps(plan)

		while (this.hasExecutableSteps(plan)) {
			if (this.abortController?.signal.aborted) {
				throw new Error("Plan execution aborted")
			}

			const readySteps = plan.steps.filter((s) => s.status === "ready")
			if (readySteps.length === 0) break

			const maxParallel = options.maxParallel || 1
			const batch = readySteps.slice(0, maxParallel)

			const results = await Promise.allSettled(batch.map((step) => this.executeStep(plan, step, options)))

			for (let i = 0; i < results.length; i++) {
				const result = results[i]!
				const step = batch[i]!

				if (result.status === "rejected") {
					step.status = "failed"
					step.error = result.reason instanceof Error ? result.reason.message : String(result.reason)
					step.completedAt = Date.now()

					this.cancelDependentSteps(plan, step.id)
				}

				options.onPlanUpdate?.(plan)
			}

			this.updateReadySteps(plan)
		}
	}

	private async executeStep(plan: Plan, step: PlanStep, options: PlanExecutionOptions): Promise<PlanStepResult> {
		step.status = "running"
		step.startedAt = Date.now()
		options.onStepStart?.(step)
		options.onPlanUpdate?.(plan)

		this.outputChannel.appendLine(`[PlanEngine] Executing step ${step.index + 1}: ${step.description}`)

		try {
			const dependencyContext = this.buildDependencyContext(plan, step)
			const stepPrompt = this.buildStepPrompt(step, dependencyContext, plan)

			await this.provider.handleModeSwitch(step.mode as UnsafeAny)
			const task = await this.provider.createTask(stepPrompt)
			step.taskId = task.taskId

			const result = await this.waitForTaskCompletion(task)

			step.status = "completed"
			step.result = result
			step.completedAt = Date.now()
			plan.completedSteps++

			const stepResult: PlanStepResult = {
				stepId: step.id,
				status: "completed",
				result,
			}

			options.onStepComplete?.(step, stepResult)
			return stepResult
		} catch (error) {
			step.status = "failed"
			step.error = getErrorMessage(error)
			step.completedAt = Date.now()

			const stepResult: PlanStepResult = {
				stepId: step.id,
				status: "failed",
				error: step.error,
			}

			options.onStepComplete?.(step, stepResult)
			return stepResult
		}
	}

	private waitForTaskCompletion(task: AgentTaskLike): Promise<string> {
		return waitForTaskCompletion(task, {
			timeoutMessage: "Task execution timed out",
			completedMessage: "Task completed",
			noResultMessage: "Task completed (no explicit result)",
		})
	}

	private buildPlanGenerationPrompt(task: string, context: string | undefined, maxSteps: number): string {
		let prompt = PLAN_GENERATION_PROMPT
		prompt += `\n\nMaximum steps: ${maxSteps}`
		if (context) {
			prompt += `\n\nAdditional context:\n${context}`
		}
		prompt += `\n\nUser's task:\n${task}`
		return prompt
	}

	private async callLLMForPlan(prompt: string): Promise<Plan> {
		const task = await this.provider.createTask(
			`You are a planning assistant. Generate a structured JSON plan for the following task. Output ONLY the JSON, no other text.\n\n${prompt}`,
		)

		const planJson = await this.waitForTaskCompletion(task)

		try {
			const parsed = JSON.parse(this.extractJson(planJson))
			return this.buildPlanFromJson(parsed)
		} catch {
			return this.buildDefaultPlan(prompt)
		}
	}

	private extractJson(text: string): string {
		const jsonMatch = text.match(/\{[\s\S]*\}/)
		return jsonMatch ? jsonMatch[0] : text
	}

	private buildPlanFromJson(json: UnsafeAny): Plan {
		const planId = uuidv7()
		const steps: PlanStep[] = (json.steps || []).map((s: UnsafeAny, index: number) => ({
			id: `${planId}-step-${index}`,
			index,
			description: s.description || `Step ${index + 1}`,
			mode: s.mode || "code",
			dependencies: (s.dependencies || []).map((d: number) => `${planId}-step-${d}`),
			status: "pending" as PlanStepStatus,
		}))

		return {
			id: planId,
			title: json.title || "Execution Plan",
			description: json.description || "",
			steps,
			status: "draft",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			totalSteps: steps.length,
			completedSteps: 0,
		}
	}

	private buildDefaultPlan(task: string): Plan {
		const planId = uuidv7()
		return {
			id: planId,
			title: "Default Plan",
			description: task,
			steps: [
				{
					id: `${planId}-step-0`,
					index: 0,
					description: task,
					mode: "code",
					dependencies: [],
					status: "pending",
				},
			],
			status: "draft",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			totalSteps: 1,
			completedSteps: 0,
		}
	}

	private buildStepPrompt(step: PlanStep, dependencyContext: string, plan: Plan): string {
		let prompt = `You are executing step ${step.index + 1} of ${plan.totalSteps} in the plan: "${plan.title}"\n\n`
		prompt += `Step description: ${step.description}\n`

		if (dependencyContext) {
			prompt += `\nResults from previous steps:\n${dependencyContext}\n`
		}

		prompt += `\nPlease complete this step. When done, use attempt_completion to report the result.`
		return prompt
	}

	private buildDependencyContext(plan: Plan, step: PlanStep): string {
		const parts: string[] = []
		for (const depId of step.dependencies) {
			const depStep = plan.steps.find((s) => s.id === depId)
			if (depStep?.result) {
				parts.push(`Step ${depStep.index + 1} (${depStep.description}): ${depStep.result}`)
			}
		}
		return parts.join("\n\n")
	}

	private updateReadySteps(plan: Plan): void {
		for (const step of plan.steps) {
			if (step.status !== "pending") continue

			const depsCompleted = step.dependencies.every((depId) => {
				const dep = plan.steps.find((s) => s.id === depId)
				return dep?.status === "completed" || dep?.status === "skipped"
			})

			if (depsCompleted) {
				step.status = "ready"
			}
		}
	}

	private hasExecutableSteps(plan: Plan): boolean {
		return plan.steps.some((s) => s.status === "ready" || s.status === "pending")
	}

	private cancelDependentSteps(plan: Plan, failedStepId: string): void {
		for (const step of plan.steps) {
			if (step.dependencies.includes(failedStepId) && step.status === "pending") {
				step.status = "cancelled"
				this.cancelDependentSteps(plan, step.id)
			}
		}
	}

	// Public API

	getPlan(planId: string): Plan | undefined {
		return this.plans.get(planId)
	}

	getActivePlan(): Plan | undefined {
		return this.activePlanId ? this.plans.get(this.activePlanId) : undefined
	}

	getAllPlans(): Plan[] {
		return Array.from(this.plans.values())
	}

	pausePlan(): void {
		this.abortController?.abort()
	}

	approvePlan(planId: string): void {
		const plan = this.plans.get(planId)
		if (!plan) throw new Error(`Plan not found: ${planId}`)
		if (plan.status !== "draft") throw new Error(`Plan is not in draft status`)
		plan.status = "approved"
		plan.updatedAt = Date.now()
	}

	updateStep(planId: string, stepId: string, updates: Partial<PlanStep>): void {
		const plan = this.plans.get(planId)
		if (!plan) return

		const step = plan.steps.find((s) => s.id === stepId)
		if (!step) return

		Object.assign(step, updates)
		plan.updatedAt = Date.now()
	}

	reorderSteps(planId: string, stepIds: string[]): void {
		const plan = this.plans.get(planId)
		if (!plan) return

		const reordered: PlanStep[] = []
		for (const id of stepIds) {
			const step = plan.steps.find((s) => s.id === id)
			if (step) {
				step.index = reordered.length
				reordered.push(step)
			}
		}
		plan.steps = reordered
		plan.updatedAt = Date.now()
	}

	deletePlan(planId: string): void {
		if (this.activePlanId === planId) {
			this.pausePlan()
		}
		this.plans.delete(planId)
	}
}
