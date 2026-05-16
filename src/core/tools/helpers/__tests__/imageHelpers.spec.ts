import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	stat: vi.fn(),
}))

vi.mock("../../../../i18n", () => ({
	t: vi.fn((key: string, params?: Record<string, unknown>) => `${key}:${params?.size ?? ""}:${params?.max ?? ""}`),
}))

import * as fs from "fs/promises"
import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB,
	ImageMemoryTracker,
	isSupportedImageFormat,
	processImageFile,
	readImageAsDataUrlWithBuffer,
	validateImageForProcessing,
} from "../imageHelpers"

describe("imageHelpers", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it.each([".png", ".JPG", ".jpeg", ".webp", ".svg", ".avif"])("supports image extension %s", (extension) => {
		expect(isSupportedImageFormat(extension)).toBe(true)
	})

	it.each([".txt", ".md", "", ".pdf"])("rejects non-image extension %s", (extension) => {
		expect(isSupportedImageFormat(extension)).toBe(false)
	})

	it("reads image as data URL with detected mime type", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("image"))

		const result = await readImageAsDataUrlWithBuffer("photo.webp")

		expect(result.buffer.toString()).toBe("image")
		expect(result.dataUrl).toBe(`data:image/webp;base64,${Buffer.from("image").toString("base64")}`)
	})

	it("falls back to png mime type for unknown extensions", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("image"))

		await expect(readImageAsDataUrlWithBuffer("photo.unknown")).resolves.toMatchObject({
			dataUrl: expect.stringContaining("data:image/png;base64,"),
		})
	})

	it("rejects images when model does not support images", async () => {
		await expect(validateImageForProcessing("a.png", false, 5, 20, 0)).resolves.toMatchObject({
			isValid: false,
			reason: "unsupported_model",
		})
		expect(fs.stat).not.toHaveBeenCalled()
	})

	it("rejects image above per-file size limit", async () => {
		vi.mocked(fs.stat).mockResolvedValueOnce({ size: 6 * 1024 * 1024 } as any)

		await expect(validateImageForProcessing("a.png", true, 5, 20, 0)).resolves.toMatchObject({
			isValid: false,
			reason: "size_limit",
			sizeInMB: 6,
		})
	})

	it("rejects image above total memory limit", async () => {
		vi.mocked(fs.stat).mockResolvedValueOnce({ size: 6 * 1024 * 1024 } as any)

		await expect(validateImageForProcessing("a.png", true, 10, 20, 15)).resolves.toMatchObject({
			isValid: false,
			reason: "memory_limit",
			sizeInMB: 6,
		})
	})

	it("accepts image within configured limits", async () => {
		vi.mocked(fs.stat).mockResolvedValueOnce({ size: 2 * 1024 * 1024 } as any)

		await expect(validateImageForProcessing("a.png", true, 5, 20, 1)).resolves.toEqual({
			isValid: true,
			sizeInMB: 2,
		})
	})

	it("processes image file with size metadata", async () => {
		vi.mocked(fs.stat).mockResolvedValueOnce({ size: 1536 } as any)
		vi.mocked(fs.readFile).mockResolvedValueOnce(Buffer.from("image"))

		const result = await processImageFile("photo.png")

		expect(result.sizeInKB).toBe(2)
		expect(result.sizeInMB).toBe(1536 / (1024 * 1024))
		expect(result.dataUrl).toContain("data:image/png;base64,")
		expect(result.notice).toContain("tools:readFile.imageWithSize")
	})

	it("tracks image memory usage", () => {
		const tracker = new ImageMemoryTracker()

		tracker.addMemoryUsage(1.5)
		tracker.addMemoryUsage(2)
		expect(tracker.getTotalMemoryUsed()).toBe(3.5)

		tracker.reset()
		expect(tracker.getTotalMemoryUsed()).toBe(0)
	})

	it("exports default size constants", () => {
		expect(DEFAULT_MAX_IMAGE_FILE_SIZE_MB).toBe(5)
		expect(DEFAULT_MAX_TOTAL_IMAGE_SIZE_MB).toBe(20)
	})
})
