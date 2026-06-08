import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockUnlinkSync } = vi.hoisted(() => ({
	mockUnlinkSync: vi.fn(),
}))

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return {
		...actual,
		default: { ...actual, unlinkSync: mockUnlinkSync },
		unlinkSync: mockUnlinkSync,
	}
})

import { safeUnlink } from "../safeUnlink"

describe("safeUnlink", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls fs.unlinkSync with the given path", () => {
		safeUnlink("/tmp/test.cj")
		expect(mockUnlinkSync).toHaveBeenCalledWith("/tmp/test.cj")
	})

	it("silently ignores when file does not exist", () => {
		mockUnlinkSync.mockImplementation(() => {
			throw new Error("ENOENT: no such file or directory")
		})
		expect(() => safeUnlink("/tmp/nonexistent.cj")).not.toThrow()
	})

	it("silently ignores permission errors", () => {
		mockUnlinkSync.mockImplementation(() => {
			throw new Error("EACCES: permission denied")
		})
		expect(() => safeUnlink("/tmp/locked.cj")).not.toThrow()
	})

	it("silently ignores any error", () => {
		mockUnlinkSync.mockImplementation(() => {
			throw new Error("unknown error")
		})
		expect(() => safeUnlink("/tmp/any.cj")).not.toThrow()
	})
})
