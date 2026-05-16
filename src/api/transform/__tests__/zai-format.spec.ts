import { describe, expect, it } from "vitest"
import type { Anthropic } from "@anthropic-ai/sdk"

import { convertToZAiFormat } from "../zai-format"

describe("convertToZAiFormat", () => {
	it("converts string user and assistant messages", () => {
		const result = convertToZAiFormat([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		])

		expect(result).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		])
	})

	it("merges consecutive user text messages", () => {
		const result = convertToZAiFormat([
			{ role: "user", content: "one" },
			{ role: "user", content: "two" },
		])

		expect(result).toEqual([{ role: "user", content: "one\ntwo" }])
	})

	it("converts image blocks into OpenAI image_url parts", () => {
		const result = convertToZAiFormat([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
				],
			},
		] as Anthropic.Messages.MessageParam[])

		expect(result).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
				],
			},
		])
	})

	it("converts assistant tool_use blocks to OpenAI tool_calls", () => {
		const result = convertToZAiFormat([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading" },
					{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } },
				],
			},
		] as Anthropic.Messages.MessageParam[])

		expect(result[0]).toMatchObject({
			role: "assistant",
			content: "reading",
			tool_calls: [
				{
					id: "tool-1",
					type: "function",
					function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
				},
			],
		})
	})

	it("converts tool_result blocks to tool messages", () => {
		const result = convertToZAiFormat([
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file content" }],
			},
		] as Anthropic.Messages.MessageParam[])

		expect(result).toEqual([{ role: "tool", tool_call_id: "tool-1", content: "file content" }])
	})

	it("converts array tool_result content and marks images", () => {
		const result = convertToZAiFormat([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content: [
							{ type: "text", text: "ok" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
						],
					},
				],
			},
		] as Anthropic.Messages.MessageParam[])

		expect(result).toEqual([{ role: "tool", tool_call_id: "tool-1", content: "ok\n(image)" }])
	})

	it("merges text after tool_result into last tool message when enabled", () => {
		const result = convertToZAiFormat(
			[
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "tool-1", content: "file content" },
						{ type: "text", text: "environment details" },
					],
				},
			] as Anthropic.Messages.MessageParam[],
			{ mergeToolResultText: true },
		)

		expect(result).toEqual([{ role: "tool", tool_call_id: "tool-1", content: "file content\n\nenvironment details" }])
	})

	it("keeps text after tool_result as user message when merge disabled", () => {
		const result = convertToZAiFormat([
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "tool-1", content: "file content" },
					{ type: "text", text: "environment details" },
				],
			},
		] as Anthropic.Messages.MessageParam[])

		expect(result).toEqual([
			{ role: "tool", tool_call_id: "tool-1", content: "file content" },
			{ role: "user", content: "environment details" },
		])
	})

	it("preserves top-level assistant reasoning_content", () => {
		const result = convertToZAiFormat([
			{ role: "assistant", content: "answer", reasoning_content: "thinking" } as Anthropic.Messages.MessageParam & {
				reasoning_content: string
			},
		])

		expect(result).toEqual([{ role: "assistant", content: "answer", reasoning_content: "thinking" }])
	})

	it("extracts reasoning content blocks and merges consecutive assistant text", () => {
		const result = convertToZAiFormat([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "one" },
					{ type: "reasoning", text: "r1" } as any,
				],
			},
			{ role: "assistant", content: "two", reasoning_content: "r2" } as Anthropic.Messages.MessageParam & {
				reasoning_content: string
			},
		] as Anthropic.Messages.MessageParam[])

		expect(result).toEqual([{ role: "assistant", content: "one\ntwo", reasoning_content: "r2" }])
	})
})
