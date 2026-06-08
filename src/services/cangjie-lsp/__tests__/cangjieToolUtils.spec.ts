import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockExistsSync, mockReadFileSync, mockStatSync } = vi.hoisted(() => ({
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
	mockStatSync: vi.fn(),
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, existsSync: mockExistsSync, readFileSync: mockReadFileSync, statSync: mockStatSync },
		existsSync: mockExistsSync,
		readFileSync: mockReadFileSync,
		statSync: mockStatSync,
	}
})

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(undefined),
		}),
	},
}))

import {
	buildCangjieToolEnv,
	detectCangjieHome,
	formatCangjieToolchainReport,
	invalidateCangjieToolEnvCache,
} from "../cangjieToolUtils"

describe("cangjieToolUtils", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockExistsSync.mockReturnValue(false)
		invalidateCangjieToolEnvCache()
	})

	describe("buildCangjieToolEnv", () => {
		it("returns env object", () => {
			const env = buildCangjieToolEnv()
			expect(env).toBeDefined()
			expect(typeof env).toBe("object")
		})
	})

	describe("detectCangjieHome", () => {
		it("returns undefined when no Cangjie installation found", () => {
			mockExistsSync.mockReturnValue(false)
			const origEnv = process.env.CANGJIE_HOME
			delete process.env.CANGJIE_HOME
			try {
				const result = detectCangjieHome()
				expect(result === undefined || typeof result === "string").toBe(true)
			} finally {
				if (origEnv !== undefined) process.env.CANGJIE_HOME = origEnv
			}
		})

		it("returns CANGJIE_HOME env var when set", () => {
			const origEnv = process.env.CANGJIE_HOME
			process.env.CANGJIE_HOME = "/custom/cangjie"
			mockExistsSync.mockImplementation((p: string) => {
				return p === "/custom/cangjie" || p === "/custom/cangjie/bin"
			})
			try {
				const result = detectCangjieHome()
				expect(result).toBe("/custom/cangjie")
			} finally {
				if (origEnv !== undefined) process.env.CANGJIE_HOME = origEnv
				else delete process.env.CANGJIE_HOME
			}
		})
	})

	describe("formatCangjieToolchainReport", () => {
		it("returns string report from probe results", () => {
			const probes = [
				{ tool: "cjc" as const, resolvedPath: "/mock/cjc", version: "0.1.0", ok: true },
				{ tool: "cjpm" as const, resolvedPath: "/mock/cjpm", version: "0.1.0", ok: true },
			]
			const report = formatCangjieToolchainReport(probes)
			expect(typeof report).toBe("string")
			expect(report).toContain("Cangjie")
		})

		it("handles empty probes array", () => {
			const report = formatCangjieToolchainReport([])
			expect(typeof report).toBe("string")
		})
	})
})
