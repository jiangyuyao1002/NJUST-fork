import { ApiMessage } from "../task-persistence/apiMessages"
import { groupMessagesByApiTurn } from "./grouping"

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface TurnMeta {
	turnIndex: number
	startMsgIndex: number
	endMsgIndex: number
	messageCount: number
	/** userText + assistantText concatenated for similarity computation */
	concatenatedText: string
	toolNames: Set<string>
	/** Actual count of tool_use blocks in this turn */
	toolUseCount: number
	filePaths: Set<string>
	hasError: boolean
	hasWriteOp: boolean
	estimatedTokens: number
}

export interface FileRef {
	filePath: string
	turnIndices: number[]
	lastModifiedTurn: number
	referenceCount: number
	isRecent: boolean
}

// ═══════════════════════════════════════════════════════════════════
// Adaptive parameter types
// ═══════════════════════════════════════════════════════════════════

export interface SessionStats {
	turnCount: number
	fileCount: number
	/** Average files referenced per turn (0..N) */
	fileDensity: number
	/** Fraction of turns with write operations (0..1) */
	writeRatio: number
	/** Fraction of turns with errors (0..1) */
	errorRatio: number
	/** Unique tool count / total tool uses (0..1). Low = repetitive patterns */
	toolDiversity: number
	/** Fraction of turns with zero tool usage (0..1) */
	chatRatio: number
	totalToolUses: number
}

export interface AdaptiveParams {
	selfAttnMeanMult: number
	queryAttnMult: number
	fileHotnessMult: number
	attnContentWeight: number
	attnFileWeight: number
	attnToolWeight: number
	attnTemporalWeight: number
	impDiffThreshold: number
}

export const DEFAULT_ADAPTIVE_PARAMS: AdaptiveParams = {
	selfAttnMeanMult: 2.0,
	queryAttnMult: 2.5,
	fileHotnessMult: 1.5,
	attnContentWeight: 0.4,
	attnFileWeight: 0.25,
	attnToolWeight: 0.15,
	attnTemporalWeight: 0.2,
	impDiffThreshold: 0.02,
}

export interface ContextHierarchy {
	turns: TurnMeta[]
	files: Map<string, FileRef>
	/** N×N turn self-attention matrix, flattened: cell[i][j] = turnAttention[i*N + j] */
	turnAttention: Float64Array
	turnCount: number
	/** O(1) lookup: message global index → turn index (-1 if not found) */
	msgToTurnIndex: Int32Array
	/** Adaptive parameters derived from session statistics */
	adaptiveParams: AdaptiveParams
}

// ═══════════════════════════════════════════════════════════════════
// Text tokenization for Jaccard similarity
// ═══════════════════════════════════════════════════════════════════

export function tokenizeForRelevance(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_]+/)
			.filter((t) => t.length >= 3),
	)
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0
	let intersection = 0
	for (const token of a) {
		if (b.has(token)) intersection++
	}
	const union = a.size + b.size - intersection
	return union === 0 ? 0 : intersection / union
}

// ═══════════════════════════════════════════════════════════════════
// Turn metadata extraction
// ═══════════════════════════════════════════════════════════════════

const FILE_PATH_FIELDS = [
	"filePath",
	"path",
	"target_file",
	"source_file",
	"file_path",
	"target",
	"absolutePath",
	"output_file",
]

function looksLikePath(s: UnsafeAny): s is string {
	if (typeof s !== "string") return false
	return s.includes("/") || s.includes("\\") || s.includes(".")
}

function extractToolInfo(messages: ApiMessage[]): { names: Set<string>; count: number } {
	const names = new Set<string>()
	let count = 0
	for (const msg of messages) {
		if (!Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block.type === "tool_use" && (block as Record<string, UnsafeAny>).name) {
				names.add((block as Record<string, UnsafeAny>).name)
				count++
			}
		}
	}
	return { names, count }
}

function extractFilePaths(messages: ApiMessage[]): Set<string> {
	const paths = new Set<string>()
	for (const msg of messages) {
		if (!Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block.type !== "tool_use") continue
			const input = (block as Record<string, UnsafeAny>).input
			if (!input || typeof input !== "object") continue
			for (const field of FILE_PATH_FIELDS) {
				if (looksLikePath(input[field])) {
					paths.add(input[field])
				}
			}
		}
	}
	return paths
}

