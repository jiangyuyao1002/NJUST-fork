import { describe, expect, it } from "vitest"
import { recordSourceSchema, fileMetadataEntrySchema, taskMetadataSchema } from "../FileContextTrackerTypes"

describe("FileContextTrackerTypes", () => {
	describe("recordSourceSchema", () => {
		it("accepts valid record sources", () => {
			for (const src of ["read_tool", "user_edited", "njust_ai_edited", "file_mentioned"]) {
				expect(recordSourceSchema.parse(src)).toBe(src)
			}
		})

		it("rejects invalid record sources", () => {
			expect(() => recordSourceSchema.parse("invalid")).toThrow()
		})
	})

	describe("fileMetadataEntrySchema", () => {
		it("parses a valid entry", () => {
			const entry = {
				path: "src/foo.ts",
				record_state: "active" as const,
				record_source: "read_tool" as const,
				njust_ai_read_date: 1000,
				njust_ai_edit_date: null,
				user_edit_date: null,
			}
			expect(fileMetadataEntrySchema.parse(entry)).toEqual(entry)
		})

		it("parses entry with optional user_edit_date omitted", () => {
			const entry = {
				path: "src/bar.ts",
				record_state: "stale" as const,
				record_source: "njust_ai_edited" as const,
				njust_ai_read_date: null,
				njust_ai_edit_date: 2000,
			}
			const result = fileMetadataEntrySchema.parse(entry)
			expect(result.record_state).toBe("stale")
		})

		it("rejects entry missing required fields", () => {
			expect(() => fileMetadataEntrySchema.parse({})).toThrow()
		})
	})

	describe("taskMetadataSchema", () => {
		it("parses valid task metadata", () => {
			const meta = {
				files_in_context: [
					{
						path: "a.ts",
						record_state: "active",
						record_source: "read_tool",
						njust_ai_read_date: 100,
						njust_ai_edit_date: null,
					},
				],
			}
			expect(taskMetadataSchema.parse(meta)).toEqual(meta)
		})

		it("parses empty metadata", () => {
			expect(taskMetadataSchema.parse({ files_in_context: [] })).toEqual({ files_in_context: [] })
		})

		it("rejects metadata without files_in_context", () => {
			expect(() => taskMetadataSchema.parse({})).toThrow()
		})
	})
})
