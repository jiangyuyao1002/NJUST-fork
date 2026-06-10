import { ToolDependencyGraph } from "./ToolDependencyGraph"
import type { AdaptiveConcurrencyController } from "./AdaptiveConcurrencyController"
import type { ToolCategory, ToolExecutionScheduler } from "../task/ToolExecutionOrchestrator"

export type ConcurrentToolExecutorOptions = {
	maxConcurrency?: number
	concurrencyController?: AdaptiveConcurrencyController
	scheduler?: ToolExecutionScheduler
}

export type ConcurrentRunContext = {
	siblingAbortController: AbortController
	signal: AbortSignal
}

export type AbortStrategy = "failFast" | "continueOnError" | "transitiveAbort"

export type ConcurrentRunOptions = {
	failFast?: boolean
	abortStrategy?: AbortStrategy
	dependencyGraph?: ToolDependencyGraph
	itemToolNames?: Map<number, string>
	itemCategories?: Map<number, ToolCategory>
}

const DEFAULT_MAX_CONCURRENCY = 10

export class ConcurrentToolExecutor {
	private readonly maxConcurrency: number
	private readonly concurrencyController?: AdaptiveConcurrencyController
	private readonly scheduler?: ToolExecutionScheduler

	constructor(opts?: ConcurrentToolExecutorOptions) {
		this.maxConcurrency = Math.max(1, opts?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)
		this.concurrencyController = opts?.concurrencyController
		this.scheduler = opts?.scheduler
	}

	private resolveAbortOnError(opts?: ConcurrentRunOptions) {
		const strategy = opts?.abortStrategy
		if (strategy === "continueOnError")
			return { shouldAbortOnError: false, continueOnError: true, useTransitiveAbort: false }
		if (strategy === "transitiveAbort") {
			const hasGraph = !!opts?.dependencyGraph && !opts.dependencyGraph.isEmpty()
			return { shouldAbortOnError: !hasGraph, continueOnError: false, useTransitiveAbort: hasGraph }
		}
		if (strategy === "failFast")
			return { shouldAbortOnError: true, continueOnError: false, useTransitiveAbort: false }
		return { shouldAbortOnError: opts?.failFast === true, continueOnError: false, useTransitiveAbort: false }
	}

	async run<T>(
		items: T[],
		fn: (item: T, index: number, ctx: ConcurrentRunContext) => Promise<void>,
		runOpts?: ConcurrentRunOptions,
	): Promise<void> {
		if (items.length === 0) return
		const concurrencyLimit = this.concurrencyController?.getEffectiveMaxConcurrency() ?? this.maxConcurrency
		const workerCount = Math.max(1, Math.min(this.maxConcurrency, concurrencyLimit, items.length))
		let cursor = 0
		const errors: { index: number; error: unknown }[] = []
		const siblingAbortController = new AbortController()
		const { shouldAbortOnError, continueOnError, useTransitiveAbort } = this.resolveAbortOnError(runOpts)
		const abortedIndices = new Set<number>()
		const itemToolNames = runOpts?.itemToolNames
		const itemCategories = runOpts?.itemCategories
		const dependencyGraph = runOpts?.dependencyGraph
		const workerTasks = new Array<Promise<void>>(workerCount)
		const itemIndexByToolName = new Map<string, number>()

		if (useTransitiveAbort && itemToolNames) {
			for (const [itemIdx, toolName] of itemToolNames.entries()) {
				if (!itemIndexByToolName.has(toolName)) {
					itemIndexByToolName.set(toolName, itemIdx)
				}
			}
		}

		const recordDependencyAbort = (failedIndex: number): void => {
			if (!useTransitiveAbort || !dependencyGraph || !itemToolNames) return
			const failedToolName = itemToolNames.get(failedIndex)
			if (!failedToolName) return
			const dependents = dependencyGraph.getTransitiveDependents(failedToolName)
			for (const dependentToolName of dependents) {
				const dependentIndex = itemIndexByToolName.get(dependentToolName)
				if (dependentIndex !== undefined) {
					abortedIndices.add(dependentIndex)
				}
			}
		}

		const runItem = async (idx: number): Promise<void> => {
			if (useTransitiveAbort && abortedIndices.has(idx)) {
				errors.push({ index: idx, error: new Error("Skipped: dependency failed (transitive abort)") })
				return
			}

			const category = itemCategories?.get(idx)
			let schedulerAcquired = false
			let concurrencyAcquired = false
			if (category && this.scheduler) {
				await this.scheduler.acquire(category)
				schedulerAcquired = true
			}
			// Lock ordering invariant (scheduler → concurrency → scheduler):
			//   1. Acquire scheduler first
			//   2. Release scheduler before blocking on concurrency controller
			//   3. Acquire concurrency controller
			//   4. Re-acquire scheduler
			//   5. Release in reverse: scheduler → concurrency
			// This order prevents deadlock: no code path holds concurrency
			// while waiting for scheduler, and vice versa never overlaps.
			// DO NOT alter without auditing all callers for circular wait.
			if (schedulerAcquired && category && this.concurrencyController) {
				this.scheduler?.release(category)
				schedulerAcquired = false
			}
			if (category && this.concurrencyController) {
				await this.concurrencyController.acquire(category)
				concurrencyAcquired = true
			}
			// Re-acquire scheduler after concurrency slot is secured.
			if (concurrencyAcquired && category && this.scheduler) {
				await this.scheduler.acquire(category)
				schedulerAcquired = true
			}

			try {
				await fn(items[idx]!, idx, { siblingAbortController, signal: siblingAbortController.signal })
			} catch (err) {
				errors.push({ index: idx, error: err })
				recordDependencyAbort(idx)
				if (shouldAbortOnError && !siblingAbortController.signal.aborted) {
					siblingAbortController.abort(err)
				}
			} finally {
				if (schedulerAcquired) this.scheduler!.release(category!)
				if (concurrencyAcquired) this.concurrencyController!.release(category!)
			}
		}

		const nextIndex = (): number => {
			const idx = cursor
			cursor += 1
			return idx
		}

		for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
			workerTasks[workerIndex] = (async () => {
				while (true) {
					if (siblingAbortController.signal.aborted && shouldAbortOnError) return
					const idx = nextIndex()
					if (idx >= items.length) return
					await runItem(idx)
				}
			})()
		}

		await Promise.allSettled(workerTasks)

		if (errors.length > 0) {
			const messages = errors.map(
				(e) => `[item ${e.index}] ${e.error instanceof Error ? e.error.message : String(e.error)}`,
			)
			if (continueOnError) {
				throw new Error(
					`ConcurrentToolExecutor (continueOnError): ${errors.length} task(s) failed:\n${messages.join("\n")}`,
				)
			}
			throw new Error(`ConcurrentToolExecutor: ${errors.length} task(s) failed:\n${messages.join("\n")}`)
		}
	}
}
