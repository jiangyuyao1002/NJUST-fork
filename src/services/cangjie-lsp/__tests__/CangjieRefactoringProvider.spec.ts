import { describe, it, expect, vi, beforeEach } from "vitest"

const {
	mockShowInputBox,
	mockShowInformationMessage,
	mockApplyEdit,
	mockGetWorkspaceFolder,
	mockFindFiles,
	mockOpenTextDocument,
	mockShowTextDocument,
	mockReadFileSync,
	mockWriteFileSync,
	mockExistsSync,
	mockMkdirSync,
	mockUnlinkSync,
	mockParseDefinitions,
} = vi.hoisted(() => ({
	mockShowInputBox: vi.fn(),
	mockShowInformationMessage: vi.fn(),
	mockApplyEdit: vi.fn(),
	mockGetWorkspaceFolder: vi.fn(),
	mockFindFiles: vi.fn(),
	mockOpenTextDocument: vi.fn(),
	mockShowTextDocument: vi.fn(),
	mockReadFileSync: vi.fn().mockReturnValue(""),
	mockWriteFileSync: vi.fn(),
	mockExistsSync: vi.fn().mockReturnValue(true),
	mockMkdirSync: vi.fn(),
	mockUnlinkSync: vi.fn(),
	mockParseDefinitions: vi.fn().mockReturnValue([]),
}))

vi.mock("vscode", () => ({
	CodeAction: class {
		constructor(
			public title: string,
			public kind: unknown,
		) {}
	},
	CodeActionKind: {
		RefactorExtract: { value: "refactor.extract" },
		Refactor: { value: "refactor" },
	},
	window: {
		showInputBox: mockShowInputBox,
		showInformationMessage: mockShowInformationMessage,
		showTextDocument: mockShowTextDocument,
		activeTextEditor: undefined,
	},
	workspace: {
		applyEdit: mockApplyEdit,
		getWorkspaceFolder: mockGetWorkspaceFolder,
		findFiles: mockFindFiles,
		openTextDocument: mockOpenTextDocument,
	},
	WorkspaceEdit: class {
		replace = vi.fn()
		insert = vi.fn()
		delete = vi.fn()
		get size() {
			return this.replace.mock.calls.length + this.insert.mock.calls.length + this.delete.mock.calls.length
		}
	},
	Range: class {
		public start: any
		public end: any
		constructor(startLine: any, startChar: any, endLine?: any, endChar?: any) {
			if (endLine !== undefined) {
				this.start = { line: startLine, character: startChar }
				this.end = { line: endLine, character: endChar }
			} else {
				this.start = startLine
				this.end = startChar
			}
		}
	},
	Position: class {
		constructor(
			public line: number,
			public character: number,
		) {}
	},
	Selection: class {
		constructor(
			public anchor: unknown,
			public active: unknown,
		) {}
	},
	Uri: { file: (p: string) => ({ fsPath: p }) },
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: {
			...actual,
			readFileSync: mockReadFileSync,
			writeFileSync: mockWriteFileSync,
			existsSync: mockExistsSync,
			mkdirSync: mockMkdirSync,
			unlinkSync: mockUnlinkSync,
		},
		readFileSync: mockReadFileSync,
		writeFileSync: mockWriteFileSync,
		existsSync: mockExistsSync,
		mkdirSync: mockMkdirSync,
		unlinkSync: mockUnlinkSync,
	}
})

vi.mock("../tree-sitter/cangjieParser", () => ({
	parseCangjieDefinitions: mockParseDefinitions,
}))

vi.mock("../../../i18n", () => ({
	t: (key: string) => key,
}))

import { CangjieRefactoringProvider } from "../CangjieRefactoringProvider"

