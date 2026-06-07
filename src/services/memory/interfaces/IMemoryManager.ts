import type { ApiHandler } from "../../../api"
import type { IEmbedder } from "../../code-index/interfaces/embedder"
import type { IShortTermMemory } from "./IShortTermMemory"

export interface MemrlBeforeRunResult {
	/** Formatted episodic hints for prompt injection */
	episodicHints: string
	/** Formatted LTM rule bullets for prompt injection */
	ltmRules: string
}

/**
 * Public surface of MemoryManager.
 */
export interface IMemoryManager {
	readonly workspaceDir: string
	updateDependencies(api: ApiHandler, embedder?: IEmbedder): void
	beforeRun(taskId: string, intent: string): Promise<MemrlBeforeRunResult>
	afterRun(taskId: string, intent: string, stmSummary: string, reward: number): void
	getStm(taskId: string): IShortTermMemory
	dispose(): void
}
