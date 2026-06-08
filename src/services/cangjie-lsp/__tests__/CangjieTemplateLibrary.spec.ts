import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	window: {
		createOutputChannel: vi.fn().mockReturnValue({
			appendLine: vi.fn(),
			dispose: vi.fn(),
		}),
		showQuickPick: vi.fn(),
		showInputBox: vi.fn(),
		showTextDocument: vi.fn(),
		activeTextEditor: undefined,
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		openTextDocument: vi.fn(),
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
	Range: class {
		constructor(
			public start: unknown,
			public end: unknown,
		) {}
	},
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
	WorkspaceEdit: class {
		set() {}
		replace() {}
		insert() {}
	},
	SnippetString: class {
		constructor(public value: string) {}
	},
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, existsSync: vi.fn().mockReturnValue(false), readFileSync: vi.fn() },
		existsSync: vi.fn().mockReturnValue(false),
		readFileSync: vi.fn(),
	}
})

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import { CangjieTemplateLibrary } from "../CangjieTemplateLibrary"

describe("CangjieTemplateLibrary", () => {
	let library: CangjieTemplateLibrary

	beforeEach(() => {
		vi.clearAllMocks()
		library = new CangjieTemplateLibrary()
	})

	describe("getAll", () => {
		it("returns array of templates", () => {
			const templates = library.getAll()
			expect(Array.isArray(templates)).toBe(true)
			expect(templates.length).toBeGreaterThan(0)
		})

		it("templates have required fields", () => {
			const templates = library.getAll()
			for (const t of templates) {
				expect(t).toHaveProperty("id")
				expect(t).toHaveProperty("title")
				expect(t).toHaveProperty("category")
				expect(t).toHaveProperty("body")
				expect(t).toHaveProperty("params")
			}
		})
	})

	describe("getByCategory", () => {
		it("filters by category", () => {
			const execTemplates = library.getByCategory("executable")
			expect(execTemplates.length).toBeGreaterThan(0)
			for (const t of execTemplates) {
				expect(t.category).toBe("executable")
			}
		})

		it("returns empty for non-existent category", () => {
			const result = library.getByCategory("nonexistent" as any)
			expect(result).toEqual([])
		})
	})

	describe("getById", () => {
		it("finds template by id", () => {
			const template = library.getById("exec-hello")
			expect(template).toBeDefined()
			expect(template!.id).toBe("exec-hello")
		})

		it("returns undefined for unknown id", () => {
			const result = library.getById("nonexistent")
			expect(result).toBeUndefined()
		})
	})

	describe("render", () => {
		it("replaces template parameters", () => {
			const template = library.getById("exec-hello")!
			const result = library.render(template, { packageName: "my_app", projectName: "TestProject" })
			expect(result).toContain("my_app")
			expect(result).toContain("TestProject")
		})

		it("uses default values when not provided", () => {
			const template = library.getById("exec-hello")!
			const result = library.render(template, {})
			expect(result).toContain("my_app")
			expect(result).toContain("Cangjie")
		})
	})

	describe("loadFromFile", () => {
		it("does not throw for non-existent file", () => {
			expect(() => library.loadFromFile("/nonexistent/file.json")).not.toThrow()
		})
	})
})
