import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", async () => {
	const actual = await vi.importActual("vscode")
	return {
		...actual,
		workspace: {
			...actual.workspace,
			getConfiguration: vi.fn(() => ({
				get: vi.fn(() => undefined),
			})),
			textDocuments: [],
		},
		window: {
			...actual.window,
			visibleTextEditors: [],
		},
	}
})
vi.mock("../../../../shared/package", () => ({ Package: { name: "test" } }))
vi.mock("../../../../shared/constants", () => ({
	LIMITS: {
		CANGJIE_L3_CACHE_TTL_MIN_MS: 1000,
		CANGJIE_L3_CACHE_TTL_MAX_MS: 300000,
		CANGJIE_L3_CACHE_TTL_DEFAULT_MS: 30000,
	},
}))
vi.mock("./budget", () => ({ simpleHash: vi.fn(() => 42) }))

const {
	userMessageSuggestsCangjie,
	getCachedProjectOverview,
	setCachedProjectOverview,
	getCachedHeavyContext,
	setCachedHeavyContext,
	getCachedContextSection,
	setCachedContextSection,
	getContextSectionInFlight,
	setContextSectionInFlight,
	deleteContextSectionInFlight,
	invalidateCangjieContextSectionCacheState,
	findCjpmTomlAncestor,
} = await import("../cacheManagement")

beforeEach(() => {
	invalidateCangjieContextSectionCacheState()
})

describe("userMessageSuggestsCangjie", () => {
	it("returns false for undefined", () => {
		expect(userMessageSuggestsCangjie(undefined)).toBe(false)
	})

	it("returns false for empty string", () => {
		expect(userMessageSuggestsCangjie("")).toBe(false)
	})

	it("returns true for cjpm reference", () => {
		expect(userMessageSuggestsCangjie("run cjpm build")).toBe(true)
	})

	it("returns true for cjc reference", () => {
		expect(userMessageSuggestsCangjie("use cjc --version")).toBe(true)
	})

	it("returns true for .cj file reference", () => {
		expect(userMessageSuggestsCangjie("fix this main.cj")).toBe(true)
	})

	it("returns true for cangjie keyword", () => {
		expect(userMessageSuggestsCangjie("cangjie compiler error")).toBe(true)
	})

	it("returns false for unrelated text", () => {
		expect(userMessageSuggestsCangjie("write a python script")).toBe(false)
	})

	it("returns false for very long text to avoid regex DoS", () => {
		const longText = "x".repeat(400_001)
		expect(userMessageSuggestsCangjie(longText)).toBe(false)
	})
})

describe("projectOverviewCache", () => {
	it("get returns null when cache is empty", () => {
		expect(getCachedProjectOverview("k", Date.now())).toBeNull()
	})

	it("set then get returns value when key matches", () => {
		const now = Date.now()
		setCachedProjectOverview("k", "v", now)
		expect(getCachedProjectOverview("k", now + 1000)).toBe("v")
	})

	it("get returns null when key differs", () => {
		const now = Date.now()
		setCachedProjectOverview("k1", "v", now)
		expect(getCachedProjectOverview("k2", now + 1000)).toBeNull()
	})

	it("get returns null when TTL expired", () => {
		const now = Date.now()
		setCachedProjectOverview("k", "v", now)
		expect(getCachedProjectOverview("k", now + 120_000)).toBeNull()
	})

	it("set with null value works", () => {
		const now = Date.now()
		setCachedProjectOverview("k", null, now)
		expect(getCachedProjectOverview("k", now + 1000)).toBeNull()
	})

	it("invalidate clears cache", () => {
		setCachedProjectOverview("k", "v", Date.now())
		invalidateCangjieContextSectionCacheState()
		expect(getCachedProjectOverview("k", Date.now())).toBeNull()
	})
})

describe("heavyContextCache", () => {
	it("get returns null when cache is empty", () => {
		expect(getCachedHeavyContext("k", Date.now())).toBeNull()
	})

	it("set then get returns value", () => {
		const bundle = {
			symbols: null,
			importedSymbols: null,
			stdlibHints: null,
			workspaceSummary: null,
			fewShot: null,
		}
		const now = Date.now()
		setCachedHeavyContext("k", bundle, now)
		expect(getCachedHeavyContext("k", now + 1000)).toEqual(bundle)
	})

	it("get returns null when TTL expired", () => {
		const bundle = {
			symbols: null,
			importedSymbols: null,
			stdlibHints: null,
			workspaceSummary: null,
			fewShot: null,
		}
		const now = Date.now()
		setCachedHeavyContext("k", bundle, now)
		expect(getCachedHeavyContext("k", now + 60_000)).toBeNull()
	})
})

describe("contextSectionCache", () => {
	it("get returns null when cache is empty", () => {
		expect(getCachedContextSection("k", Date.now())).toBeNull()
	})

	it("set then get returns value", () => {
		setCachedContextSection("k", "section content")
		expect(getCachedContextSection("k", Date.now())).toBe("section content")
	})

	it("get returns null when key differs", () => {
		setCachedContextSection("k1", "v")
		expect(getCachedContextSection("k2", Date.now())).toBeNull()
	})
})

describe("contextSectionInFlight", () => {
	it("get returns undefined when not set", () => {
		expect(getContextSectionInFlight("k")).toBeUndefined()
	})

	it("set then get returns promise", () => {
		const p = Promise.resolve("result")
		setContextSectionInFlight("k", p)
		expect(getContextSectionInFlight("k")).toBe(p)
	})

	it("delete removes the promise", () => {
		setContextSectionInFlight("k", Promise.resolve("x"))
		deleteContextSectionInFlight("k")
		expect(getContextSectionInFlight("k")).toBeUndefined()
	})
})

describe("findCjpmTomlAncestor", () => {
	it("returns null when no cjpm.toml found", () => {
		expect(findCjpmTomlAncestor("/tmp/nonexistent", 3)).toBeNull()
	})

	it("finds cjpm.toml in startDir", () => {
		expect(findCjpmTomlAncestor(__dirname, 1)).toBeNull()
	})
})
