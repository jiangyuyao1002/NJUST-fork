import type { ApiHandler } from "../../../api"
import type { IEmbedder } from "../../code-index/interfaces/embedder"
import { logger } from "../../../shared/logger"
import { MemoryEmbeddingAdapter } from "./MemoryEmbeddingAdapter"
import { SessionShortTermManager } from "./SessionShortTermManager"
import { EpisodicMemoryService } from "./EpisodicMemoryService"
import { LongTermMemoryService, type RuleCard } from "./LongTermMemoryService"
import type { EpisodicEntry } from "./EpisodicMemoryService"
import { LTM_DISTILL_BATCH } from "./constants"
export interface MemrlBeforeRunResult {
	episodicHints: string
	ltmRules: string
}
export class MemoryManager {
	private embedAdapter?: MemoryEmbeddingAdapter
	private episodic?: EpisodicMemoryService
	private ltm?: LongTermMemoryService
	private readonly stmManager = new SessionShortTermManager()
	constructor(public readonly workspaceDir: string) {}
	updateDependencies(api: ApiHandler, embedder?: IEmbedder): void {
		this.embedAdapter = embedder
			? new MemoryEmbeddingAdapter(embedder)
			: new MemoryEmbeddingAdapter(MemoryManager.makeNoopEmbedder())
		this.ltm = new LongTermMemoryService(this.workspaceDir, this.embedAdapter, api)
		this.episodic = new EpisodicMemoryService(this.workspaceDir, this.embedAdapter, () =>
			this.triggerDistillation(),
		)
	}
	private static makeNoopEmbedder(): IEmbedder {
		return {
			createEmbeddings: () => Promise.resolve({ embeddings: [] }),
			validateConfiguration: () => Promise.resolve({ valid: false, error: "no embedder" }),
			get embedderInfo() {
				return { name: "openai" as const }
			},
		}
	}
	async beforeRun(taskId: string, intent: string): Promise<MemrlBeforeRunResult> {
		this.stmManager.get(taskId).clear()
		if (!this.episodic || !this.ltm) return { episodicHints: "", ltmRules: "" }
		const [eps, cards] = await Promise.all([
			this.episodic.retrieve(intent).catch((): EpisodicEntry[] => []),
			this.ltm.retrieve(intent).catch((): RuleCard[] => []),
		])
		if (cards.length) this.ltm.markUsed(cards.map((r) => r.id)).catch(() => {})
		return { episodicHints: this.fmtEp(eps), ltmRules: this.fmtLtm(cards) }
	}
	afterRun(taskId: string, intent: string, stmSummary: string, reward: number): void {
		logger.info(
			"MemoryManager",
			`afterRun reward=${reward} hasEpisodic=${!!this.episodic} stmLen=${stmSummary.length}`,
		)
		if (!this.episodic) return
		this.episodic
			.write(intent, stmSummary, reward)
			.catch((e) => logger.warn("MemoryManager", "afterRun failed", e))
			.finally(() => this.stmManager.delete(taskId))
	}
	getStm(taskId: string) {
		return this.stmManager.get(taskId)
	}
	private triggerDistillation() {
		if (!this.episodic || !this.ltm) return
		this.ltm.distill(this.episodic.getRecent(LTM_DISTILL_BATCH)).catch(() => {})
	}
	private fmtEp(es: EpisodicEntry[]): string {
		if (!es.length) return ""
		return (
			"### Relevant Past Episodes\n" +
			es
				.map((e, i) => `${i + 1}. [Q=${e.qValue.toFixed(2)}] ${e.intent}\n   ${e.stmSummary.slice(0, 200)}`)
				.join("\n\n")
		)
	}
	private fmtLtm(rs: RuleCard[]): string {
		if (!rs.length) return ""
		return (
			"### Learned Rules\n" +
			rs.map((r, i) => `${i + 1}. **${r.topic}** (${r.confidence.toFixed(2)}): ${r.rule}`).join("\n\n")
		)
	}
}
