import * as fs from "fs/promises"
import * as path from "path"
import { logger } from "../../../shared/logger"
import { MemoryEmbeddingAdapter } from "./MemoryEmbeddingAdapter"
import {
	ALPHA,
	EPISODIC_FILE,
	LAMBDA,
	LTM_DISTILL_INTERVAL,
	MEMRL_PRIMARY_DIR,
	MEMRL_ROO_DIR,
	Q_INIT,
	SIM_THRESHOLD,
	TOP_K1,
	TOP_K2,
} from "./constants"
export interface EpisodicEntry {
	id: string
	intent: string
	embedding: number[]
	stmSummary: string
	qValue: number
	updateCount: number
	createdAt: number
	updatedAt: number
}
export interface EpisodicStore {
	entries: EpisodicEntry[]
	totalWrites: number
}
export class EpisodicMemoryService {
	private store: EpisodicStore = { entries: [], totalWrites: 0 }
	private loaded = false
	constructor(
		private readonly workspaceDir: string,
		private readonly embedder: MemoryEmbeddingAdapter,
		private readonly onDistillTrigger?: () => void,
	) {}
	private get primaryPath() {
		return path.join(this.workspaceDir, MEMRL_PRIMARY_DIR, EPISODIC_FILE)
	}
	private get rooPath() {
		return path.join(this.workspaceDir, MEMRL_ROO_DIR, EPISODIC_FILE)
	}
	async load(): Promise<void> {
		if (this.loaded) return
		try {
			this.store = JSON.parse(await fs.readFile(this.primaryPath, "utf-8")) as EpisodicStore
		} catch {
			this.store = { entries: [], totalWrites: 0 }
		}
		this.loaded = true
	}
	private async persist() {
		const json = JSON.stringify(this.store)
		await fs.mkdir(path.dirname(this.primaryPath), { recursive: true })
		await fs.writeFile(this.primaryPath, json, "utf-8")
		// Mirror to roo path (best-effort, ignore errors)
		await fs.mkdir(path.dirname(this.rooPath), { recursive: true }).catch(() => {})
		await fs.writeFile(this.rooPath, json, "utf-8").catch(() => {})
	}
	async write(intent: string, stmSummary: string, reward: number): Promise<void> {
		logger.info("EpisodicMemory", `write() start loaded=${this.loaded} path=${this.primaryPath}`)
		await this.load()
		logger.info(
			"EpisodicMemory",
			`write() after load totalWrites=${this.store.totalWrites} entries=${this.store.entries.length}`,
		)
		const embedding = await this.embedder.embed(intent)
		const now = Date.now(),
			id = `ep_${now}_${Math.random().toString(36).slice(2, 9)}`
		this.store.entries.push({
			id,
			intent,
			embedding,
			stmSummary,
			qValue: Q_INIT + ALPHA * (reward - Q_INIT),
			updateCount: 1,
			createdAt: now,
			updatedAt: now,
		})
		this.store.totalWrites++
		logger.info("EpisodicMemory", `write() persisting totalWrites=${this.store.totalWrites}`)
		await this.persist()
		logger.info("EpisodicMemory", `write() done id=${id}`)
		if (this.store.totalWrites % LTM_DISTILL_INTERVAL === 0) this.onDistillTrigger?.()
	}
	async retrieve(queryIntent: string): Promise<EpisodicEntry[]> {
		await this.load()
		if (!this.store.entries.length) return []
		const qv = await this.embedder.embed(queryIntent)
		if (!qv.length) return []
		const cands = this.store.entries
			.map((e) => ({ e, sim: MemoryEmbeddingAdapter.cosineSim(qv, e.embedding) }))
			.filter((x) => x.sim >= SIM_THRESHOLD)
			.sort((a, b) => b.sim - a.sim)
			.slice(0, TOP_K1)
		if (!cands.length) return []
		const simH = MemoryEmbeddingAdapter.zScore(cands.map((x) => x.sim))
		const qH = MemoryEmbeddingAdapter.zScore(cands.map((x) => x.e.qValue))
		return cands
			.map((x, i) => ({ e: x.e, score: (1 - LAMBDA) * (simH[i] ?? 0) + LAMBDA * (qH[i] ?? 0) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, TOP_K2)
			.map((x) => x.e)
	}
	getRecent(n: number): EpisodicEntry[] {
		return [...this.store.entries].sort((a, b) => b.createdAt - a.createdAt).slice(0, n)
	}
	get totalWrites() {
		return this.store.totalWrites
	}
}
