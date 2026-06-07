/**
 * Model-fingerprint validation tests.
 *
 * Verifies that both episodic and LTM stores AUTO-DISCARD persisted vectors when
 * the embedding model (fingerprint) changes, and KEEP them when it is unchanged.
 *
 * Hermetic: `currentEmbedFingerprint` is mocked so we control the "current" model,
 * and store files are seeded directly on disk (no safeWriteJson involved).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"
import os from "os"

import { EpisodicMemoryService, type EpisodicEntry } from "../EpisodicMemoryService"
import { LongTermMemoryService, type RuleCard } from "../LongTermMemoryService"
import { MemoryEmbeddingAdapter } from "../MemoryEmbeddingAdapter"
import type { IEmbedder } from "../../../code-index/interfaces/embedder"
import type { ApiHandler } from "../../../../api"
import { MEMRL_PRIMARY_DIR, EPISODIC_FILE, LTM_FILE } from "../constants"
import { currentEmbedFingerprint } from "../memory-embedder"

// Mock the embedder factory module so we can drive the "current" fingerprint.
vi.mock("../memory-embedder", () => ({
	currentEmbedFingerprint: vi.fn(() => "model-default"),
	createMemoryEmbedder: vi.fn(() => undefined),
}))

function makeAdapter(): MemoryEmbeddingAdapter {
	const embedder: IEmbedder = {
		createEmbeddings: vi.fn().mockImplementation(async (texts: string[]) => ({
			embeddings: texts.map(() => [0.6, 0.8]),
		})),
		validateConfiguration: vi.fn().mockResolvedValue({ valid: true }),
		get embedderInfo() {
			return { name: "openai" as const }
		},
	}
	return new MemoryEmbeddingAdapter(embedder)
}

function makeApi(): ApiHandler {
	return {
		createMessage: vi.fn().mockReturnValue((async function* () {})()),
		getModel: vi.fn().mockReturnValue({ id: "test", info: {} }),
	} as unknown as ApiHandler
}

function makeEntry(): EpisodicEntry {
	const now = Date.now()
	return {
		id: "ep_seed",
		intent: "seeded intent",
		embedding: [0.6, 0.8],
		stmSummary: "seeded summary",
		qValue: 0.8,
		updateCount: 1,
		createdAt: now,
		updatedAt: now,
	}
}

function makeRule(): RuleCard {
	const now = Date.now()
	return {
		id: "ltm_seed",
		topic: "seeded topic",
		rule: "seeded rule",
		examples: [],
		confidence: 0.8,
		useCount: 0,
		createdAt: now,
		updatedAt: now,
		embedding: [0.6, 0.8],
	}
}

async function seedEpisodic(dir: string, fingerprint: string | undefined): Promise<void> {
	const p = path.join(dir, MEMRL_PRIMARY_DIR, EPISODIC_FILE)
	await fs.mkdir(path.dirname(p), { recursive: true })
	await fs.writeFile(
		p,
		JSON.stringify({ entries: [makeEntry()], totalWrites: 1, embedFingerprint: fingerprint }),
		"utf-8",
	)
}

async function seedLtm(dir: string, fingerprint: string | undefined): Promise<void> {
	const p = path.join(dir, MEMRL_PRIMARY_DIR, LTM_FILE)
	await fs.mkdir(path.dirname(p), { recursive: true })
	await fs.writeFile(p, JSON.stringify({ rules: [makeRule()], embedFingerprint: fingerprint }), "utf-8")
}

describe("MemRL model-fingerprint validation", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memrl-fp-"))
		vi.mocked(currentEmbedFingerprint).mockReturnValue("model-default")
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	// ── Episodic ────────────────────────────────────────────────────────────────

	it("episodic: discards store when the embedding model changes", async () => {
		await seedEpisodic(tmpDir, "model-OLD")
		vi.mocked(currentEmbedFingerprint).mockReturnValue("model-NEW")

		const svc = new EpisodicMemoryService(tmpDir, makeAdapter())
		await svc.load()

		expect(svc.totalWrites).toBe(0)
		expect(await svc.retrieve("seeded intent")).toHaveLength(0)
	})

	it("episodic: discards a legacy store with no fingerprint", async () => {
		await seedEpisodic(tmpDir, undefined)
		vi.mocked(currentEmbedFingerprint).mockReturnValue("model-NEW")

		const svc = new EpisodicMemoryService(tmpDir, makeAdapter())
		await svc.load()

		expect(svc.totalWrites).toBe(0)
	})

	it("episodic: keeps store when the embedding model is unchanged", async () => {
		await seedEpisodic(tmpDir, "model-SAME")
		vi.mocked(currentEmbedFingerprint).mockReturnValue("model-SAME")

		const svc = new EpisodicMemoryService(tmpDir, makeAdapter())
		await svc.load()

		expect(svc.totalWrites).toBe(1)
		expect((await svc.retrieve("seeded intent")).length).toBeGreaterThan(0)
	})

	// ── LTM ───────────────────────────────────────────────────────────────────

	it("ltm: discards rules when the embedding model changes", async () => {
		await seedLtm(tmpDir, "model-OLD")
		vi.mocked(currentEmbedFingerprint).mockReturnValue("model-NEW")

		const svc = new LongTermMemoryService(tmpDir, makeAdapter(), makeApi())
		await svc.load()

		expect(svc.getRules()).toHaveLength(0)
	})

	it("ltm: keeps rules when the embedding model is unchanged", async () => {
		await seedLtm(tmpDir, "model-SAME")
		vi.mocked(currentEmbedFingerprint).mockReturnValue("model-SAME")

		const svc = new LongTermMemoryService(tmpDir, makeAdapter(), makeApi())
		await svc.load()

		expect(svc.getRules()).toHaveLength(1)
	})
})
