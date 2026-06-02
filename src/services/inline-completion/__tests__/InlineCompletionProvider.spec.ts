import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

const mockCangjieRun = vi.fn()
const mockGenericRun = vi.fn()

vi.mock("../CangjieCompletionEngine", () => ({
	CangjieCompletionEngine: class {
		constructor() {}
		run = mockCangjieRun
	},
}))

vi.mock("../GenericCompletionEngine", () => ({
	GenericCompletionEngine: class {
		constructor() {}
		run = mockGenericRun
	},
}))

vi.mock("../inlineCompletionApi", () => ({
	resolveInlineCompletionApiHandler: vi.fn().mockResolvedValue({}),
}))

const mockGetConfig = vi.fn()

vi.mock("vscode", () => {
	class CancellationTokenSource {
		private listeners: Array<() => void> = []
		readonly token = {
			isCancellationRequested: false,
			onCancellationRequested: (cb: () => void) => {
				this.listeners.push(cb)
				return { dispose: () => {} }
			},
		}
		cancel() {
			;(this.token as { isCancellationRequested: boolean }).isCancellationRequested = true
			for (const cb of this.listeners) cb()
		}
		dispose() {}
	}
	return {
		CancellationTokenSource,
		CancellationError: class CancellationError extends Error {},
		Range: class {
			constructor(
				public _a: unknown,
				public _b: unknown,
			) {}
		},
		InlineCompletionItem: class {
			insertText: string
			constructor(insertText: string, _range?: unknown) {
				this.insertText = insertText
			}
		},
		InlineCompletionTriggerKind: { Explicit: 0 as const, Automatic: 1 as const },
		workspace: {
			getConfiguration: (section?: string) => ({
				get: (k: string) => {
					if (section === "editor") {
						return undefined
					}
					return mockGetConfig(k)
				},
			}),
		},
	}
})

import * as vscode from "vscode"

import { CompletionCache } from "../CompletionCache"
import { debounceInlineDelay, InlineCompletionProvider } from "../InlineCompletionProvider"
import {
	limitMaxLines,
	normalizeInlineInsert,
	passesBasicBracketBalance,
	stripDuplicatePrefixFromInsert,
	stripFirstLineIfDuplicatesCurrentLine,
	stripMarkdownCodeFence,
	trimDuplicateLineSuffix,
} from "../completionPostProcess"

describe("CompletionCache", () => {
	it("stores and retrieves by key with TTL", () => {
		const cache = new CompletionCache({ maxEntries: 20, ttlMs: 60_000 })
		const key = cache.makeKey({
			filePath: "/a/b",
			line: 1,
			character: 2,
			prefixHash: "abc",
			engine: "generic",
		})
		cache.set(key, "x")
		expect(cache.get(key)).toBe("x")
	})

	it("evicts LRU when full", () => {
		const cache = new CompletionCache({ maxEntries: 2, ttlMs: 60_000 })
		const k1 = cache.makeKey({
			filePath: "a",
			line: 0,
			character: 0,
			prefixHash: "1",
			engine: "generic",
		})
		const k2 = cache.makeKey({
			filePath: "b",
			line: 0,
			character: 0,
			prefixHash: "2",
			engine: "generic",
		})
		const k3 = cache.makeKey({
			filePath: "c",
			line: 0,
			character: 0,
			prefixHash: "3",
			engine: "generic",
		})
		cache.set(k1, "1")
		cache.set(k2, "2")
		cache.set(k3, "3")
		expect(cache.get(k1)).toBeUndefined()
		expect(cache.get(k2)).toBe("2")
		expect(cache.get(k3)).toBe("3")
	})
})

describe("completionPostProcess", () => {
	it("strips markdown fences", () => {
		expect(stripMarkdownCodeFence("```cj\nlet x = 1\n```")).toBe("let x = 1")
	})

	it("limits lines", () => {
		expect(limitMaxLines("a\nb\nc", 2)).toBe("a\nb")
	})

	it("trims duplicate suffix on first line", () => {
		expect(trimDuplicateLineSuffix("()rest", "()")).toBe("rest")
	})

	it("strips first line when it echoes the full current line", () => {
		expect(stripFirstLineIfDuplicatesCurrentLine("function foo() {\n  x\n}", "function foo() {")).toBe("  x\n}")
	})

	it("strips duplicate prefix from insert", () => {
		expect(stripDuplicatePrefixFromInsert("return x;", "return ")).toBe("x;")
	})

	it("normalizeInlineInsert combines fence, echo, prefix, suffix", () => {
		const out = normalizeInlineInsert("```ts\nreturn y;\n```", {
			prefixBeforeCursor: "return ",
			lineSuffixAfterCursor: "",
			fullLineText: "return ",
			maxLines: 5,
		})
		expect(out).toBe("y;")
	})

	it("validates bracket balance", () => {
		expect(passesBasicBracketBalance("( )")).toBe(true)
		expect(passesBasicBracketBalance("(")).toBe(false)
	})
})

describe("debounceInlineDelay", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("waits for automatic trigger", async () => {
		const token = new vscode.CancellationTokenSource()
		const p = debounceInlineDelay(100, token.token, vscode.InlineCompletionTriggerKind.Automatic)
		await vi.advanceTimersByTimeAsync(100)
		await p
		token.dispose()
	})

	it("skips wait for explicit trigger", async () => {
		const token = new vscode.CancellationTokenSource()
		await debounceInlineDelay(100, token.token, vscode.InlineCompletionTriggerKind.Explicit)
		token.dispose()
	})
})

