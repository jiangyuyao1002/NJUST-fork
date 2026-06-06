import * as fs from "fs/promises"
import * as path from "path"
import type { ApiHandler } from "../../../api"
import { MemoryEmbeddingAdapter } from "./MemoryEmbeddingAdapter"
import type { EpisodicEntry } from "./EpisodicMemoryService"
import {
	LAMBDA,
	LTM_DISTILL_BATCH,
	LTM_FILE,
	LTM_MAX_RULES,
	MEMRL_PRIMARY_DIR,
	MEMRL_ROO_DIR,
	SIM_THRESHOLD,
	TOP_K1,
	TOP_K2,
} from "./constants"
export interface RuleCard {
	id: string
	topic: string
	rule: string
	examples: string[]
	confidence: number
	useCount: number
	createdAt: number
	updatedAt: number
	embedding: number[]
}
export class LongTermMemoryService {
	private store: { rules: RuleCard[] } = { rules: [] }
	private loaded = false
	constructor(
		private readonly workspaceDir: string,
		private readonly embedder: MemoryEmbeddingAdapter,
		private readonly api: ApiHandler,
	) {}
	private get primaryPath() {
		return path.join(this.workspaceDir, MEMRL_PRIMARY_DIR, LTM_FILE)
	}
	private get rooPath() {
		return path.join(this.workspaceDir, MEMRL_ROO_DIR, LTM_FILE)
	}
	async load(): Promise<void> {
		if (this.loaded) return
		try {
			this.store = JSON.parse(await fs.readFile(this.primaryPath, "utf-8"))
		} catch {
			this.store = { rules: [] }
		}
		this.loaded = true
	}
	private async persist() {
		const json = JSON.stringify(this.store)
		await fs.mkdir(path.dirname(this.primaryPath), { recursive: true })
		await fs.writeFile(this.primaryPath, json, "utf-8")
		await fs.mkdir(path.dirname(this.rooPath), { recursive: true }).catch(() => {})
		await fs.writeFile(this.rooPath, json, "utf-8").catch(() => {})
	}
	async distill(eps: EpisodicEntry[]): Promise<void> {
		await this.load()
		if (!eps.length) return
		const prompt =
			`Extract up to 5 rules as JSON array [{topic,rule,examples:string[],confidence}] from:\n\n` +
			eps
				.slice(0, LTM_DISTILL_BATCH)
				.map((e, i) => `${i + 1}. Intent:${e.intent}\nSummary:${e.stmSummary}\nQ:${e.qValue.toFixed(2)}`)
				.join("\n\n")
		try {
			let txt = ""
			const stream = this.api.createMessage("Output only valid JSON arrays.", [
				{ role: "user", content: [{ type: "text", text: prompt }] },
			])
			for await (const c of stream) if (c.type === "text") txt += c.text
			const m = txt.match(/\[[\s\S]*\]/)
			if (!m) return
			for (const r of JSON.parse(m[0]) as Array<{
				topic: string
				rule: string
				examples: string[]
				confidence: number
			}>) {
				if (r.topic && r.rule) await this.upsertRule(r)
			}
			if (this.store.rules.length > LTM_MAX_RULES) {
				this.store.rules.sort((a, b) => b.confidence - a.confidence)
				this.store.rules = this.store.rules.slice(0, LTM_MAX_RULES)
			}
			await this.persist()
		} catch {}
	}
	private async upsertRule(r: { topic: string; rule: string; examples: string[]; confidence: number }) {
		const emb = await this.embedder.embed(`${r.topic}: ${r.rule}`)
		for (const ex of this.store.rules) {
			if (MemoryEmbeddingAdapter.cosineSim(emb, ex.embedding) >= 0.85) {
				ex.confidence = Math.max(ex.confidence, r.confidence)
				ex.updatedAt = Date.now()
				return
			}
		}
		const now = Date.now()
		this.store.rules.push({
			id: `ltm_${now}_${Math.random().toString(36).slice(2, 8)}`,
			topic: r.topic,
			rule: r.rule,
			examples: (r.examples ?? []).slice(0, 4),
			confidence: Math.max(0, Math.min(1, r.confidence)),
			useCount: 0,
			createdAt: now,
			updatedAt: now,
			embedding: emb,
		})
	}
	async retrieve(q: string): Promise<RuleCard[]> {
		await this.load()
		if (!this.store.rules.length) return []
		const qv = await this.embedder.embed(q)
		if (!qv.length) return []
		const cands = this.store.rules
			.map((r) => ({ r, sim: MemoryEmbeddingAdapter.cosineSim(qv, r.embedding) }))
			.filter((x) => x.sim >= SIM_THRESHOLD)
			.sort((a, b) => b.sim - a.sim)
			.slice(0, TOP_K1)
		if (!cands.length) return []
		const sH = MemoryEmbeddingAdapter.zScore(cands.map((x) => x.sim)),
			qH = MemoryEmbeddingAdapter.zScore(cands.map((x) => x.r.confidence))
		return cands
			.map((x, i) => ({ r: x.r, score: (1 - LAMBDA) * (sH[i] ?? 0) + LAMBDA * (qH[i] ?? 0) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, TOP_K2)
			.map((x) => x.r)
	}
	async markUsed(ids: string[]): Promise<void> {
		await this.load()
		let changed = false
		for (const r of this.store.rules)
			if (ids.includes(r.id)) {
				r.useCount++
				r.updatedAt = Date.now()
				changed = true
			}
		if (changed) await this.persist()
	}
	getRules(): readonly RuleCard[] {
		return this.store.rules
	}
}
