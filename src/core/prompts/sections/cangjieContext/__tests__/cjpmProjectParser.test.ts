import { describe, it, expect, vi } from "vitest"

vi.mock("../cangjie-context", () => ({
	getCangjiePromptServices: vi.fn(() => ({
		getCangjieSymbolIndex: vi.fn(() => null),
	})),
}))
vi.mock("@njust-ai/telemetry", () => ({
	TelemetryService: { reportError: vi.fn() },
}))
vi.mock("../../../../shared/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { parseCjpmTomlContent } = await import("../cjpmProjectParser")

const cwd = "/fake/project"

describe("parseCjpmTomlContent", () => {
	it("parses single-module project", async () => {
		const content = ["[package]", 'name = "hello"', 'version = "0.1.0"'].join(String.fromCharCode(10))
		const result = await parseCjpmTomlContent(content, cwd)
		expect(result).not.toBeNull()
		expect(result.name).toBe("hello")
	})

	it("returns null for invalid content", async () => {
		const result = await parseCjpmTomlContent("not valid", cwd)
		expect(result).toBeNull()
	})
})
