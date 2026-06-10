/**
 * Agent Directory Loader
 *
 * Scans `.njust-ai/agents/` for Markdown files defining custom agents.
 * Each file uses YAML frontmatter for metadata and the body for the
 * system prompt. Plugin agents are integrated via registerPluginAgent().
 *
 * Agent priority order for deduplication (highest wins):
 *   policySettings > projectSettings > userSettings > plugin > built-in
 */

import * as fs from "fs/promises"
import type { Dirent } from "fs"
import * as path from "path"
import type { AgentDefinition, CustomAgentDefinition, PluginAgentDefinition } from "./types"
import { BUILT_IN_AGENTS } from "./builtInAgents"

// ── Agent cache ──

let _cachedAgents: AgentDefinition[] | null = null
let _pluginAgents: PluginAgentDefinition[] = []

/** Register a plugin-provided agent definition */
export function registerPluginAgent(def: PluginAgentDefinition): void {
	_pluginAgents.push({ ...def, source: "plugin" })
	_cachedAgents = null // invalidate cache
}

/** Clear all plugin agent registrations */
export function clearPluginAgents(): void {
	_pluginAgents = []
	_cachedAgents = null
}

// ── YAML frontmatter parsing (lightweight, no dependency) ──

interface AgentFrontmatter {
	agentType?: string
	description?: string
	tools?: string[]
	disallowedTools?: string[]
	permissionMode?: string
	model?: string
	maxTurns?: number
	background?: boolean
	isolation?: string
	skills?: string[]
	mcpServers?: string[]
	memory?: string[]
	priority?: number
}

function parseFrontmatter(content: string): { fm: AgentFrontmatter; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
	if (!match) {
		return { fm: {}, body: content }
	}

	const raw = match[1] || ""
	const body = match[2] || ""

	const fm: AgentFrontmatter = {}
	for (const line of raw.split("\n")) {
		const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/)
		if (!kv) continue
		const key = kv[1]!
		let value: UnsafeAny = kv[2]!.trim()

		// Parse lists: "['a', 'b']" or "a, b, c"
		if (value.startsWith("[") && value.endsWith("]")) {
			value = value
				.slice(1, -1)
				.split(",")
				.map((s: string) => s.trim().replace(/^['"]|['"]$/g, ""))
				.filter(Boolean)
		}
		// Parse numbers
		else if (/^\d+$/.test(value)) {
			value = parseInt(value, 10)
		}
		// Parse booleans
		else if (value === "true") value = true
		else if (value === "false") value = false
		;(fm as UnsafeAny)[key] = value
	}

	return { fm, body }
}

// ── Directory loading ──

async function loadMarkdownAgents(
	dir: string,
	source: "userSettings" | "projectSettings",
): Promise<CustomAgentDefinition[]> {
	const results: CustomAgentDefinition[] = []

	let entries: Dirent[]
	try {
		entries = await fs.readdir(dir, { withFileTypes: true })
	} catch {
		return results // directory doesn't exist
	}

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue

		const filePath = path.join(dir, entry.name)
		const raw = await fs.readFile(filePath, "utf-8")
		const { fm, body } = parseFrontmatter(raw)

		// agentType defaults to filename without extension
		const agentType = fm.agentType || path.basename(entry.name, ".md")
		const description = fm.description || `Custom agent: ${agentType}`
		const tools = fm.tools || body.match(/tools?:\s*\[([^\]]+)\]/)?.[1]?.split(/,\s*/) || ["*"]
		const priority = fm.priority ?? (source === "projectSettings" ? 200 : 150)

		results.push({
			agentType,
			description,
			source,
			tools,
			disallowedTools: fm.disallowedTools,
			permissionMode: fm.permissionMode as UnsafeAny,
			model: fm.model,
			maxTurns: fm.maxTurns,
			background: fm.background,
			isolation: fm.isolation as UnsafeAny,
			skills: fm.skills,
			mcpServers: fm.mcpServers,
			memory: fm.memory as UnsafeAny,
			systemPrompt: body.trim(),
			priority,
			filePath,
		})
	}

	return results
}

// ── Public API ──

/**
 * Get all available agent definitions, deduplicated by agentType.
 * Priority order: projectSettings > userSettings > plugin > built-in.
 */
export async function getAgentDefinitions(cwd?: string): Promise<AgentDefinition[]> {
	const userDir = cwd ? path.join(cwd, ".njust-ai", "agents") : path.join(process.cwd(), ".njust-ai", "agents")

	const [userAgents, projectAgents] = await Promise.all([
		loadMarkdownAgents(userDir, "userSettings"),
		// Project agents could also live in .njust-ai/agents at the workspace root
		Promise.resolve([] as CustomAgentDefinition[]),
	])

	const all: AgentDefinition[] = [...BUILT_IN_AGENTS, ..._pluginAgents, ...userAgents, ...projectAgents]

	// Deduplicate: higher priority wins
	const seen = new Map<string, AgentDefinition>()
	for (const def of all) {
		const existing = seen.get(def.agentType)
		if (!existing || (def.priority ?? 0) >= (existing.priority ?? 0)) {
			seen.set(def.agentType, def)
		}
	}

	return Array.from(seen.values())
}

/** Synchronous variant using cached data (for REPL/perf-critical paths) */
export function getAgentDefinitionsSync(): AgentDefinition[] {
	if (_cachedAgents) return _cachedAgents

	const all: AgentDefinition[] = [...BUILT_IN_AGENTS, ..._pluginAgents]

	const seen = new Map<string, AgentDefinition>()
	for (const def of all) {
		const existing = seen.get(def.agentType)
		if (!existing || (def.priority ?? 0) >= (existing.priority ?? 0)) {
			seen.set(def.agentType, def)
		}
	}

	_cachedAgents = Array.from(seen.values())
	return _cachedAgents
}

/** Invalidate the agent cache (call after registering plugins or file changes) */
export function invalidateAgentCache(): void {
	_cachedAgents = null
}
