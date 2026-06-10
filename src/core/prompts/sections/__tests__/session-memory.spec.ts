import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../../condense/sessionMemoryCompact", () => ({
	loadSessionMemories: vi.fn(),
	formatSessionMemoriesForPrompt: vi.fn(),
}))

import { loadSessionMemories, formatSessionMemoriesForPrompt } from "../../../condense/sessionMemoryCompact"
import { getSessionMemorySection } from "../session-memory"

const mockLoadSessionMemories = loadSessionMemories as ReturnType<typeof vi.fn>
const mockFormatSessionMemoriesForPrompt = formatSessionMemoriesForPrompt as ReturnType<typeof vi.fn>

describe("getSessionMemorySection", () => {
	const workspaceDir = "/test/workspace"

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should return empty string when no memories exist", async () => {
		mockLoadSessionMemories.mockResolvedValue([])

		const result = await getSessionMemorySection(workspaceDir)

		expect(result).toBe("")
	})

	it("should return formatted section when memories exist", async () => {
		const fakeMemories = [{ sessionId: "abc123", summary: "test summary" }]
		mockLoadSessionMemories.mockResolvedValue(fakeMemories)
		mockFormatSessionMemoriesForPrompt.mockReturnValue("formatted memory text")

		const result = await getSessionMemorySection(workspaceDir)

		expect(result).toContain("## Previous Session Context")
		expect(result).toContain("The following is a summary of recent work sessions in this workspace:")
		expect(result).toContain("formatted memory text")
	})

	it("should use default token budget of 3000", async () => {
		const fakeMemories = [{ sessionId: "abc123", summary: "test summary" }]
		mockLoadSessionMemories.mockResolvedValue(fakeMemories)
		mockFormatSessionMemoriesForPrompt.mockReturnValue("formatted")

		await getSessionMemorySection(workspaceDir)

		expect(mockFormatSessionMemoriesForPrompt).toHaveBeenCalledWith(fakeMemories, 3000)
	})

	it("should pass through custom token budget", async () => {
		const fakeMemories = [{ sessionId: "abc123", summary: "test summary" }]
		mockLoadSessionMemories.mockResolvedValue(fakeMemories)
		mockFormatSessionMemoriesForPrompt.mockReturnValue("formatted")

		await getSessionMemorySection(workspaceDir, 5000)

		expect(mockFormatSessionMemoriesForPrompt).toHaveBeenCalledWith(fakeMemories, 5000)
	})

	it("should call loadSessionMemories with workspaceDir and limit=3", async () => {
		mockLoadSessionMemories.mockResolvedValue([])

		await getSessionMemorySection(workspaceDir)

		expect(mockLoadSessionMemories).toHaveBeenCalledWith(workspaceDir, 3)
	})
})
