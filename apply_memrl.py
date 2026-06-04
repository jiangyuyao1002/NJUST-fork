"""
apply_memrl.py  —  Run AFTER: git reset --hard upstream/main
DO NOT run git clean -fd before this script.
"""
import os, sys

REPO = os.path.dirname(os.path.abspath(__file__))

def w(rel, content):
    full = os.path.join(REPO, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    print(f"  WRITE  {rel}")

def patch(rel, old, new):
    full = os.path.join(REPO, rel.replace("/", os.sep))
    with open(full, encoding="utf-8") as f:
        content = f.read()
    if new in content:
        print(f"  SKIP   {rel}")
        return True
    if old not in content:
        print(f"  ERROR  {rel}: anchor not found -> {repr(old[:60])}")
        return False
    with open(full, "w", encoding="utf-8", newline="\n") as f:
        f.write(content.replace(old, new, 1))
    print(f"  PATCH  {rel}")
    return True

print("\n=== Writing MemRL new files ===")

w("src/services/memory/memrl/constants.ts", r"""export const MEMRL_PRIMARY_DIR = ".njust_ai/memories"
export const MEMRL_ROO_DIR = ".roo/session-memories"
export const EPISODIC_FILE = "episodic.json"
export const LTM_FILE = "ltm_rules.json"
export const SIM_THRESHOLD = 0.3
export const TOP_K1 = 20
export const LAMBDA = 0.3
export const TOP_K2 = 5
export const ALPHA = 0.1
export const Q_INIT = 0.5
export const LTM_DISTILL_INTERVAL = 10
export const LTM_DISTILL_BATCH = 20
export const LTM_MAX_RULES = 200
export const STM_MAX_CHARS = 8_000
export const STM_LRU_LIMIT = 2_000
""")

w("src/services/memory/memrl/ShortTermMemory.ts", r"""import { STM_MAX_CHARS } from "./constants"
export interface StmEntry { role: "user" | "assistant"; content: string; timestamp: number }
export class ShortTermMemory {
	private entries: StmEntry[] = []
	private totalChars = 0
	constructor(private readonly maxChars: number = STM_MAX_CHARS) {}
	push(role: StmEntry["role"], content: string): void {
		this.entries.push({ role, content, timestamp: Date.now() })
		this.totalChars += content.length
		while (this.totalChars > this.maxChars && this.entries.length > 1) {
			this.totalChars -= this.entries.shift()!.content.length
		}
	}
	getEntries(): readonly StmEntry[] { return this.entries }
	summarize(): string { return this.entries.map((e) => `${e.role}: ${e.content}`).join("\n") }
	get charCount(): number { return this.totalChars }
	clear(): void { this.entries = []; this.totalChars = 0 }
}
""")

w("src/services/memory/memrl/SessionShortTermManager.ts", r"""import { STM_LRU_LIMIT, STM_MAX_CHARS } from "./constants"
import { ShortTermMemory } from "./ShortTermMemory"
export class SessionShortTermManager {
	private readonly store = new Map<string, ShortTermMemory>()
	constructor(private readonly maxEntries = STM_LRU_LIMIT, private readonly maxCharsPerTask = STM_MAX_CHARS) {}
	get(taskId: string): ShortTermMemory {
		if (this.store.has(taskId)) {
			const stm = this.store.get(taskId)!; this.store.delete(taskId); this.store.set(taskId, stm); return stm
		}
		if (this.store.size >= this.maxEntries) this.store.delete(this.store.keys().next().value as string)
		const stm = new ShortTermMemory(this.maxCharsPerTask); this.store.set(taskId, stm); return stm
	}
	delete(taskId: string): void { this.store.delete(taskId) }
	get size(): number { return this.store.size }
}
""")

w("src/services/memory/memrl/MemoryEmbeddingAdapter.ts", r"""import type { IEmbedder } from "../../code-index/interfaces/embedder"
export class MemoryEmbeddingAdapter {
	constructor(private readonly embedder: IEmbedder) {}
	async embed(text: string): Promise<number[]> {
		try { return (await this.embedder.createEmbeddings([text])).embeddings[0] ?? [] } catch { return [] }
	}
	async embedBatch(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return []
		try { return (await this.embedder.createEmbeddings(texts)).embeddings } catch { return texts.map(() => []) }
	}
	static cosineSim(a: number[], b: number[]): number {
		if (!a.length || !b.length || a.length !== b.length) return 0
		let dot = 0, nA = 0, nB = 0
		for (let i = 0; i < a.length; i++) { const ai = a[i]??0, bi = b[i]??0; dot+=ai*bi; nA+=ai*ai; nB+=bi*bi }
		const d = Math.sqrt(nA) * Math.sqrt(nB); return d === 0 ? 0 : dot / d
	}
	static zScore(values: number[]): number[] {
		if (!values.length) return []
		const mean = values.reduce((s,v)=>s+v,0)/values.length
		const std = Math.sqrt(values.reduce((s,v)=>s+(v-mean)**2,0)/values.length)
		return std === 0 ? values.map(()=>0) : values.map((v)=>(v-mean)/std)
	}
}
""")

w("src/services/memory/memrl/EpisodicMemoryService.ts", r"""import * as fs from "fs/promises"
import * as path from "path"
import { logger } from "../../../shared/logger"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import { MemoryEmbeddingAdapter } from "./MemoryEmbeddingAdapter"
import { ALPHA,EPISODIC_FILE,LAMBDA,LTM_DISTILL_INTERVAL,MEMRL_PRIMARY_DIR,MEMRL_ROO_DIR,Q_INIT,SIM_THRESHOLD,TOP_K1,TOP_K2 } from "./constants"
export interface EpisodicEntry { id:string; intent:string; embedding:number[]; stmSummary:string; qValue:number; updateCount:number; createdAt:number; updatedAt:number }
export interface EpisodicStore { entries:EpisodicEntry[]; totalWrites:number }
export class EpisodicMemoryService {
	private store: EpisodicStore = { entries:[], totalWrites:0 }
	private loaded = false
	constructor(private readonly workspaceDir:string, private readonly embedder:MemoryEmbeddingAdapter, private readonly onDistillTrigger?:()=>void) {}
	private get primaryPath() { return path.join(this.workspaceDir, MEMRL_PRIMARY_DIR, EPISODIC_FILE) }
	private get rooPath() { return path.join(this.workspaceDir, MEMRL_ROO_DIR, EPISODIC_FILE) }
	async load(): Promise<void> {
		if (this.loaded) return
		try { this.store = JSON.parse(await fs.readFile(this.primaryPath,"utf-8")) as EpisodicStore }
		catch { this.store = { entries:[], totalWrites:0 } }
		this.loaded = true
	}
	private async persist() {
		await safeWriteJson(this.primaryPath, this.store)
		await safeWriteJson(this.rooPath, this.store).catch(()=>{})
	}
	async write(intent:string, stmSummary:string, reward:number): Promise<void> {
		await this.load()
		const embedding = await this.embedder.embed(intent)
		const now = Date.now(), id = `ep_${now}_${Math.random().toString(36).slice(2,9)}`
		this.store.entries.push({ id,intent,embedding,stmSummary, qValue:Q_INIT+ALPHA*(reward-Q_INIT), updateCount:1,createdAt:now,updatedAt:now })
		this.store.totalWrites++
		await this.persist()
		if (this.store.totalWrites % LTM_DISTILL_INTERVAL === 0) this.onDistillTrigger?.()
	}
	async retrieve(queryIntent:string): Promise<EpisodicEntry[]> {
		await this.load()
		if (!this.store.entries.length) return []
		const qv = await this.embedder.embed(queryIntent)
		if (!qv.length) return []
		const cands = this.store.entries
			.map((e)=>({ e, sim:MemoryEmbeddingAdapter.cosineSim(qv,e.embedding) }))
			.filter((x)=>x.sim>=SIM_THRESHOLD).sort((a,b)=>b.sim-a.sim).slice(0,TOP_K1)
		if (!cands.length) return []
		const simH = MemoryEmbeddingAdapter.zScore(cands.map((x)=>x.sim))
		const qH = MemoryEmbeddingAdapter.zScore(cands.map((x)=>x.e.qValue))
		return cands.map((x,i)=>({ e:x.e, score:(1-LAMBDA)*(simH[i]??0)+LAMBDA*(qH[i]??0) }))
			.sort((a,b)=>b.score-a.score).slice(0,TOP_K2).map((x)=>x.e)
	}
	getRecent(n:number): EpisodicEntry[] { return [...this.store.entries].sort((a,b)=>b.createdAt-a.createdAt).slice(0,n) }
	get totalWrites() { return this.store.totalWrites }
}
""")

w("src/services/memory/memrl/LongTermMemoryService.ts", r"""import * as fs from "fs/promises"
import * as path from "path"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import type { ApiHandler } from "../../../api"
import { MemoryEmbeddingAdapter } from "./MemoryEmbeddingAdapter"
import type { EpisodicEntry } from "./EpisodicMemoryService"
import { LAMBDA,LTM_DISTILL_BATCH,LTM_FILE,LTM_MAX_RULES,MEMRL_PRIMARY_DIR,MEMRL_ROO_DIR,SIM_THRESHOLD,TOP_K1,TOP_K2 } from "./constants"
export interface RuleCard { id:string; topic:string; rule:string; examples:string[]; confidence:number; useCount:number; createdAt:number; updatedAt:number; embedding:number[] }
export class LongTermMemoryService {
	private store: { rules:RuleCard[] } = { rules:[] }
	private loaded = false
	constructor(private readonly workspaceDir:string, private readonly embedder:MemoryEmbeddingAdapter, private readonly api:ApiHandler) {}
	private get primaryPath() { return path.join(this.workspaceDir, MEMRL_PRIMARY_DIR, LTM_FILE) }
	private get rooPath() { return path.join(this.workspaceDir, MEMRL_ROO_DIR, LTM_FILE) }
	async load(): Promise<void> {
		if (this.loaded) return
		try { this.store = JSON.parse(await fs.readFile(this.primaryPath,"utf-8")) } catch { this.store = { rules:[] } }
		this.loaded = true
	}
	private async persist() { await safeWriteJson(this.primaryPath,this.store); await safeWriteJson(this.rooPath,this.store).catch(()=>{}) }
	async distill(eps:EpisodicEntry[]): Promise<void> {
		await this.load(); if (!eps.length) return
		const prompt = `Extract up to 5 rules as JSON array [{topic,rule,examples:string[],confidence}] from:\n\n`+
			eps.slice(0,LTM_DISTILL_BATCH).map((e,i)=>`${i+1}. Intent:${e.intent}\nSummary:${e.stmSummary}\nQ:${e.qValue.toFixed(2)}`).join("\n\n")
		try {
			let txt=""
			const stream = this.api.createMessage("Output only valid JSON arrays.",[{role:"user",content:[{type:"text",text:prompt}]}])
			for await (const c of stream) if (c.type==="text") txt+=c.text
			const m=txt.match(/\[[\s\S]*\]/); if (!m) return
			for (const r of JSON.parse(m[0]) as Array<{topic:string;rule:string;examples:string[];confidence:number}>) {
				if (r.topic&&r.rule) await this.upsertRule(r)
			}
			if (this.store.rules.length>LTM_MAX_RULES) { this.store.rules.sort((a,b)=>b.confidence-a.confidence); this.store.rules=this.store.rules.slice(0,LTM_MAX_RULES) }
			await this.persist()
		} catch {}
	}
	private async upsertRule(r:{topic:string;rule:string;examples:string[];confidence:number}) {
		const emb=await this.embedder.embed(`${r.topic}: ${r.rule}`)
		for (const ex of this.store.rules) {
			if (MemoryEmbeddingAdapter.cosineSim(emb,ex.embedding)>=0.85) { ex.confidence=Math.max(ex.confidence,r.confidence); ex.updatedAt=Date.now(); return }
		}
		const now=Date.now()
		this.store.rules.push({id:`ltm_${now}_${Math.random().toString(36).slice(2,8)}`,topic:r.topic,rule:r.rule,examples:(r.examples??[]).slice(0,4),confidence:Math.max(0,Math.min(1,r.confidence)),useCount:0,createdAt:now,updatedAt:now,embedding:emb})
	}
	async retrieve(q:string): Promise<RuleCard[]> {
		await this.load(); if (!this.store.rules.length) return []
		const qv=await this.embedder.embed(q); if (!qv.length) return []
		const cands=this.store.rules.map((r)=>({r,sim:MemoryEmbeddingAdapter.cosineSim(qv,r.embedding)})).filter((x)=>x.sim>=SIM_THRESHOLD).sort((a,b)=>b.sim-a.sim).slice(0,TOP_K1)
		if (!cands.length) return []
		const sH=MemoryEmbeddingAdapter.zScore(cands.map((x)=>x.sim)), qH=MemoryEmbeddingAdapter.zScore(cands.map((x)=>x.r.confidence))
		return cands.map((x,i)=>({r:x.r,score:(1-LAMBDA)*(sH[i]??0)+LAMBDA*(qH[i]??0)})).sort((a,b)=>b.score-a.score).slice(0,TOP_K2).map((x)=>x.r)
	}
	async markUsed(ids:string[]): Promise<void> {
		await this.load(); let changed=false
		for (const r of this.store.rules) if (ids.includes(r.id)) { r.useCount++; r.updatedAt=Date.now(); changed=true }
		if (changed) await this.persist()
	}
	getRules(): readonly RuleCard[] { return this.store.rules }
}
""")

w("src/services/memory/memrl/MemoryManager.ts", r"""import type { ApiHandler } from "../../../api"
import type { IEmbedder } from "../../code-index/interfaces/embedder"
import { logger } from "../../../shared/logger"
import { MemoryEmbeddingAdapter } from "./MemoryEmbeddingAdapter"
import { SessionShortTermManager } from "./SessionShortTermManager"
import { EpisodicMemoryService } from "./EpisodicMemoryService"
import { LongTermMemoryService, type RuleCard } from "./LongTermMemoryService"
import type { EpisodicEntry } from "./EpisodicMemoryService"
import { LTM_DISTILL_BATCH } from "./constants"
export interface MemrlBeforeRunResult { episodicHints: string; ltmRules: string }
export class MemoryManager {
	private embedAdapter?: MemoryEmbeddingAdapter
	private episodic?: EpisodicMemoryService
	private ltm?: LongTermMemoryService
	private readonly stmManager = new SessionShortTermManager()
	constructor(public readonly workspaceDir: string) {}
	updateDependencies(api: ApiHandler, embedder?: IEmbedder): void {
		this.embedAdapter = embedder ? new MemoryEmbeddingAdapter(embedder) : new MemoryEmbeddingAdapter(MemoryManager.makeNoopEmbedder())
		this.ltm = new LongTermMemoryService(this.workspaceDir, this.embedAdapter, api)
		this.episodic = new EpisodicMemoryService(this.workspaceDir, this.embedAdapter, ()=>this.triggerDistillation())
	}
	private static makeNoopEmbedder(): IEmbedder {
		return { createEmbeddings: async()=>({embeddings:[]}), validateConfiguration: async()=>({valid:false,error:"no embedder"}), get embedderInfo(){return{name:"openai" as const}} }
	}
	async beforeRun(taskId: string, intent: string): Promise<MemrlBeforeRunResult> {
		this.stmManager.get(taskId).clear()
		if (!this.episodic || !this.ltm) return { episodicHints:"", ltmRules:"" }
		const [eps,cards] = await Promise.all([
			this.episodic.retrieve(intent).catch(():EpisodicEntry[]=>[]),
			this.ltm.retrieve(intent).catch(():RuleCard[]=>[]),
		])
		if (cards.length) this.ltm.markUsed(cards.map((r)=>r.id)).catch(()=>{})
		return { episodicHints: this.fmtEp(eps), ltmRules: this.fmtLtm(cards) }
	}
	afterRun(taskId: string, intent: string, stmSummary: string, reward: number): void {
		logger.debug("MemoryManager",`afterRun reward=${reward}`)
		if (!this.episodic) return
		this.episodic.write(intent,stmSummary,reward).catch((e)=>logger.warn("MemoryManager","afterRun failed",e)).finally(()=>this.stmManager.delete(taskId))
	}
	getStm(taskId: string) { return this.stmManager.get(taskId) }
	private triggerDistillation() {
		if (!this.episodic||!this.ltm) return
		this.ltm.distill(this.episodic.getRecent(LTM_DISTILL_BATCH)).catch(()=>{})
	}
	private fmtEp(es:EpisodicEntry[]): string {
		if (!es.length) return ""
		return "### Relevant Past Episodes\n"+es.map((e,i)=>`${i+1}. [Q=${e.qValue.toFixed(2)}] ${e.intent}\n   ${e.stmSummary.slice(0,200)}`).join("\n\n")
	}
	private fmtLtm(rs:RuleCard[]): string {
		if (!rs.length) return ""
		return "### Learned Rules\n"+rs.map((r,i)=>`${i+1}. **${r.topic}** (${r.confidence.toFixed(2)}): ${r.rule}`).join("\n\n")
	}
}
""")

w("src/services/memory/memrl/index.ts", r"""export { MemoryManager } from "./MemoryManager"
export type { MemrlBeforeRunResult } from "./MemoryManager"
export { EpisodicMemoryService } from "./EpisodicMemoryService"
export type { EpisodicEntry, EpisodicStore } from "./EpisodicMemoryService"
export { LongTermMemoryService } from "./LongTermMemoryService"
export type { RuleCard } from "./LongTermMemoryService"
export { ShortTermMemory } from "./ShortTermMemory"
export type { StmEntry } from "./ShortTermMemory"
export { SessionShortTermManager } from "./SessionShortTermManager"
export { MemoryEmbeddingAdapter } from "./MemoryEmbeddingAdapter"
export * from "./constants"
""")

w("src/core/prompts/sections/memrl-memory.ts", r"""export function getMemrlMemorySection(episodicHints: string, ltmRules: string): string {
	const parts: string[] = []
	if (episodicHints) parts.push(episodicHints)
	if (ltmRules) parts.push(ltmRules)
	if (!parts.length) return ""
	return `\n\n## MemRL Adaptive Memory\n\nThe following memory was retrieved from past task experience:\n\n` + parts.join("\n\n")
}
""")

print("\n=== Patching existing files ===")

patch("knip.json",
    '"services/memory/*",',
    '"services/memory/*",\n\t\t\t\t"services/memory/memrl/*",\n\t\t\t\t"core/prompts/sections/memrl-memory.ts",'
)
patch("src/core/prompts/types.ts",
    "\t/**\n\t * Last user message",
    "\t/** MemRL: episodic hints. */\n\tmemrlEpisodicHints?: string\n"
    "\t/** MemRL: LTM rule cards. */\n\tmemrlLtmRules?: string\n"
    "\t/**\n\t * Last user message"
)
patch("src/core/task/interfaces/ITaskHost.ts",
    'import type { SkillsManager } from "../../../services/skills/SkillsManager"',
    'import type { SkillsManager } from "../../../services/skills/SkillsManager"\n'
    'import type { MemoryManager } from "../../../services/memory/memrl/MemoryManager"'
)
patch("src/core/task/interfaces/ITaskHost.ts",
    "\tgetSkillsManager(): SkillsManager | undefined\n",
    "\tgetSkillsManager(): SkillsManager | undefined\n\n\tgetMemoryManager(cwd?: string): MemoryManager | undefined\n"
)
patch("src/core/webview/ClineProvider.ts",
    'import { SkillsManager } from "../../services/skills/SkillsManager"',
    'import { SkillsManager } from "../../services/skills/SkillsManager"\nimport { MemoryManager } from "../../services/memory/memrl/MemoryManager"'
)
patch("src/core/webview/ClineProvider.ts",
    "\tprotected skillsManager?: SkillsManager\n\tprivate taskCreationCallback",
    "\tprotected skillsManager?: SkillsManager\n\tprivate _memoryManager?: MemoryManager\n\tprivate taskCreationCallback"
)
patch("src/core/webview/ClineProvider.ts",
    "\t\treturn this.skillsManager\n\t}\n\n\t/**\n\t * Gets the CodeIndexManager",
    "\t\treturn this.skillsManager\n\t}\n\n"
    "\tpublic getMemoryManager(cwd?: string): MemoryManager | undefined {\n"
    "\t\tconst resolvedCwd = cwd || getWorkspacePath()\n"
    "\t\tif (!resolvedCwd) return undefined\n"
    "\t\tif (!this._memoryManager || (this._memoryManager as unknown as { workspaceDir: string }).workspaceDir !== resolvedCwd) {\n"
    "\t\t\tthis._memoryManager = new MemoryManager(resolvedCwd)\n"
    "\t\t}\n"
    "\t\treturn this._memoryManager\n"
    "\t}\n\n"
    "\t/**\n\t * Gets the CodeIndexManager"
)
patch("src/core/prompts/system.ts",
    'import { buildBudgetedSessionMemoryPrompt } from "../condense/sessionMemoryCompact"',
    'import { buildBudgetedSessionMemoryPrompt } from "../condense/sessionMemoryCompact"\nimport { getMemrlMemorySection } from "./sections/memrl-memory"'
)
patch("src/core/prompts/system.ts",
    "\tconst sessionMemoryText = settings?.sessionMemory\n\t\t? buildBudgetedSessionMemoryPrompt(settings.sessionMemory)\n\t\t: \"\"",
    "\tconst sessionMemoryText = settings?.sessionMemory\n\t\t? buildBudgetedSessionMemoryPrompt(settings.sessionMemory)\n\t\t: \"\"\n"
    "\tconst memrlMemoryText = getMemrlMemorySection(settings?.memrlEpisodicHints??\"\", settings?.memrlLtmRules??\"\")"
)
patch("src/core/prompts/system.ts",
    '{ name: "sessionMemory", text: sessionMemoryText, priority: 2, required: false },',
    '{ name: "sessionMemory", text: sessionMemoryText, priority: 2, required: false },\n\t\t{ name: "memrlMemory", text: memrlMemoryText, priority: 2, required: false },'
)
patch("src/core/prompts/system.ts",
    '\t\tsec("sessionMemory"),\n\t].filter',
    '\t\tsec("sessionMemory"),\n\t\tsec("memrlMemory"),\n\t].filter'
)
patch("src/services/code-index/manager.ts",
    "\t/**\n\t * Cleans up the manager instance.\n\t */\n\tpublic dispose()",
    "\tpublic tryCreateEmbedder(): import(\"./interfaces/embedder\").IEmbedder | undefined {\n"
    "\t\ttry { return this._serviceFactory?.createEmbedder() } catch { return undefined }\n"
    "\t}\n\n"
    "\t/**\n\t * Cleans up the manager instance.\n\t */\n\tpublic dispose()"
)
patch("src/core/task/TaskRequestBuilder.ts",
    "\t\t\t\t\tlastUserMessageForCangjieHint: lastUserForCangjie,\n\t\t\t\t},",
    "\t\t\t\t\tlastUserMessageForCangjieHint: lastUserForCangjie,\n"
    "\t\t\t\t\tmemrlEpisodicHints: this.task.memrlEpisodicHints,\n"
    "\t\t\t\t\tmemrlLtmRules: this.task.memrlLtmRules,\n"
    "\t\t\t\t},"
)

# Task.ts — fields
patch("src/core/task/Task.ts",
    "\tpublic cachedToolDefinitions?: { mode: string; tools: UnsafeAny[]; time: number }\n\n\t/** Task mode.",
    "\tpublic cachedToolDefinitions?: { mode: string; tools: UnsafeAny[]; time: number }\n\n"
    "\tpublic memrlEpisodicHints: string = \"\"\n"
    "\tpublic memrlLtmRules: string = \"\"\n\n"
    "\t/** Task mode."
)
# Task.ts — initiateCloudAgentLoop wrap
patch("src/core/task/Task.ts",
    "\t\tconst { CloudAgentOrchestrator } = await import(\"./CloudAgentOrchestrator\")\n"
    "\t\tconst orchestrator = new CloudAgentOrchestrator(host)\n"
    "\t\tawait orchestrator.run(userMessage, images)\n\t}",
    "\t\tconst { CloudAgentOrchestrator } = await import(\"./CloudAgentOrchestrator\")\n"
    "\t\tconst orchestrator = new CloudAgentOrchestrator(host)\n\n"
    "\t\tconst memrlProv = this.hostRef.deref()\n"
    "\t\tconst memMgr = memrlProv?.getMemoryManager(this.cwd)\n"
    "\t\tconst memrlIntent = userMessage.slice(0,500)||this.taskId\n"
    "\t\tif (memMgr) {\n"
    "\t\t\tconst emb = memrlProv&&\"getCurrentWorkspaceCodeIndexManager\"in memrlProv\n"
    "\t\t\t\t?(memrlProv as import(\"../../core/webview/ClineProvider\").ClineProvider).getCurrentWorkspaceCodeIndexManager()?.tryCreateEmbedder()\n"
    "\t\t\t\t:undefined\n"
    "\t\t\tmemMgr.updateDependencies(this.api,emb)\n"
    "\t\t\ttry {\n"
    "\t\t\t\tconst {episodicHints,ltmRules} = await Promise.race([\n"
    "\t\t\t\t\tmemMgr.beforeRun(this.taskId,memrlIntent),\n"
    "\t\t\t\t\tnew Promise<{episodicHints:string;ltmRules:string}>((_,rej)=>setTimeout(()=>rej(new Error(\"MemRL timeout\")),3000)),\n"
    "\t\t\t\t])\n"
    "\t\t\t\tthis.memrlEpisodicHints=episodicHints; this.memrlLtmRules=ltmRules\n"
    "\t\t\t\tthis.requestBuilder.clearCache()\n"
    "\t\t\t} catch { /* non-blocking */ }\n"
    "\t\t}\n"
    "\t\ttry {\n"
    "\t\t\tawait orchestrator.run(userMessage,images)\n"
    "\t\t} finally {\n"
    "\t\t\tif (memMgr) memMgr.afterRun(this.taskId,memrlIntent,memMgr.getStm(this.taskId).summarize(),this.taskCompleted?1.0:0.0)\n"
    "\t\t}\n\t}"
)
# Task.ts — initiateTaskLoop
patch("src/core/task/Task.ts",
    "\t\t})\n\n\t\tlet nextUserContent = userContent\n\t\tlet includeFileDetails = true\n\n\t\tthis.emit(NJUST_AIEventName.TaskStarted)\n\n\t\twhile (!this.abort && !this.taskCompleted) {",
    "\t\t})\n\n"
    "\t\tconst memMgr2 = provider?.getMemoryManager(this.cwd)\n"
    "\t\tconst memrlIntent2 = userContent.filter((b):b is{type:\"text\";text:string}=>b.type===\"text\"&&\"text\"in b).map((b)=>b.text).join(\" \").trim().slice(0,500)||this.taskId\n"
    "\t\tif (memMgr2) {\n"
    "\t\t\tconst emb2 = provider&&\"getCurrentWorkspaceCodeIndexManager\"in provider\n"
    "\t\t\t\t?(provider as import(\"../../core/webview/ClineProvider\").ClineProvider).getCurrentWorkspaceCodeIndexManager()?.tryCreateEmbedder()\n"
    "\t\t\t\t:undefined\n"
    "\t\t\tmemMgr2.updateDependencies(this.api,emb2)\n"
    "\t\t\ttry {\n"
    "\t\t\t\tconst {episodicHints,ltmRules} = await Promise.race([\n"
    "\t\t\t\t\tmemMgr2.beforeRun(this.taskId,memrlIntent2),\n"
    "\t\t\t\t\tnew Promise<{episodicHints:string;ltmRules:string}>((_,rej)=>setTimeout(()=>rej(new Error(\"MemRL timeout\")),3000)),\n"
    "\t\t\t\t])\n"
    "\t\t\t\tthis.memrlEpisodicHints=episodicHints; this.memrlLtmRules=ltmRules\n"
    "\t\t\t\tthis.requestBuilder.clearCache()\n"
    "\t\t\t} catch { /* non-blocking */ }\n"
    "\t\t}\n\n"
    "\t\tlet nextUserContent = userContent\n\t\tlet includeFileDetails = true\n\n\t\tthis.emit(NJUST_AIEventName.TaskStarted)\n\n\t\ttry {\n\t\t\twhile (!this.abort && !this.taskCompleted) {"
)
patch("src/core/task/Task.ts",
    "\t\t\tnextUserContent = [{ type: \"text\", text: formatResponse.noToolsUsed() }]\n\t\t}\n\t}\n\n\tpublic async recursivelyMakeClineRequests(",
    "\t\t\t\tnextUserContent = [{ type: \"text\", text: formatResponse.noToolsUsed() }]\n"
    "\t\t\t}\n\t\t} finally {\n"
    "\t\t\tif (memMgr2) memMgr2.afterRun(this.taskId,memrlIntent2,memMgr2.getStm(this.taskId).summarize(),this.taskCompleted?1.0:0.0)\n"
    "\t\t}\n\t}\n\n\tpublic async recursivelyMakeClineRequests("
)

print("\n=== Verifying ===")
errors = 0
for rel, kw in [
    ("src/services/memory/memrl/MemoryManager.ts","beforeRun"),
    ("src/core/prompts/sections/memrl-memory.ts","getMemrlMemorySection"),
    ("src/core/task/Task.ts","memrlEpisodicHints"),
    ("src/core/task/Task.ts","MemRL timeout"),
    ("src/core/task/TaskRequestBuilder.ts","memrlEpisodicHints"),
    ("src/core/webview/ClineProvider.ts","getMemoryManager"),
    ("src/core/prompts/system.ts","getMemrlMemorySection"),
    ("src/core/prompts/types.ts","memrlEpisodicHints"),
    ("src/core/task/interfaces/ITaskHost.ts","getMemoryManager"),
    ("src/services/code-index/manager.ts","tryCreateEmbedder"),
]:
    full = os.path.join(REPO, rel.replace("/", os.sep))
    ok = kw in open(full, encoding="utf-8").read()
    print(f"  {'OK  ' if ok else 'FAIL'} {rel} [{kw}]")
    if not ok: errors += 1

raw = open(os.path.join(REPO,"src","core","task","Task.ts"),"rb").read()
nulls = raw.count(b"\x00")
print(f"  {'OK  ' if nulls==0 else 'FAIL'} Task.ts null bytes: {nulls}")
if nulls: errors += 1

print(f"\n{'ALL DONE - no errors' if errors==0 else f'FAILED: {errors} errors'}")
sys.exit(0 if errors==0 else 1)