function concatTextBlocks(messages: ApiMessage[], role: "user" | "assistant"): string {
	const parts: string[] = []
	for (const msg of messages) {
		if (msg.role !== role) continue
		if (typeof msg.content === "string") {
			parts.push(msg.content)
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "text" && (block as Record<string, UnsafeAny>).text) {
					parts.push((block as Record<string, UnsafeAny>).text)
				}
			}
		}
	}
	return parts.join(" ")
}

function hasErrorContent(messages: ApiMessage[]): boolean {
	for (const msg of messages) {
		const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
		if (/error|retry|recovery|failed|circuit.?breaker/i.test(text)) return true
	}
	return false
}

function hasWriteOperation(messages: ApiMessage[]): boolean {
	for (const msg of messages) {
		if (!Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block.type === "tool_use") {
				const name = ((block as Record<string, UnsafeAny>).name ?? "") as string
				if (/write_to_file|apply_diff|insert_content|search_and_replace/.test(name)) return true
			}
		}
	}
	return false
}

function estimateTokens(text: string): number {
	if (!text) return 0
	let cjk = 0
	let other = 0
	for (const ch of text) {
		const cp = ch.codePointAt(0)!
		if (
			(cp >= 0x4e00 && cp <= 0x9fff) ||
			(cp >= 0x3400 && cp <= 0x4dbf) ||
			(cp >= 0x3040 && cp <= 0x30ff) ||
			(cp >= 0xac00 && cp <= 0xd7af)
		) {
			cjk++
		} else {
			other++
		}
	}
	return Math.ceil(cjk * 0.6 + other / 3.5)
}

function estimateTurnTokens(messages: ApiMessage[]): number {
	let total = 0
	for (const msg of messages) {
		const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
		total += estimateTokens(text)
	}
	return total
}

// ═══════════════════════════════════════════════════════════════════
// File reference graph building
// ═══════════════════════════════════════════════════════════════════

function buildFileGraph(turns: TurnMeta[]): Map<string, FileRef> {
	const fileMap = new Map<string, FileRef>()

	for (const turn of turns) {
		for (const fp of turn.filePaths) {
			if (!fileMap.has(fp)) {
				fileMap.set(fp, {
					filePath: fp,
					turnIndices: [],
					lastModifiedTurn: -1,
					referenceCount: 0,
					isRecent: false,
				})
			}
			const ref = fileMap.get(fp)!
			ref.turnIndices.push(turn.turnIndex)
			ref.referenceCount = ref.turnIndices.length
			if (turn.hasWriteOp) {
				ref.lastModifiedTurn = Math.max(ref.lastModifiedTurn, turn.turnIndex)
			}
		}
	}

	// Mark recent files
	const recentThreshold = Math.max(0, turns.length - 3)
	for (const ref of fileMap.values()) {
		ref.isRecent = ref.lastModifiedTurn >= recentThreshold && ref.lastModifiedTurn >= 0
	}

	return fileMap
}

// ═══════════════════════════════════════════════════════════════════
// Turn self-attention matrix (CSA core)
// ═══════════════════════════════════════════════════════════════════

const HALF_LIFE_TURNS = 8

function computeFileOverlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0
	let intersection = 0
	for (const fp of a) {
		if (b.has(fp)) intersection++
	}
	const minSize = Math.min(a.size, b.size)
	return minSize === 0 ? 0 : intersection / minSize
}

function computeTurnAttentionMatrix(turns: TurnMeta[], params: AdaptiveParams): Float64Array {
	const N = turns.length
	const attn = new Float64Array(N * N)

	// Pre-tokenize each turn's text for Jaccard
	const tokenSets: Set<string>[] = turns.map((t) => tokenizeForRelevance(t.concatenatedText))

	const cw = params.attnContentWeight
	const fw = params.attnFileWeight
	const tw = params.attnToolWeight
	const hw = params.attnTemporalWeight

	for (let i = 0; i < N; i++) {
		attn[i * N + i] = 1.0 // self-attention

		for (let j = i + 1; j < N; j++) {
			const contentSim = jaccardSimilarity(tokenSets[i]!, tokenSets[j]!)
			const fileOverlap = computeFileOverlap(turns[i]!.filePaths, turns[j]!.filePaths)
			const toolSim = jaccardSimilarity(turns[i]!.toolNames, turns[j]!.toolNames)
			const temporalWeight = Math.pow(0.5, Math.abs(i - j) / HALF_LIFE_TURNS)

			const score = cw * contentSim + fw * fileOverlap + tw * toolSim + hw * temporalWeight

			attn[i * N + j] = Math.min(1, Math.max(0, score))
			attn[j * N + i] = attn[i * N + j]! // symmetric
		}
	}

	return attn
}

