import { describe, it, expect, vi } from "vitest"

vi.mock("fs/promises", () => ({
	default: {
		access: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("{}"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rename: vi.fn().mockResolvedValue(undefined),
		lstat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
		mkdir: vi.fn().mockResolvedValue(undefined),
	},
}))

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
}))

vi.mock("../McpHub", async () => {
	const actual = await vi.importActual("../McpHub")
	return actual
})

import { ServerConfigSchema } from "../McpHub"

describe("McpHub ServerConfig validation", () => {
	it("rejects empty string as server config", () => {
		const result = ServerConfigSchema.safeParse("")
		expect(result.success).toBe(false)
	})

	it("rejects null server config", () => {
		const result = ServerConfigSchema.safeParse(null)
		expect(result.success).toBe(false)
	})

	it("rejects undefined server config", () => {
		const result = ServerConfigSchema.safeParse(undefined)
		expect(result.success).toBe(false)
	})

	it("rejects config with empty command for stdio type", () => {
		const result = ServerConfigSchema.safeParse({
			type: "stdio",
			command: "",
			args: [],
		})
		expect(result.success).toBe(false)
	})

	it("accepts valid stdio config", () => {
		const result = ServerConfigSchema.safeParse({
			type: "stdio",
			command: "node",
			args: ["server.js"],
		})
		expect(result.success).toBe(true)
	})

	it("rejects missing command for stdio type", () => {
		const result = ServerConfigSchema.safeParse({
			type: "stdio",
			args: ["server.js"],
		})
		expect(result.success).toBe(false)
	})

	it("accepts streamable-http config with url", () => {
		const result = ServerConfigSchema.safeParse({
			type: "streamable-http",
			url: "https://example.com/mcp",
		})
		expect(result.success).toBe(true)
	})

	it("rejects streamable-http config without url", () => {
		const result = ServerConfigSchema.safeParse({
			type: "streamable-http",
		})
		expect(result.success).toBe(false)
	})

	it("accepts valid config with disabled flag", () => {
		const result = ServerConfigSchema.safeParse({
			type: "stdio",
			command: "node",
			args: ["server.js"],
			disabled: true,
		})
		expect(result.success).toBe(true)
	})

	it("sets default values for optional fields", () => {
		const result = ServerConfigSchema.safeParse({
			type: "stdio",
			command: "node",
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.command).toBe("node")
			expect(result.data.type).toBe("stdio")
		}
	})

	it("rejects unknown server type", () => {
		const result = ServerConfigSchema.safeParse({
			type: "some-unknown-transport",
			command: "node",
		})
		expect(result.success).toBe(false)
	})
})
