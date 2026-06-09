import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Hoisted mock references – needed so we can configure mocks per-test
// ---------------------------------------------------------------------------
const {
	mockCreateOutputChannel,
	mockShowQuickPick,
	mockShowInputBox,
	mockShowTextDocument,
	mockOpenTextDocument,
	mockExistsSync,
	mockReadFileSync,
} = vi.hoisted(() => ({
	mockCreateOutputChannel: vi.fn().mockReturnValue({ appendLine: vi.fn(), dispose: vi.fn() }),
	mockShowQuickPick: vi.fn(),
	mockShowInputBox: vi.fn(),
	mockShowTextDocument: vi.fn(),
	mockOpenTextDocument: vi.fn(),
	mockExistsSync: vi.fn(),
	mockReadFileSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock("vscode", () => ({
	window: {
		createOutputChannel: mockCreateOutputChannel,
		showQuickPick: mockShowQuickPick,
		showInputBox: mockShowInputBox,
		showTextDocument: mockShowTextDocument,
		activeTextEditor: undefined,
	},
	workspace: {
		workspaceFolders: [{ uri: { fsPath: "/ws" } }],
		openTextDocument: mockOpenTextDocument,
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

vi.mock("fs", () => ({
	existsSync: mockExistsSync,
	readFileSync: mockReadFileSync,
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import * as vscode from "vscode"
import { CangjieTemplateLibrary } from "../CangjieTemplateLibrary"
import type { CangjieTemplate } from "../CangjieTemplateLibrary"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("CangjieTemplateLibrary", () => {
	let library: CangjieTemplateLibrary

	beforeEach(() => {
		vi.clearAllMocks()
		library = new CangjieTemplateLibrary()
	})

	// -----------------------------------------------------------------------
	// getAll
	// -----------------------------------------------------------------------
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

	// -----------------------------------------------------------------------
	// getByCategory
	// -----------------------------------------------------------------------
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

		it.each([
			["executable"],
			["library"],
			["http-server"],
			["cli-tool"],
			["data-processing"],
			["testing"],
			["concurrency"],
		] as const)("has at least one template in '%s' category", (category) => {
			const templates = library.getByCategory(category)
			expect(templates.length).toBeGreaterThan(0)
			for (const t of templates) {
				expect(t.category).toBe(category)
			}
		})
	})

	// -----------------------------------------------------------------------
	// getById
	// -----------------------------------------------------------------------
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

	// -----------------------------------------------------------------------
	// render
	// -----------------------------------------------------------------------
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

		it("handles template with no parameters", () => {
			const noParamTemplate: CangjieTemplate = {
				id: "no-params",
				title: "No Params",
				category: "executable",
				description: "A template without parameters",
				body: "static body content",
				params: [],
			}
			const result = library.render(noParamTemplate, {})
			expect(result).toBe("static body content")
		})

		it("replaces multiple occurrences of the same parameter", () => {
			const multiOccurrenceTemplate: CangjieTemplate = {
				id: "multi-occurrence",
				title: "Multi Occurrence",
				category: "executable",
				description: "Same param used multiple times",
				body: "class {{name}} { constructor() { this.x = '{{name}}' } }",
				params: [{ name: "name", label: "Name", defaultValue: "Default" }],
			}
			const result = library.render(multiOccurrenceTemplate, { name: "Foo" })
			expect(result).toBe("class Foo { constructor() { this.x = 'Foo' } }")
			// Ensure no unreplaced placeholder remains
			expect(result).not.toContain("{{name}}")
		})

		it("uses provided values for some params and defaults for others", () => {
			const template = library.getById("exec-hello")!
			const result = library.render(template, { packageName: "custom_pkg" })
			expect(result).toContain("custom_pkg")
			expect(result).toContain("Cangjie") // projectName default
		})

		it("renders http-server template replacing port in multiple places", () => {
			const template = library.getById("http-server")!
			const result = library.render(template, { port: "3000", packageName: "srv" })
			expect(result).toContain("ServerSocket(3000)")
			expect(result).toContain("Listening on port 3000")
			expect(result).not.toContain("{{port}}")
		})

		it("renders static-library template replacing valueType in multiple places", () => {
			const template = library.getById("static-library")!
			const result = library.render(template, { valueType: "Int64", packageName: "lib", className: "Box" })
			expect(result).toContain("_value: Int64")
			expect(result).toContain("getValue(): Int64")
			expect(result).toContain("setValue(v: Int64)")
			expect(result).not.toContain("{{valueType}}")
		})
	})

	// -----------------------------------------------------------------------
	// loadFromFile
	// -----------------------------------------------------------------------
	describe("loadFromFile", () => {
		it("does not throw for non-existent file", () => {
			expect(() => library.loadFromFile("/nonexistent/file.json")).not.toThrow()
		})

		it("adds templates from valid JSON file with templates array", () => {
			const customTemplates = [
				{
					id: "custom-1",
					title: "Custom One",
					category: "executable",
					description: "A custom template",
					body: "package {{pkg}}\nmain(): Int64 { return 0 }",
					params: [{ name: "pkg", label: "Package", defaultValue: "custom" }],
				},
			]
			mockExistsSync.mockReturnValueOnce(true)
			mockReadFileSync.mockReturnValueOnce(JSON.stringify({ templates: customTemplates }))

			library.loadFromFile("/path/to/templates.json")

			expect(library.getById("custom-1")).toBeDefined()
			expect(library.getById("custom-1")!.title).toBe("Custom One")
		})

		it("loaded templates are accessible via getAll()", () => {
			const initialCount = library.getAll().length
			const customTemplates = [
				{
					id: "custom-all",
					title: "All Test",
					category: "library",
					description: "desc",
					body: "body",
					params: [],
				},
			]
			mockExistsSync.mockReturnValueOnce(true)
			mockReadFileSync.mockReturnValueOnce(JSON.stringify({ templates: customTemplates }))

			library.loadFromFile("/path/to/templates.json")

			expect(library.getAll().length).toBe(initialCount + 1)
			expect(library.getAll().some((t) => t.id === "custom-all")).toBe(true)
		})

		it("loaded templates are accessible via getByCategory()", () => {
			const customTemplates = [
				{
					id: "custom-cat",
					title: "Cat Test",
					category: "testing",
					description: "desc",
					body: "body",
					params: [],
				},
			]
			mockExistsSync.mockReturnValueOnce(true)
			mockReadFileSync.mockReturnValueOnce(JSON.stringify({ templates: customTemplates }))

			library.loadFromFile("/path/to/templates.json")

			const testingTemplates = library.getByCategory("testing")
			expect(testingTemplates.some((t) => t.id === "custom-cat")).toBe(true)
		})

		it("loaded templates are accessible via getById()", () => {
			const customTemplates = [
				{
					id: "custom-byid",
					title: "ById Test",
					category: "executable",
					description: "desc",
					body: "body",
					params: [],
				},
			]
			mockExistsSync.mockReturnValueOnce(true)
			mockReadFileSync.mockReturnValueOnce(JSON.stringify({ templates: customTemplates }))

			library.loadFromFile("/path/to/templates.json")

			const found = library.getById("custom-byid")
			expect(found).toBeDefined()
			expect(found!.id).toBe("custom-byid")
		})

		it("silently ignores malformed JSON", () => {
			mockExistsSync.mockReturnValueOnce(true)
			mockReadFileSync.mockReturnValueOnce("this is not valid json {{{")

			expect(() => library.loadFromFile("/path/to/bad.json")).not.toThrow()
		})

		it("ignores file when templates key is missing", () => {
			const countBefore = library.getAll().length
			mockExistsSync.mockReturnValueOnce(true)
			mockReadFileSync.mockReturnValueOnce(JSON.stringify({ otherKey: "value" }))

			library.loadFromFile("/path/to/no-templates.json")

			expect(library.getAll().length).toBe(countBefore)
		})

		it("ignores file when templates is not an array", () => {
			const countBefore = library.getAll().length
			mockExistsSync.mockReturnValueOnce(true)
			mockReadFileSync.mockReturnValueOnce(JSON.stringify({ templates: "not-an-array" }))

			library.loadFromFile("/path/to/bad-type.json")

			expect(library.getAll().length).toBe(countBefore)
		})

		it("ignores file when templates is null", () => {
			const countBefore = library.getAll().length
			mockExistsSync.mockReturnValueOnce(true)
			mockReadFileSync.mockReturnValueOnce(JSON.stringify({ templates: null }))

			library.loadFromFile("/path/to/null-templates.json")

			expect(library.getAll().length).toBe(countBefore)
		})

		it("adds multiple custom templates at once", () => {
			const countBefore = library.getAll().length
			const customTemplates = [
				{ id: "multi-1", title: "M1", category: "executable", description: "", body: "b", params: [] },
				{ id: "multi-2", title: "M2", category: "library", description: "", body: "b", params: [] },
			]
			mockExistsSync.mockReturnValueOnce(true)
			mockReadFileSync.mockReturnValueOnce(JSON.stringify({ templates: customTemplates }))

			library.loadFromFile("/path/to/multi.json")

			expect(library.getAll().length).toBe(countBefore + 2)
			expect(library.getById("multi-1")).toBeDefined()
			expect(library.getById("multi-2")).toBeDefined()
		})
	})

	// -----------------------------------------------------------------------
	// showTemplatePicker
	// -----------------------------------------------------------------------
	describe("showTemplatePicker", () => {
		/** Helper: build a mock editor whose edit() captures the inserted code */
		function createMockEditor() {
			const insertFn = vi.fn()
			const editFn = vi.fn().mockImplementation(async (cb: (builder: any) => void) => {
				cb({ insert: insertFn })
			})
			return {
				editor: {
					selection: { active: { line: 0, character: 0 } },
					edit: editFn,
				},
				insertFn,
				editFn,
			}
		}

		it("inserts rendered code into active editor when user provides all params", async () => {
			const { editor, editFn, insertFn } = createMockEditor()
			Object.defineProperty(vscode.window, "activeTextEditor", {
				value: editor,
				configurable: true,
			})

			const template = library.getById("exec-hello")!
			mockShowQuickPick.mockResolvedValueOnce({
				label: template.title,
				description: `[${template.category}]`,
				detail: template.description,
				template,
			})
			mockShowInputBox.mockResolvedValueOnce("test_pkg") // packageName
			mockShowInputBox.mockResolvedValueOnce("TestProj") // projectName

			await library.showTemplatePicker()

			expect(editFn).toHaveBeenCalledTimes(1)
			expect(insertFn).toHaveBeenCalledTimes(1)
			const insertedCode = insertFn.mock.calls[0][1] as string
			expect(insertedCode).toContain("test_pkg")
			expect(insertedCode).toContain("TestProj")
			expect(insertedCode).not.toContain("{{")

			// restore
			Object.defineProperty(vscode.window, "activeTextEditor", {
				value: undefined,
				configurable: true,
			})
		})

		it("aborts when user cancels template selection (showQuickPick returns undefined)", async () => {
			mockShowQuickPick.mockResolvedValueOnce(undefined)

			await library.showTemplatePicker()

			expect(mockShowInputBox).not.toHaveBeenCalled()
			expect(mockOpenTextDocument).not.toHaveBeenCalled()
			expect(mockShowTextDocument).not.toHaveBeenCalled()
		})

		it("aborts when user cancels parameter input (showInputBox returns undefined)", async () => {
			const template = library.getById("exec-hello")!
			mockShowQuickPick.mockResolvedValueOnce({
				label: template.title,
				description: `[${template.category}]`,
				detail: template.description,
				template,
			})
			// First param input is cancelled
			mockShowInputBox.mockResolvedValueOnce(undefined)

			await library.showTemplatePicker()

			expect(mockOpenTextDocument).not.toHaveBeenCalled()
			expect(mockShowTextDocument).not.toHaveBeenCalled()
		})

		it("opens new text document when no active editor", async () => {
			Object.defineProperty(vscode.window, "activeTextEditor", {
				value: undefined,
				configurable: true,
			})

			const template = library.getById("exec-hello")!
			mockShowQuickPick.mockResolvedValueOnce({
				label: template.title,
				description: `[${template.category}]`,
				detail: template.description,
				template,
			})
			mockShowInputBox.mockResolvedValueOnce("new_pkg")
			mockShowInputBox.mockResolvedValueOnce("NewProj")

			const mockDoc = {}
			mockOpenTextDocument.mockResolvedValueOnce(mockDoc)
			mockShowTextDocument.mockResolvedValueOnce(undefined)

			await library.showTemplatePicker()

			expect(mockOpenTextDocument).toHaveBeenCalledTimes(1)
			const openArg = mockOpenTextDocument.mock.calls[0][0] as { language: string; content: string }
			expect(openArg.language).toBe("cangjie")
			expect(openArg.content).toContain("new_pkg")
			expect(openArg.content).toContain("NewProj")
			expect(mockShowTextDocument).toHaveBeenCalledWith(mockDoc)
		})

		it("passes correct quick-pick options with placeHolder and match flags", async () => {
			mockShowQuickPick.mockResolvedValueOnce(undefined) // cancel immediately

			await library.showTemplatePicker()

			expect(mockShowQuickPick).toHaveBeenCalledTimes(1)
			const options = mockShowQuickPick.mock.calls[0][1]
			expect(options).toEqual({
				placeHolder: "placeholders.select_cangjie_template",
				matchOnDescription: true,
				matchOnDetail: true,
			})
		})

		it("provides default value as initial input in showInputBox", async () => {
			const template = library.getById("exec-hello")!
			mockShowQuickPick.mockResolvedValueOnce({
				label: template.title,
				description: `[${template.category}]`,
				detail: template.description,
				template,
			})
			// Cancel on first param to stop early
			mockShowInputBox.mockResolvedValueOnce(undefined)

			await library.showTemplatePicker()

			expect(mockShowInputBox).toHaveBeenCalledTimes(1)
			const inputOptions = mockShowInputBox.mock.calls[0][0] as { prompt: string; value: string }
			expect(inputOptions.value).toBe("my_app") // default for packageName
		})

		it("handles template with no parameters (skips input prompts)", async () => {
			Object.defineProperty(vscode.window, "activeTextEditor", {
				value: undefined,
				configurable: true,
			})

			const noParamTemplate: CangjieTemplate = {
				id: "no-params-picker",
				title: "No Params",
				category: "executable",
				description: "No params template",
				body: "static content here",
				params: [],
			}
			// Inject the custom template
			;(library as any).templates.push(noParamTemplate)

			mockShowQuickPick.mockResolvedValueOnce({
				label: noParamTemplate.title,
				description: `[${noParamTemplate.category}]`,
				detail: noParamTemplate.description,
				template: noParamTemplate,
			})

			const mockDoc = {}
			mockOpenTextDocument.mockResolvedValueOnce(mockDoc)

			await library.showTemplatePicker()

			// No input boxes should have been shown
			expect(mockShowInputBox).not.toHaveBeenCalled()
			// Document should be opened with the static content
			expect(mockOpenTextDocument).toHaveBeenCalledTimes(1)
			const openArg = mockOpenTextDocument.mock.calls[0][0] as { content: string }
			expect(openArg.content).toBe("static content here")

			Object.defineProperty(vscode.window, "activeTextEditor", {
				value: undefined,
				configurable: true,
			})
		})

		it("cancels on second param after providing first param", async () => {
			const template = library.getById("exec-hello")!
			mockShowQuickPick.mockResolvedValueOnce({
				label: template.title,
				description: `[${template.category}]`,
				detail: template.description,
				template,
			})
			mockShowInputBox
				.mockResolvedValueOnce("provided_pkg") // packageName provided
				.mockResolvedValueOnce(undefined) // projectName cancelled

			await library.showTemplatePicker()

			// Should not have inserted anything
			expect(mockOpenTextDocument).not.toHaveBeenCalled()
			expect(mockShowTextDocument).not.toHaveBeenCalled()
		})

		it("builds quick-pick items with correct label, description, and detail", async () => {
			mockShowQuickPick.mockResolvedValueOnce(undefined)

			await library.showTemplatePicker()

			const items = mockShowQuickPick.mock.calls[0][0] as Array<{
				label: string
				description: string
				detail: string
				template: CangjieTemplate
			}>
			expect(items.length).toBe(library.getAll().length)
			for (const item of items) {
				expect(item.label).toBe(item.template.title)
				expect(item.description).toBe(`[${item.template.category}]`)
				expect(item.detail).toBe(item.template.description)
			}
		})
	})

	// -----------------------------------------------------------------------
	// Built-in templates validation
	// -----------------------------------------------------------------------
	describe("built-in templates validation", () => {
		it("each template has a unique id", () => {
			const templates = library.getAll()
			const ids = templates.map((t) => t.id)
			const uniqueIds = new Set(ids)
			expect(uniqueIds.size).toBe(ids.length)
		})

		it("each template param has valid name, label, and defaultValue", () => {
			const templates = library.getAll()
			for (const t of templates) {
				for (const param of t.params) {
					expect(typeof param.name).toBe("string")
					expect(param.name.length).toBeGreaterThan(0)
					expect(typeof param.label).toBe("string")
					expect(param.label.length).toBeGreaterThan(0)
					expect(typeof param.defaultValue).toBe("string")
				}
			}
		})

		it("each template body can be rendered without errors", () => {
			const templates = library.getAll()
			for (const t of templates) {
				expect(() => library.render(t, {})).not.toThrow()
			}
		})

		it("each rendered body does not contain unreplaced placeholders for its own params", () => {
			const templates = library.getAll()
			for (const t of templates) {
				const rendered = library.render(t, {})
				for (const param of t.params) {
					expect(rendered).not.toContain(`{{${param.name}}}`)
				}
			}
		})

		it("each template has a non-empty title, description, and valid category", () => {
			const validCategories = new Set([
				"executable",
				"library",
				"http-server",
				"cli-tool",
				"data-processing",
				"testing",
				"concurrency",
			])
			const templates = library.getAll()
			for (const t of templates) {
				expect(typeof t.title).toBe("string")
				expect(t.title.length).toBeGreaterThan(0)
				expect(typeof t.description).toBe("string")
				expect(t.description.length).toBeGreaterThan(0)
				expect(validCategories.has(t.category)).toBe(true)
			}
		})

		it("each template body is non-empty", () => {
			const templates = library.getAll()
			for (const t of templates) {
				expect(typeof t.body).toBe("string")
				expect(t.body.length).toBeGreaterThan(0)
			}
		})
	})
})
