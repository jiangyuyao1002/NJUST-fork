import { describe, expect, it, beforeEach } from "vitest"
import { ShortTermMemory } from "../ShortTermMemory"
import { STM_MAX_CHARS } from "../constants"

describe("ShortTermMemory", () => {
	let stm: ShortTermMemory

	beforeEach(() => {
		stm = new ShortTermMemory()
	})

	describe("push", () => {
		it("appends entries and tracks charCount", () => {
			stm.push("user", "hello")
			stm.push("assistant", "world")
			expect(stm.getEntries()).toHaveLength(2)
			expect(stm.charCount).toBe(10)
		})

		it("sets role and content correctly", () => {
			stm.push("user", "question")
			const [e] = stm.getEntries()
			expect(e.role).toBe("user")
			expect(e.content).toBe("question")
			expect(typeof e.timestamp).toBe("number")
		})

		it("evicts oldest entry when charCount exceeds maxChars", () => {
			const small = new ShortTermMemory(10)
			small.push("user", "12345") // 5 chars
			small.push("user", "67890") // 5 chars, total = 10
			expect(small.getEntries()).toHaveLength(2)
			small.push("assistant", "X") // 1 char, total would be 11 → evict first
			expect(small.getEntries()).toHaveLength(2)
			expect(small.getEntries()[0]!.content).toBe("67890")
		})

		it("keeps at least one entry even if single entry exceeds maxChars", () => {
			const tiny = new ShortTermMemory(3)
			tiny.push("user", "toolong") // 7 chars
			expect(tiny.getEntries()).toHaveLength(1)
		})

		it("evicts multiple entries until within limit", () => {
			const small = new ShortTermMemory(5)
			small.push("user", "aaa") // 3
			small.push("user", "bbb") // 3, total 6 → evict "aaa", total 3
			small.push("user", "ccc") // 3, total 6 → evict "bbb", total 3
			expect(small.getEntries()).toHaveLength(1)
			expect(small.getEntries()[0]!.content).toBe("ccc")
		})
	})

	describe("getEntries", () => {
		it("returns readonly view", () => {
			stm.push("user", "hi")
			const entries = stm.getEntries()
			expect(entries).toHaveLength(1)
		})

		it("returns empty array when no entries", () => {
			expect(stm.getEntries()).toHaveLength(0)
		})
	})

	describe("summarize", () => {
		it("formats entries as role: content lines", () => {
			stm.push("user", "what is 2+2?")
			stm.push("assistant", "4")
			expect(stm.summarize()).toBe("user: what is 2+2?\nassistant: 4")
		})

		it("returns empty string when no entries", () => {
			expect(stm.summarize()).toBe("")
		})
	})

	describe("charCount", () => {
		it("returns 0 for empty STM", () => {
			expect(stm.charCount).toBe(0)
		})

		it("sums content lengths", () => {
			stm.push("user", "abc")
			stm.push("assistant", "de")
			expect(stm.charCount).toBe(5)
		})
	})

	describe("clear", () => {
		it("removes all entries and resets charCount", () => {
			stm.push("user", "content")
			stm.clear()
			expect(stm.getEntries()).toHaveLength(0)
			expect(stm.charCount).toBe(0)
		})
	})

	describe("default maxChars", () => {
		it("uses STM_MAX_CHARS constant", () => {
			const defaultStm = new ShortTermMemory()
			// Push just under limit — should not evict
			const large = "x".repeat(STM_MAX_CHARS - 1)
			defaultStm.push("user", large)
			expect(defaultStm.getEntries()).toHaveLength(1)
		})
	})
})