// ═══════════════════════════════════════════════════════════════════
// Adaptive parameter derivation
// ═══════════════════════════════════════════════════════════════════

const EMA_ALPHA = 0.15

function computeSessionStats(turns: TurnMeta[], files: Map<string, FileRef>): SessionStats {
	const turnCount = turns.length
	const fileCount = files.size
	let totalFileRefs = 0
	let writeCount = 0
	let errorCount = 0
	let chatCount = 0
	const allToolNames = new Set<string>()
	let totalToolUses = 0

	for (const turn of turns) {
		totalFileRefs += turn.filePaths.size
		if (turn.hasWriteOp) writeCount++
		if (turn.hasError) errorCount++
		if (turn.toolUseCount === 0) chatCount++
		for (const name of turn.toolNames) allToolNames.add(name)
		totalToolUses += turn.toolUseCount
	}

	return {
		turnCount,
		fileCount,
		fileDensity: turnCount > 0 ? totalFileRefs / turnCount : 0,
		writeRatio: turnCount > 0 ? writeCount / turnCount : 0,
		errorRatio: turnCount > 0 ? errorCount / turnCount : 0,
		toolDiversity: totalToolUses > 0 ? allToolNames.size / totalToolUses : 0,
		chatRatio: turnCount > 0 ? chatCount / turnCount : 0,
		totalToolUses,
	}
}

function deriveTargetParams(stats: SessionStats): AdaptiveParams {
	const t: AdaptiveParams = { ...DEFAULT_ADAPTIVE_PARAMS }

	// Rule 1: fileDensity — file-related parameters
	if (stats.fileDensity > 0.5) {
		t.fileHotnessMult = Math.min(3.0, 1.5 + (stats.fileDensity - 0.5) * 4.0)
		t.attnFileWeight = Math.min(0.5, 0.25 + (stats.fileDensity - 0.5) * 0.5)
	} else if (stats.fileDensity < 0.1) {
		t.fileHotnessMult = 1.0
		t.attnFileWeight = 0.15
	}

	// Rule 2: writeRatio — structural parameter boost
	if (stats.writeRatio > 0.3) {
		t.selfAttnMeanMult = Math.min(4.0, 2.0 + (stats.writeRatio - 0.3) * 4.0)
	} else if (stats.writeRatio < 0.05) {
		t.selfAttnMeanMult = 1.5
	}

	// Rule 3: errorRatio — reduce error boosts when errors are frequent noise
	if (stats.errorRatio > 0.1) {
		t.selfAttnMeanMult *= 0.7
		t.queryAttnMult *= 0.8
	}

	// Rule 4: conversation age — reduce temporal weight, redistribute to others
	if (stats.turnCount > 30) {
		const oldTemporal = t.attnTemporalWeight
		t.attnTemporalWeight = Math.max(0.05, 0.2 - (stats.turnCount - 30) * 0.003)
		const delta = oldTemporal - t.attnTemporalWeight
		t.attnContentWeight += delta / 3
		t.attnFileWeight += delta / 3
		t.attnToolWeight += delta / 3
	}

	// Rules 5 & 6: compute chat- and tool-driven adjustments independently,
	// then apply them simultaneously to eliminate order dependence between
	// the two rules (they modify contentWeight in opposite directions).
	const chatExcess = stats.chatRatio > 0.5 ? stats.chatRatio - 0.5 : 0
	const toolBoost = stats.toolDiversity < 0.3 ? (0.3 - stats.toolDiversity) * 0.4 : 0

	if (chatExcess > 0 || toolBoost > 0) {
		let cw = t.attnContentWeight
		let fw = t.attnFileWeight
		let tw = t.attnToolWeight

		// Rule 5: chatRatio → content ↑, file ↓, hotness ↓
		if (chatExcess > 0) {
			cw = Math.min(0.6, cw + chatExcess * 0.3)
			fw = Math.max(0.1, fw - chatExcess * 0.2)
			t.fileHotnessMult = Math.max(0.5, t.fileHotnessMult - chatExcess * 0.8)
		}

		// Rule 6: toolDiversity → tool ↑, content ↓
		if (toolBoost > 0) {
			tw = Math.min(0.3, tw + toolBoost)
			cw = Math.max(0.2, cw - toolBoost)
		}

		t.attnContentWeight = cw
		t.attnFileWeight = fw
		t.attnToolWeight = tw
	}

	// Rule 7: conversation length — adjust turn-grouping threshold
	// Short conversations: stronger grouping (fewer turns to protect)
	// Long conversations: weaker grouping (more turns, rely on per-message weight)
	if (stats.turnCount < 10) {
		t.impDiffThreshold = 0.01
	} else if (stats.turnCount > 50) {
		t.impDiffThreshold = Math.min(0.08, 0.02 + (stats.turnCount - 50) * 0.001)
	}

	// Normalize attention weights to sum to 1.0
	const sum = t.attnContentWeight + t.attnFileWeight + t.attnToolWeight + t.attnTemporalWeight
	t.attnContentWeight /= sum
	t.attnFileWeight /= sum
	t.attnToolWeight /= sum
	t.attnTemporalWeight /= sum

	// Clamp CSA multipliers to safe ranges
	t.selfAttnMeanMult = Math.max(1.0, Math.min(4.0, t.selfAttnMeanMult))
	t.queryAttnMult = Math.max(1.0, Math.min(5.0, t.queryAttnMult))
	t.fileHotnessMult = Math.max(0.5, Math.min(3.0, t.fileHotnessMult))
	t.impDiffThreshold = Math.max(0.01, Math.min(0.1, t.impDiffThreshold))

	return t
}