describe("InlineCompletionProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetConfig.mockImplementation(function (k: string) {
			if (k === "inlineCompletion.enabled") return true
			if (k === "inlineCompletion.triggerDelayMs") return 0
			if (k === "inlineCompletion.maxLines") return 10
			if (k === "inlineCompletion.enableCangjieEnhanced") return true
			return undefined
		})
		mockCangjieRun.mockResolvedValue("cj-out")
		mockGenericRun.mockResolvedValue("gen-out")
	})

	it("uses Cangjie engine for .cj files when enhanced", async () => {
		const cline = { getCurrentTask: () => undefined } as any
		const ext = { extensionPath: "/ext" } as vscode.ExtensionContext
		const provider = new InlineCompletionProvider(ext, cline)
		const doc = {
			uri: { fsPath: "/p/a.cj" },
			fileName: "/p/a.cj",
			languageId: "cangjie",
			lineAt: () => ({ text: "x" }),
		} as unknown as vscode.TextDocument
		const pos = { line: 0, character: 1 } as vscode.Position
		const ctx = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext
		const token = new vscode.CancellationTokenSource()
		const result = await provider.provideInlineCompletionItems(doc, pos, ctx, token.token)
		token.dispose()
		expect(mockCangjieRun).toHaveBeenCalled()
		expect(mockGenericRun).not.toHaveBeenCalled()
		expect(Array.isArray(result) && result[0]?.insertText).toBe("cj-out")
	})

	it("uses generic engine when Cangjie enhanced is off", async () => {
		mockGetConfig.mockImplementation(function (k: string) {
			if (k === "inlineCompletion.enabled") return true
			if (k === "inlineCompletion.triggerDelayMs") return 0
			if (k === "inlineCompletion.maxLines") return 10
			if (k === "inlineCompletion.enableCangjieEnhanced") return false
			return undefined
		})
		const cline = { getCurrentTask: () => undefined } as any
		const ext = { extensionPath: "/ext" } as vscode.ExtensionContext
		const provider = new InlineCompletionProvider(ext, cline)
		const doc = {
			uri: { fsPath: "/p/a.cj" },
			fileName: "/p/a.cj",
			languageId: "cangjie",
			lineAt: () => ({ text: "x" }),
		} as unknown as vscode.TextDocument
		const pos = { line: 0, character: 1 } as vscode.Position
		const ctx = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext
		const token = new vscode.CancellationTokenSource()
		await provider.provideInlineCompletionItems(doc, pos, ctx, token.token)
		token.dispose()
		expect(mockGenericRun).toHaveBeenCalled()
		expect(mockCangjieRun).not.toHaveBeenCalled()
	})

	it("returns null when cancelled after debounce", async () => {
		mockGetConfig.mockImplementation(function (k: string) {
			if (k === "inlineCompletion.enabled") return true
			if (k === "inlineCompletion.triggerDelayMs") return 50
			if (k === "inlineCompletion.maxLines") return 10
			if (k === "inlineCompletion.enableCangjieEnhanced") return false
			return undefined
		})
		vi.useFakeTimers()
		const cline = { getCurrentTask: () => undefined } as any
		const ext = { extensionPath: "/ext" } as vscode.ExtensionContext
		const provider = new InlineCompletionProvider(ext, cline)
		const doc = {
			uri: { fsPath: "/p/a.ts" },
			fileName: "/p/a.ts",
			languageId: "typescript",
			lineAt: () => ({ text: "x" }),
		} as unknown as vscode.TextDocument
		const pos = { line: 0, character: 1 } as vscode.Position
		const ctx = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext
		const token = new vscode.CancellationTokenSource()
		const p = provider.provideInlineCompletionItems(doc, pos, ctx, token.token)
		token.cancel()
		await vi.advanceTimersByTimeAsync(100)
		const result = await p
		vi.useRealTimers()
		token.dispose()
		expect(result).toBeNull()
	})

	it("returns cached result without calling engine twice", async () => {
		const cline = { getCurrentTask: () => undefined } as any
		const ext = { extensionPath: "/ext" } as vscode.ExtensionContext
		const provider = new InlineCompletionProvider(ext, cline)
		const doc = {
			uri: { fsPath: "/p/a.ts" },
			fileName: "/p/a.ts",
			languageId: "typescript",
			lineAt: () => ({ text: "same" }),
		} as unknown as vscode.TextDocument
		const pos = { line: 0, character: 4 } as vscode.Position
		const ctx = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic } as vscode.InlineCompletionContext
		const token1 = new vscode.CancellationTokenSource()
		await provider.provideInlineCompletionItems(doc, pos, ctx, token1.token)
		token1.dispose()
		const token2 = new vscode.CancellationTokenSource()
		const second = await provider.provideInlineCompletionItems(doc, pos, ctx, token2.token)
		token2.dispose()
		expect(mockGenericRun).toHaveBeenCalledTimes(1)
		expect(Array.isArray(second) && second[0]?.insertText).toBe("gen-out")
	})
})