describe("CangjieRefactoringProvider", () => {
	let provider: CangjieRefactoringProvider
	let mockIndex: any

	beforeEach(() => {
		vi.clearAllMocks()
		mockIndex = { findDefinitions: vi.fn().mockReturnValue([]) }
		provider = new CangjieRefactoringProvider(mockIndex)
	})

	describe("provideCodeActions", () => {
		it("returns empty array when range is empty", () => {
			const doc = { getText: () => "", uri: {} } as any
			const range = { isEmpty: true } as any
			const result = provider.provideCodeActions(doc, range, { diagnostics: [] } as any, {} as any)
			expect(result).toEqual([])
		})

		it("returns extract action when range is not empty", () => {
			const doc = { getText: () => "let x = 1", uri: {} } as any
			const range = { isEmpty: false, start: { line: 0, character: 0 }, end: { line: 0, character: 9 } } as any
			const result = provider.provideCodeActions(doc, range, { diagnostics: [] } as any, {} as any)
			expect(result.length).toBe(1)
			expect(result[0].title).toContain("Extract")
		})
	})

	describe("dispose", () => {
		it("does not throw", () => {
			expect(() => provider.dispose()).not.toThrow()
		})
	})

	describe("extractFunction", () => {
		beforeEach(() => {
			mockParseDefinitions.mockReset()
			mockParseDefinitions.mockReturnValue([])
			mockApplyEdit.mockResolvedValue(undefined)
		})

		it("returns early when selected text is empty", async () => {
			const doc = {
				getText: () => "",
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } as any

			await provider.extractFunction(doc, range)

			expect(mockShowInputBox).not.toHaveBeenCalled()
			expect(mockApplyEdit).not.toHaveBeenCalled()
		})

		it("returns early when selected text is whitespace only", async () => {
			const doc = {
				getText: () => "   \n  \t  ",
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 5 } } as any

			await provider.extractFunction(doc, range)

			expect(mockShowInputBox).not.toHaveBeenCalled()
		})

		it("returns early when user cancels function name input", async () => {
			const doc = {
				getText: (_r: any) => "some code",
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } } as any
			mockShowInputBox.mockResolvedValueOnce(undefined)

			await provider.extractFunction(doc, range)

			expect(mockShowInputBox).toHaveBeenCalled()
			expect(mockApplyEdit).not.toHaveBeenCalled()
		})

		it("extracts successfully without free variables", async () => {
			const fullText = "func main(): Unit {\n\tprint(42)\n}"
			const doc = {
				getText: (r?: any) => (r ? "print(42)" : fullText),
				lineAt: () => ({ text: "\tprint(42)" }),
				lineCount: 3,
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 1, character: 1 }, end: { line: 1, character: 10 } } as any
			mockShowInputBox.mockResolvedValueOnce("extracted")
			mockParseDefinitions.mockReturnValue([])

			await provider.extractFunction(doc, range)

			expect(mockApplyEdit).toHaveBeenCalledTimes(1)
			const edit = mockApplyEdit.mock.calls[0][0]
			const calls = edit.replace.mock.calls
			expect(calls.length).toBe(1)
			// callSite: "\textracted()"
			expect(calls[0][2]).toBe("\textracted()")

			const insertCalls = edit.insert.mock.calls
			expect(insertCalls.length).toBe(1)
			// insertionLine = range.end.line + 2 = 3 (no enclosing), lineCount=3, min(3,3)=3
			expect(insertCalls[0][1]).toEqual({ line: 3, character: 0 })
			// funcDef should contain the function name and no parameters
			expect(insertCalls[0][2]).toContain("func extracted()")
			expect(insertCalls[0][2]).toContain("print(42)")
		})

		it("extracts with free variables detected in context", async () => {
			const doc = {
				getText: (r?: any) => {
					if (!r) return "let x: Int = 1\nlet z = x + 1\n"
					// Context: line 0 to start of selection (line 1)
					if (r.start && r.start.line === 0 && r.end && r.end.line === 1) {
						return "let x: Int = 1\n"
					}
					return "print(x)"
				},
				lineAt: () => ({ text: "print(x)" }),
				lineCount: 2,
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } } as any
			mockShowInputBox.mockResolvedValueOnce("extracted")
			mockParseDefinitions.mockReturnValue([])

			await provider.extractFunction(doc, range)

			expect(mockApplyEdit).toHaveBeenCalledTimes(1)
			const edit = mockApplyEdit.mock.calls[0][0]
			// callSite should include x as argument (only x is declared in context)
			expect(edit.replace.mock.calls[0][2]).toBe("extracted(x)")
			// funcDef should include x: Int as parameter (type capture includes trailing space from regex)
			expect(edit.insert.mock.calls[0][2]).toContain("extracted(x: Int ")
		})

		it("extracts with enclosing class using enclosing endLine", async () => {
			const doc = {
				getText: (r?: any) => {
					if (!r) return "class Foo {\n\tfunc bar(): Unit {\n\t\tsomeCode()\n\t}\n}"
					return "someCode()"
				},
				lineAt: () => ({ text: "\t\tsomeCode()" }),
				lineCount: 5,
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 2, character: 2 }, end: { line: 2, character: 12 } } as any
			mockShowInputBox.mockResolvedValueOnce("helper")
			mockParseDefinitions.mockReturnValue([{ kind: "class", name: "Foo", startLine: 0, endLine: 4 }])

			await provider.extractFunction(doc, range)

			expect(mockApplyEdit).toHaveBeenCalledTimes(1)
			const edit = mockApplyEdit.mock.calls[0][0]
			// insertionLine = enclosing[0].endLine = 4, min(4, 5) = 4
			expect(edit.insert.mock.calls[0][1]).toEqual({ line: 4, character: 0 })
			expect(edit.insert.mock.calls[0][2]).toContain("func helper()")
		})

		it("uses range.end.line + 2 when no enclosing type exists", async () => {
			const doc = {
				getText: (r?: any) => (r ? "someCode()" : "someCode()\n\n\n\n"),
				lineAt: () => ({ text: "someCode()" }),
				lineCount: 10,
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } } as any
			mockShowInputBox.mockResolvedValueOnce("extracted")
			mockParseDefinitions.mockReturnValue([])

			await provider.extractFunction(doc, range)

			const edit = mockApplyEdit.mock.calls[0][0]
			// insertionLine = range.end.line + 2 = 5, min(5, 10) = 5
			expect(edit.insert.mock.calls[0][1]).toEqual({ line: 5, character: 0 })
		})

		it("clamps insertion line to document lineCount", async () => {
			const doc = {
				getText: (r?: any) => (r ? "someCode()" : "short"),
				lineAt: () => ({ text: "someCode()" }),
				lineCount: 5,
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 3, character: 0 }, end: { line: 4, character: 10 } } as any
			mockShowInputBox.mockResolvedValueOnce("extracted")
			mockParseDefinitions.mockReturnValue([{ kind: "struct", name: "S", startLine: 0, endLine: 20 }])

			await provider.extractFunction(doc, range)

			const edit = mockApplyEdit.mock.calls[0][0]
			// insertionLine = enclosing.endLine = 20, but lineCount=5, min(20,5)=5
			expect(edit.insert.mock.calls[0][1]).toEqual({ line: 5, character: 0 })
		})

		it("filters out keywords from free variable candidates", async () => {
			const doc = {
				getText: (r?: any) => {
					if (!r) return "let x: Int = 1\nif (true) { return x }\n"
					if (r.start && r.start.line === 0 && r.end && r.end.line === 1) {
						return "let x: Int = 1\n"
					}
					return "if (true) { return x }"
				},
				lineAt: () => ({ text: "if (true) { return x }" }),
				lineCount: 2,
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 22 } } as any
			mockShowInputBox.mockResolvedValueOnce("extracted")
			mockParseDefinitions.mockReturnValue([])

			await provider.extractFunction(doc, range)

			expect(mockApplyEdit).toHaveBeenCalledTimes(1)
			const edit = mockApplyEdit.mock.calls[0][0]
			// 'if', 'true', 'return' are keywords and filtered out
			// only 'x' from context should be a parameter
			expect(edit.replace.mock.calls[0][2]).toBe("extracted(x)")
			expect(edit.insert.mock.calls[0][2]).toContain("extracted(x: Int ")
		})

		it("handles unknown identifiers with no matching declarations", async () => {
			const doc = {
				getText: (r?: any) => {
					if (!r) return "let x: Int = 1\nlet z = unknownFunc(x)\n"
					if (r.start && r.start.line === 0 && r.end && r.end.line === 1) {
						return "let x: Int = 1\n"
					}
					return "unknownFunc(x)"
				},
				lineAt: () => ({ text: "unknownFunc(x)" }),
				lineCount: 2,
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 1, character: 8 }, end: { line: 1, character: 22 } } as any
			mockShowInputBox.mockResolvedValueOnce("extracted")
			mockParseDefinitions.mockReturnValue([])

			await provider.extractFunction(doc, range)

			expect(mockApplyEdit).toHaveBeenCalledTimes(1)
			const edit = mockApplyEdit.mock.calls[0][0]
			// 'unknownFunc' is not declared in context, so not a free variable
			// only 'x' from context should be a parameter
			expect(edit.replace.mock.calls[0][2]).toBe("extracted(x)")
			expect(edit.insert.mock.calls[0][2]).toContain("extracted(x: Int ")
		})

		it("infers /* infer */ type when declaration has no type annotation", async () => {
			const doc = {
				getText: (r?: any) => {
					if (!r) return "let x = 42\nprint(x)\n"
					if (r.start && r.start.line === 0 && r.end && r.end.line === 1) {
						return "let x = 42\n"
					}
					return "print(x)"
				},
				lineAt: () => ({ text: "print(x)" }),
				lineCount: 2,
				uri: { fsPath: "/test.cj" },
			} as any
			const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } } as any
			mockShowInputBox.mockResolvedValueOnce("extracted")
			mockParseDefinitions.mockReturnValue([])

			await provider.extractFunction(doc, range)

			const edit = mockApplyEdit.mock.calls[0][0]
			// x is declared as `let x = 42` (no type annotation), so inferredType = "/* infer */"
			expect(edit.insert.mock.calls[0][2]).toContain("func extracted(x: /* infer */)")
		})
	})

	describe("moveFile", () => {
		beforeEach(() => {
			mockApplyEdit.mockResolvedValue(undefined)
			mockShowTextDocument.mockResolvedValue(undefined)
			mockFindFiles.mockResolvedValue([])
			mockOpenTextDocument.mockResolvedValue({ getText: () => "" })
		})

		it("returns early when no workspace folder", async () => {
			mockGetWorkspaceFolder.mockReturnValue(null)

			await provider.moveFile({ fsPath: "/project/src/A.cj" })

			expect(mockShowInputBox).not.toHaveBeenCalled()
		})

		it("returns early when user cancels input", async () => {
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: "/project" },
			})
			mockShowInputBox.mockResolvedValueOnce(undefined)

			await provider.moveFile({ fsPath: "/project/src/A.cj" })

			expect(mockShowInputBox).toHaveBeenCalled()
			expect(mockWriteFileSync).not.toHaveBeenCalled()
			expect(mockUnlinkSync).not.toHaveBeenCalled()
		})

		it("returns early when target path is same as source", async () => {
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: "/project" },
			})
			mockShowInputBox.mockResolvedValueOnce("src/A.cj")

			await provider.moveFile({ fsPath: "/project/src/A.cj" })

			expect(mockWriteFileSync).not.toHaveBeenCalled()
			expect(mockUnlinkSync).not.toHaveBeenCalled()
		})

		it("creates target directory when it does not exist", async () => {
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: "/workspace" },
			})
			mockShowInputBox.mockResolvedValueOnce("src/newDir/A.cj")
			mockExistsSync.mockReturnValue(false)
			mockReadFileSync.mockReturnValue("package foo\ncontent")

			await provider.moveFile({ fsPath: "/workspace/src/oldDir/A.cj" })

			expect(mockMkdirSync).toHaveBeenCalled()
			expect(mockWriteFileSync).toHaveBeenCalled()
			expect(mockUnlinkSync).toHaveBeenCalled()
		})

		it("does not create directory when it already exists", async () => {
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: "/workspace" },
			})
			mockShowInputBox.mockResolvedValueOnce("src/existingDir/A.cj")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("content")

			await provider.moveFile({ fsPath: "/workspace/src/oldDir/A.cj" })

			expect(mockMkdirSync).not.toHaveBeenCalled()
			expect(mockWriteFileSync).toHaveBeenCalled()
		})

		it("moves file and updates package declaration", async () => {
			const workspaceRoot = "/workspace"
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: workspaceRoot },
			})
			mockShowInputBox.mockResolvedValueOnce("src/bar/A.cj")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("package foo.bar\n\nclass A {}")
			mockOpenTextDocument.mockResolvedValue({ getText: () => "" })

			await provider.moveFile({ fsPath: "/workspace/src/foo/A.cj" })

			// Verify writeFileSync was called with updated package
			expect(mockWriteFileSync).toHaveBeenCalled()
			const writtenContent = mockWriteFileSync.mock.calls[0][1]
			expect(writtenContent).toContain("package bar")
			expect(writtenContent).not.toContain("package foo.bar")

			// Verify old file was deleted
			expect(mockUnlinkSync).toHaveBeenCalled()

			// Verify new file was opened
			expect(mockOpenTextDocument).toHaveBeenCalled()
			expect(mockShowTextDocument).toHaveBeenCalled()
		})

		it("moves file without package change in same directory", async () => {
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: "/workspace" },
			})
			mockShowInputBox.mockResolvedValueOnce("src/pkg/B.cj")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("package pkg\n\nclass A {}")
			mockOpenTextDocument.mockResolvedValue({ getText: () => "" })

			await provider.moveFile({ fsPath: "/workspace/src/pkg/A.cj" })

			// Content should be unchanged since package is the same
			expect(mockWriteFileSync).toHaveBeenCalled()
			const writtenContent = mockWriteFileSync.mock.calls[0][1]
			expect(writtenContent).toBe("package pkg\n\nclass A {}")

			expect(mockUnlinkSync).toHaveBeenCalled()
			expect(mockOpenTextDocument).toHaveBeenCalled()
			expect(mockShowTextDocument).toHaveBeenCalled()
		})

		it("moves file from src root to subdirectory without package update", async () => {
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: "/workspace" },
			})
			mockShowInputBox.mockResolvedValueOnce("src/pkg/A.cj")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("class A {}")
			mockOpenTextDocument.mockResolvedValue({ getText: () => "" })

			// Source is at src root -> oldPackage = undefined
			await provider.moveFile({ fsPath: "/workspace/src/A.cj" })

			// Content unchanged because oldPackage is undefined (dir === ".")
			expect(mockWriteFileSync).toHaveBeenCalled()
			const writtenContent = mockWriteFileSync.mock.calls[0][1]
			expect(writtenContent).toBe("class A {}")

			expect(mockUnlinkSync).toHaveBeenCalled()
			// No import update (applyEdit not called from updateImportReferences)
			expect(mockApplyEdit).not.toHaveBeenCalled()
		})

		it("moves file to src root without package update", async () => {
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: "/workspace" },
			})
			mockShowInputBox.mockResolvedValueOnce("src/A.cj")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("package foo\n\nclass A {}")
			mockOpenTextDocument.mockResolvedValue({ getText: () => "" })

			// Target is at src root -> newPackage = undefined
			await provider.moveFile({ fsPath: "/workspace/src/foo/A.cj" })

			// Content unchanged because newPackage is undefined
			expect(mockWriteFileSync).toHaveBeenCalled()
			const writtenContent = mockWriteFileSync.mock.calls[0][1]
			expect(writtenContent).toBe("package foo\n\nclass A {}")

			expect(mockUnlinkSync).toHaveBeenCalled()
			expect(mockApplyEdit).not.toHaveBeenCalled()
		})
	})

	describe("updateImportReferences (via moveFile)", () => {
		let editCallCount: number

		beforeEach(() => {
			editCallCount = 0
			mockApplyEdit.mockResolvedValue(undefined)
			mockShowTextDocument.mockResolvedValue(undefined)
			mockFindFiles.mockResolvedValue([])
			mockOpenTextDocument.mockResolvedValue({ getText: () => "" })
		})

		it("updates import references across workspace", async () => {
			const workspaceRoot = "/workspace"
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: workspaceRoot },
			})
			mockShowInputBox.mockResolvedValueOnce("src/bar/A.cj")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("package foo\n\nclass A {}")

			// For updateImportReferences:
			mockFindFiles.mockResolvedValue([{ fsPath: "/workspace/src/other/B.cj" }])
			mockOpenTextDocument.mockResolvedValue({
				getText: () => "import foo.*\n\nclass B {}",
			})

			mockApplyEdit.mockImplementation(async () => {
				editCallCount++
			})

			await provider.moveFile({ fsPath: "/workspace/src/foo/A.cj" })

			// applyEdit should be called once from updateImportReferences
			expect(editCallCount).toBe(1)
			expect(mockFindFiles).toHaveBeenCalledWith("**/*.cj", "**/target/**", 500)
		})

		it("skips unreadable files gracefully", async () => {
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: "/workspace" },
			})
			mockShowInputBox.mockResolvedValueOnce("src/bar/A.cj")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("package foo\n\nclass A {}")

			mockFindFiles.mockResolvedValue([
				{ fsPath: "/workspace/src/other/B.cj" },
				{ fsPath: "/workspace/src/other/C.cj" },
			])
			// First file is readable, second throws
			mockOpenTextDocument
				.mockResolvedValueOnce({ getText: () => "import foo.*" })
				.mockRejectedValueOnce(new Error("Cannot read file"))
				.mockResolvedValue({ getText: () => "" })

			mockApplyEdit.mockImplementation(async () => {
				editCallCount++
			})

			await provider.moveFile({ fsPath: "/workspace/src/foo/A.cj" })

			// Should still succeed - unreadable file is skipped
			// The readable file triggers applyEdit
			expect(editCallCount).toBe(1)
			// The new file is opened after updateImportReferences
			expect(mockOpenTextDocument).toHaveBeenCalledTimes(3) // 2 in updateImportReferences + 1 for new file
		})

		it("skips files that do not contain the old package name", async () => {
			mockGetWorkspaceFolder.mockReturnValue({
				uri: { fsPath: "/workspace" },
			})
			mockShowInputBox.mockResolvedValueOnce("src/bar/A.cj")
			mockExistsSync.mockReturnValue(true)
			mockReadFileSync.mockReturnValue("package foo\n\nclass A {}")

			mockFindFiles.mockResolvedValue([{ fsPath: "/workspace/src/other/B.cj" }])
			// File content doesn't contain old package "foo"
			mockOpenTextDocument
				.mockResolvedValueOnce({ getText: () => "class B {}" })
				.mockResolvedValue({ getText: () => "" })

			mockApplyEdit.mockImplementation(async () => {
				editCallCount++
			})

			await provider.moveFile({ fsPath: "/workspace/src/foo/A.cj" })

			// applyEdit should NOT be called since no files contain old package
			expect(editCallCount).toBe(0)
		})
	})
})