function emaParams(prev: AdaptiveParams, target: AdaptiveParams, alpha: number = EMA_ALPHA): AdaptiveParams {
	return {
		selfAttnMeanMult: prev.selfAttnMeanMult * (1 - alpha) + target.selfAttnMeanMult * alpha,
		queryAttnMult: prev.queryAttnMult * (1 - alpha) + target.queryAttnMult * alpha,
		fileHotnessMult: prev.fileHotnessMult * (1 - alpha) + target.fileHotnessMult * alpha,
		attnContentWeight: prev.attnContentWeight * (1 - alpha) + target.attnContentWeight * alpha,
		attnFileWeight: prev.attnFileWeight * (1 - alpha) + target.attnFileWeight * alpha,
		attnToolWeight: prev.attnToolWeight * (1 - alpha) + target.attnToolWeight * alpha,
		attnTemporalWeight: prev.attnTemporalWeight * (1 - alpha) + target.attnTemporalWeight * alpha,
		impDiffThreshold: prev.impDiffThreshold * (1 - alpha) + target.impDiffThreshold * alpha,
	}
}

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/** Task-scoped cache for EMA smoothing across manageContext calls */
const _adaptiveParamsByTask = new Map<string, AdaptiveParams>()
/** Max entries before evicting oldest (prevents unbounded growth across tasks) */
const MAX_CACHED_TASKS = 50

/**
 * Build a hierarchical context representation from flat conversation messages.
 *
 * Extracts turn-level metadata, constructs a file reference graph,
 * and computes an N×N turn self-attention matrix using CSA-inspired
 * multi-factor similarity scoring. Parameters are automatically tuned
 * based on conversation statistics (file density, write ratio, etc.)
 * with EMA smoothing across calls, scoped per taskId.
 *
 * Returns null when there are fewer than 3 turns (hierarchy provides
 * no benefit over flat evaluation in such cases).
 */
export function buildContextHierarchy(messages: ApiMessage[], taskId?: string): ContextHierarchy | null {
	// Step 1: Group into API turns (reuse existing utility)
	const turnGroups = groupMessagesByApiTurn(messages)
	if (turnGroups.length < 3) return null

	// Step 2: Extract per-turn metadata
	let globalMsgIndex = 0
	const turns: TurnMeta[] = []

	for (let ti = 0; ti < turnGroups.length; ti++) {
		const group = turnGroups[ti]!
		const startMsgIndex = globalMsgIndex
		globalMsgIndex += group.length
		const endMsgIndex = globalMsgIndex - 1
		const toolInfo = extractToolInfo(group)

		turns.push({
			turnIndex: ti,
			startMsgIndex,
			endMsgIndex,
			messageCount: group.length,
			concatenatedText: concatTextBlocks(group, "user") + " " + concatTextBlocks(group, "assistant"),
			toolNames: toolInfo.names,
			toolUseCount: toolInfo.count,
			filePaths: extractFilePaths(group),
			hasError: hasErrorContent(group),
			hasWriteOp: hasWriteOperation(group),
			estimatedTokens: estimateTurnTokens(group),
		})
	}

	// Step 3: Build file reference graph
	const files = buildFileGraph(turns)

	// Step 4: Build O(1) message → turn index lookup
	const totalMessages = globalMsgIndex
	const msgToTurnIndex = new Int32Array(totalMessages)
	msgToTurnIndex.fill(-1)
	for (const turn of turns) {
		for (let i = turn.startMsgIndex; i <= turn.endMsgIndex; i++) {
			msgToTurnIndex[i] = turn.turnIndex
		}
	}

	// Step 5: Compute session stats and derive adaptive parameters
	const stats = computeSessionStats(turns, files)
	const targetParams = deriveTargetParams(stats)
	const prev = taskId ? _adaptiveParamsByTask.get(taskId) : undefined
	const adaptiveParams = prev ? emaParams(prev, targetParams) : targetParams
	if (taskId) {
		if (_adaptiveParamsByTask.size >= MAX_CACHED_TASKS && !_adaptiveParamsByTask.has(taskId)) {
			const oldest = _adaptiveParamsByTask.keys().next().value
			if (oldest) _adaptiveParamsByTask.delete(oldest)
		}
		_adaptiveParamsByTask.set(taskId, adaptiveParams)
	}

	// Step 6: Compute turn self-attention matrix with adaptive weights
	const turnAttention = computeTurnAttentionMatrix(turns, adaptiveParams)

	return {
		turns,
		files,
		turnAttention,
		turnCount: turns.length,
		msgToTurnIndex,
		adaptiveParams,
	}
}

