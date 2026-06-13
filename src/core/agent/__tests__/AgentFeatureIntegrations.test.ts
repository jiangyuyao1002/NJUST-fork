import { describe, it, expect, vi } from "vitest"

vi.mock("../../shared/logger", () => ({ logger: { debug: vi.fn() } }))
vi.mock("../../tools/ToolHookManager", () => ({
	ToolHookManager: {
		instance: {
			runSubagentStartHooks: vi.fn().mockResolvedValue(undefined),
			runSubagentStopHooks: vi.fn().mockResolvedValue(undefined),
		},
	},
}))

const {
	resolveAgentMcpServers,
	resolveAgentSkills,
	resolveAgentSystemPrompt,
	resolveAgentEffectiveTools,
	resolveAgentHooks,
	activateAgentFeatures,
} = await import("../AgentFeatureIntegrations")

function mkDef(o: any = {}) {
	return { agentType: "subagent", tools: ["read_file"], mcpServers: [], skills: [], hooks: [], ...o }
}

describe("resolveAgentMcpServers", () => {
	it("returns agent servers only when no parent", () => {
		expect(resolveAgentMcpServers(mkDef({ mcpServers: ["a", "b"] }))).toEqual(["a", "b"])
	})

	it("deduplicates parent servers that overlap with agent servers", () => {
		const r = resolveAgentMcpServers(mkDef({ mcpServers: ["a"] }), ["a", "b"])
		expect(r).toEqual(["a", "b"])
	})

	it("returns only parent when agent has none", () => {
		expect(resolveAgentMcpServers(mkDef(), ["p1", "p2"])).toEqual(["p1", "p2"])
	})

	it("returns empty array when both are empty", () => {
		expect(resolveAgentMcpServers(mkDef(), [])).toEqual([])
	})
})

describe("resolveAgentSkills", () => {
	it("returns skills from definition", () => {
		expect(resolveAgentSkills(mkDef({ skills: ["s1", "s2"] }))).toEqual(["s1", "s2"])
	})

	it("returns empty when no skills", () => {
		expect(resolveAgentSkills(mkDef())).toEqual([])
	})
})

describe("resolveAgentSystemPrompt", () => {
	it("calls systemPrompt when it is a function", () => {
		const fn = vi.fn().mockReturnValue("custom prompt")
		const r = resolveAgentSystemPrompt(mkDef({ systemPrompt: fn }), { taskDescription: "do X", mode: "code" })
		expect(fn).toHaveBeenCalledWith({ taskDescription: "do X", mode: "code" })
		expect(r).toBe("custom prompt")
	})

	it("returns string prompt directly", () => {
		const r = resolveAgentSystemPrompt(mkDef({ systemPrompt: "hello" }), { taskDescription: "x", mode: "ask" })
		expect(r).toBe("hello")
	})

	it("returns fallback when systemPrompt is missing", () => {
		const r = resolveAgentSystemPrompt(mkDef(), { taskDescription: "fix bug", mode: "architect" })
		expect(r).toContain("fix bug")
		expect(r).toContain("architect")
	})

	it("returns fallback when systemPrompt is empty string", () => {
		const r = resolveAgentSystemPrompt(mkDef({ systemPrompt: "" }), { taskDescription: "do X", mode: "code" })
		expect(r).toContain("do X")
	})
})

describe("resolveAgentEffectiveTools", () => {
	it("returns [*] when tools include wildcard", () => {
		expect(resolveAgentEffectiveTools(mkDef({ tools: ["*", "read_file"] }))).toEqual(["*"])
	})

	it("removes disallowed tools from list", () => {
		const r = resolveAgentEffectiveTools(
			mkDef({ tools: ["read_file", "write_file", "execute"], disallowedTools: ["execute"] }),
		)
		expect(r).toEqual(["read_file", "write_file"])
	})

	it("returns all tools when no disallowedTools", () => {
		const r = resolveAgentEffectiveTools(mkDef({ tools: ["a", "b"] }))
		expect(r).toEqual(["a", "b"])
	})
})

describe("resolveAgentHooks", () => {
	it("returns hooks from definition", () => {
		expect(resolveAgentHooks(mkDef({ hooks: ["h1"] }))).toEqual(["h1"])
	})

	it("returns empty when no hooks", () => {
		expect(resolveAgentHooks(mkDef())).toEqual([])
	})
})

describe("activateAgentFeatures", () => {
	it("returns full feature state", () => {
		const state = activateAgentFeatures(mkDef({ mcpServers: ["srv1"], skills: ["sk1"], hooks: ["h1"] }), {
			taskDescription: "test",
			mode: "code",
		})
		expect(state.mcpServers).toEqual(["srv1"])
		expect(state.skills).toEqual(["sk1"])
		expect(state.hooks).toEqual(["h1"])
		expect(state.effectiveTools).toEqual(["read_file"])
		expect(state.hookIds).toEqual([])
	})
})