/** Reset the EMA cache for a specific task (useful for testing or task restart) */
export function resetAdaptiveParams(taskId?: string): void {
	if (taskId) {
		_adaptiveParamsByTask.delete(taskId)
	} else {
		_adaptiveParamsByTask.clear()
	}
}

/**
 * Find which turn a message (by its global index in the messages array) belongs to.
 * Returns -1 if not found.
 */
export function findTurnIndex(hierarchy: ContextHierarchy, msgIndex: number): number {
	if (msgIndex < 0 || msgIndex >= hierarchy.msgToTurnIndex.length) return -1
	return hierarchy.msgToTurnIndex[msgIndex] ?? -1
}

/**
 * Compute the mean self-attention score for a given turn.
 * This represents the turn's "centrality" in the conversation.
 */
export function computeTurnSelfAttentionMean(hierarchy: ContextHierarchy, turnIdx: number): number {
	const N = hierarchy.turnCount
	if (turnIdx < 0 || turnIdx >= N) return 0
	let sum = 0
	const base = turnIdx * N
	for (let j = 0; j < N; j++) {
		sum += hierarchy.turnAttention[base + j] ?? 0
	}
	return sum / N
}

/**
 * Compute turn importance from the attention matrix.
 *
 * If a specific turnIdx is provided, returns that turn's self-attention mean.
 * Otherwise returns the average across all turns.
 *
 * Use getAllTurnImportances() to get per-turn scores as a Float64Array.
 */
export function computeTurnImportance(hierarchy: ContextHierarchy, turnIdx?: number): number {
	const N = hierarchy.turnCount
	if (N === 0) return 0

	if (turnIdx !== undefined) {
		return computeTurnSelfAttentionMean(hierarchy, turnIdx)
	}

	// Return the average across all turns (for telemetry)
	let total = 0
	for (let i = 0; i < N; i++) {
		total += computeTurnSelfAttentionMean(hierarchy, i)
	}
	return total / N
}

/**
 * Get the turn importance for every turn as a plain array (for sorting / telemetry).
 */
export function getAllTurnImportances(hierarchy: ContextHierarchy): Float64Array {
	const N = hierarchy.turnCount
	const result = new Float64Array(N)
	for (let i = 0; i < N; i++) {
		result[i] = computeTurnSelfAttentionMean(hierarchy, i)
	}
	return result
}

/**
 * Get the "hotness" score for a given turn based on how many other turns
 * reference the same files. Returns 0..1.
 */
export function computeFileHotness(hierarchy: ContextHierarchy, turnIdx: number): number {
	const turn = hierarchy.turns[turnIdx]
	if (!turn || turn.filePaths.size === 0) return 0

	let maxHotness = 0
	for (const fp of turn.filePaths) {
		const ref = hierarchy.files.get(fp)
		if (ref && ref.referenceCount > 1) {
			const hotness = Math.min(1, ref.referenceCount / 5)
			maxHotness = Math.max(maxHotness, hotness)
		}
	}
	return maxHotness
}

/**
 * Get the query attention: similarity between the given turn and the LAST turn.
 */
export function getQueryAttention(hierarchy: ContextHierarchy, turnIdx: number): number {
	const N = hierarchy.turnCount
	if (turnIdx < 0 || turnIdx >= N) return 0
	return hierarchy.turnAttention[turnIdx * N + (N - 1)] ?? 0
}
