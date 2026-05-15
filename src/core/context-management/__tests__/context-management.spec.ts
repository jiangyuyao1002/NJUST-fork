// cd src && npx vitest run core/context-management/__tests__/context-management.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@njust-ai-cj/types"
import { TelemetryService } from "@njust-ai-cj/telemetry"

import { BaseProvider } from "../../../api/providers/base-provider"
import { ApiMessage } from "../../task-persistence/apiMessages"
import * as condenseModule from "../../condense"

import {
	TOKEN_BUFFER_PERCENTAGE,
	estimateTokenCount,
	truncateConversation,
	manageContext,
	willManageContext,
} from "../index"

// Create a mock ApiHandler for testing
class MockApiHandler extends BaseProvider {
	createMessage(): any {
		// Mock implementation for testing - returns an async iterable stream
		const mockStream = {
			async *[Symbol.asyncIterator]() {
				yield { type: "text", text: "Mock summary content" }
				yield { type: "usage", inputTokens: 100, outputTokens: 50 }
			},
		}
		return mockStream
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				contextWindow: 100000,
				maxTokens: 50000,
				supportsPromptCache: true,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Test model",
			},
		}
	}
}

// Create a singleton instance for tests
const mockApiHandler = new MockApiHandler()
const taskId = "test-task-id"

describe("Context Management", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
	})
	/**
	 * Tests for the truncateConversation function
	 */
	describe("truncateConversation", () => {
		it("should retain the first message", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
			]

			const result = truncateConversation(messages, 0.5, taskId)

			// With 2 messages after the first, 0.5 fraction means remove 1 message
			// Odd count rounds up to even (2), so 2 messages are tagged
			// Non-destructive: messages remain but tagged with truncationParent + marker inserted
			expect(result.messages.length).toBe(4) // 3 original + 1 marker
			expect(result.messagesRemoved).toBe(2)
			expect(result.messages[0]).toEqual(messages[0])
		})

		it("should remove the specified fraction of messages (rounded to even number)", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "Fifth message" },
			]

			// 4 messages excluding first, 0.5 fraction = 2 messages to remove
			// 2 is already even, so no rounding needed
			const result = truncateConversation(messages, 0.5, taskId)

			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(6) // 5 original + 1 marker
			expect(result.messagesRemoved).toBe(2)
			expect(result.messages[0]).toEqual(messages[0])

			// Messages at indices 1 and 2 from original should be tagged
			expect(result.messages[1].truncationParent).toBe(result.truncationId)
			expect(result.messages[2].truncationParent).toBe(result.truncationId)

			// Marker should be at index 3 (at the boundary, after truncated messages)
			expect(result.messages[3].isTruncationMarker).toBe(true)
			expect(result.messages[3].role).toBe("user")

			// Messages at indices 3 and 4 from original should NOT be tagged (now at indices 4 and 5)
			expect(result.messages[4].truncationParent).toBeUndefined()
			expect(result.messages[5].truncationParent).toBeUndefined()
		})

		it("should round to an even number of messages to remove", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "Fifth message" },
				{ role: "assistant", content: "Sixth message" },
				{ role: "user", content: "Seventh message" },
			]

			// 6 messages excluding first, 0.3 fraction = 1.8 messages to remove
			// 1.8 rounds down to 1, then rounds up to 2 to make it even
			const result = truncateConversation(messages, 0.3, taskId)

			expect(result.messagesRemoved).toBe(2) // 2 messages tagged
			// Non-destructive: 7 original + 1 marker = 8
			expect(result.messages.length).toBe(8)
		})

		it("should handle edge case with fracToRemove = 0", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
			]

			const result = truncateConversation(messages, 0, taskId)

			expect(result.messagesRemoved).toBe(0)
			// When nothing is truncated, no marker is inserted
			expect(result.messages.length).toBe(3) // Original messages unchanged
		})

		it("should handle edge case with fracToRemove = 1", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
			]

			// 3 messages excluding first, 1.0 fraction = 3 messages to remove
			// 3 is odd, so it rounds up to 4 (but only 3 available, so 3 are tagged)
			// messagesRemoved reflects the calculated value (4)
			const result = truncateConversation(messages, 1, taskId)

			expect(result.messagesRemoved).toBe(4)
			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(5) // 4 original + 1 marker
			expect(result.messages[0]).toEqual(messages[0])

			// All non-first messages should be tagged
			expect(result.messages[1].truncationParent).toBe(result.truncationId)
			expect(result.messages[2].truncationParent).toBe(result.truncationId)
			expect(result.messages[3].truncationParent).toBe(result.truncationId)

			// Marker should be at the end
			expect(result.messages[4].isTruncationMarker).toBe(true)
			expect(result.messages[4].role).toBe("user")
		})
	})

	/**
	 * Tests for the estimateTokenCount function
	 */
	describe("estimateTokenCount", () => {
		it("should return 0 for empty or undefined content", async () => {
			expect(await estimateTokenCount([], mockApiHandler)).toBe(0)
			// @ts-expect-error - Testing with undefined
			expect(await estimateTokenCount(undefined, mockApiHandler)).toBe(0)
		})

		it("should estimate tokens for text blocks", async () => {
			const content: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "text", text: "This is a text block with 36 characters" },
			]

			// With tiktoken, the exact token count may differ from character-based estimation
			// Instead of expecting an exact number, we verify it's a reasonable positive number
			const result = await estimateTokenCount(content, mockApiHandler)
			expect(result).toBeGreaterThan(0)

			// We can also verify that longer text results in more tokens
			const longerContent: Array<Anthropic.Messages.ContentBlockParam> = [
				{
					type: "text",
					text: "This is a longer text block with significantly more characters to encode into tokens",
				},
			]
			const longerResult = await estimateTokenCount(longerContent, mockApiHandler)
			expect(longerResult).toBeGreaterThan(result)
		})

		it("should estimate tokens for image blocks based on data size", async () => {
			// Small image
			const smallImage: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "small_dummy_data" } },
			]
			// Larger image with more data
			const largerImage: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "X".repeat(1000) } },
			]

			// Verify images have positive token counts
			const smallImageTokens = await estimateTokenCount(smallImage, mockApiHandler)
			const largerImageTokens = await estimateTokenCount(largerImage, mockApiHandler)
			expect(smallImageTokens).toBeGreaterThan(0)
			expect(largerImageTokens).toBeGreaterThan(0)
		})

		it("should estimate tokens for mixed content blocks", async () => {
			const content: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "text", text: "A text block with 30 characters" },
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "dummy_data" } },
				{ type: "text", text: "Another text with 24 chars" },
			]

			// We know image tokens calculation should be consistent
			const imageTokens = Math.ceil(Math.sqrt("dummy_data".length)) * 1.5

			// With tiktoken, we can't predict exact text token counts,
			// but we can verify the total is greater than just the image tokens
			const result = await estimateTokenCount(content, mockApiHandler)
			expect(result).toBeGreaterThan(imageTokens)

			// Also test against a version with only the image to verify text adds tokens
			const imageOnlyContent: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "dummy_data" } },
			]
			const imageOnlyResult = await estimateTokenCount(imageOnlyContent, mockApiHandler)
			expect(result).toBeGreaterThan(imageOnlyResult)
		})

		it("should handle empty text blocks", async () => {
			const content: Array<Anthropic.Messages.ContentBlockParam> = [{ type: "text", text: "" }]
			expect(await estimateTokenCount(content, mockApiHandler)).toBe(0)
		})

		it("should handle plain string messages", async () => {
			const content = "This is a plain text message"
			expect(await estimateTokenCount([{ type: "text", text: content }], mockApiHandler)).toBeGreaterThan(0)
		})
	})

	/**
	 * Tests for the manageContext function
	 */
	describe("manageContext", () => {
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true,
			maxTokens,
		})

		const messages: ApiMessage[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "Fourth message" },
			{ role: "user", content: "Fifth message" },
		]
		it("should not truncate if tokens are below max tokens threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			// allowedTokens = contextWindow - maxTokens - TOKEN_BUFFER_TOKENS = 100000 - 30000 - 13000 = 57000
			const totalTokens = 50000 // Below allowedTokens

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Check no truncation path
			expect(result.messages).toEqual(messagesWithSmallContent)
			expect(result.summary).toBe("")
			expect(result.cost).toBe(0)
			expect(result.prevContextTokens).toBe(totalTokens)
		})

		it("should truncate if tokens are above max tokens threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Should have truncation
			expect(result.truncationId).toBeDefined()
			expect(result.messagesRemoved).toBe(2) // With 4 messages after first, 0.5 fraction = 2 to remove
			expect(result.summary).toBe("")
			expect(result.cost).toBe(0)
			expect(result.prevContextTokens).toBe(totalTokens)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result.messages.length).toBe(6) // 5 original + 1 marker
		})

		it("should work with non-prompt caching models the same as prompt caching models", async () => {
			// The implementation no longer differentiates between prompt caching and non-prompt caching models
			const modelInfo1 = createModelInfo(100000, 30000)
			const modelInfo2 = createModelInfo(100000, 30000)

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Test below threshold
			const belowThreshold = 69999
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: belowThreshold,
				contextWindow: modelInfo1.contextWindow,
				maxTokens: modelInfo1.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: belowThreshold,
				contextWindow: modelInfo2.contextWindow,
				maxTokens: modelInfo2.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// For truncation results, we can't compare messages directly because
			// truncationId is randomly generated. Compare structure instead.
			expect(result1.messages.length).toEqual(result2.messages.length)
			expect(result1.summary).toEqual(result2.summary)
			expect(result1.cost).toEqual(result2.cost)
			expect(result1.prevContextTokens).toEqual(result2.prevContextTokens)
			expect(result1.truncationId).toBeDefined()
			expect(result2.truncationId).toBeDefined()

			// Test above threshold
			const aboveThreshold = 70001
			const result3 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: aboveThreshold,
				contextWindow: modelInfo1.contextWindow,
				maxTokens: modelInfo1.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			const result4 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: aboveThreshold,
				contextWindow: modelInfo2.contextWindow,
				maxTokens: modelInfo2.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// For truncation results, we can't compare messages directly because
			// truncationId is randomly generated. Compare structure instead.
			expect(result3.messages.length).toEqual(result4.messages.length)
			expect(result3.summary).toEqual(result4.summary)
			expect(result3.cost).toEqual(result4.cost)
			expect(result3.prevContextTokens).toEqual(result4.prevContextTokens)
			expect(result3.truncationId).toBeDefined()
			expect(result4.truncationId).toBeDefined()
		})

		it("should consider incoming content when deciding to truncate", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const maxTokens = 30000
			const availableTokens = modelInfo.contextWindow - maxTokens

			// Test case 1: Small content that won't push us over the threshold
			const smallContent = [{ type: "text" as const, text: "Small content" }]
			const smallContentTokens = await estimateTokenCount(smallContent, mockApiHandler)
			const messagesWithSmallContent: ApiMessage[] = [
				...messages.slice(0, -1),
				{ role: messages[messages.length - 1].role, content: smallContent },
			]

			// Set base tokens so total is well below allowedTokens (contextWindow - maxTokens - TOKEN_BUFFER_TOKENS = 100000 - 30000 - 13000 = 57000)
			const baseTokensForSmall = 10000
			const resultWithSmall = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: baseTokensForSmall,
				contextWindow: modelInfo.contextWindow,
				maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(resultWithSmall).toMatchObject({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: baseTokensForSmall + smallContentTokens,
			}) // No truncation

			// Test case 2: Large content that will push us over the threshold
			const largeContent = [
				{
					type: "text" as const,
					text: "A very large incoming message that would consume a significant number of tokens and push us over the threshold",
				},
			]
			const largeContentTokens = await estimateTokenCount(largeContent, mockApiHandler)
			const messagesWithLargeContent: ApiMessage[] = [
				...messages.slice(0, -1),
				{ role: messages[messages.length - 1].role, content: largeContent },
			]

			// Set base tokens so we're just below threshold without content, but over with content
			const baseTokensForLarge = availableTokens - Math.floor(largeContentTokens / 2)
			const resultWithLarge = await manageContext({
				messages: messagesWithLargeContent,
				totalTokens: baseTokensForLarge,
				contextWindow: modelInfo.contextWindow,
				maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(resultWithLarge.messages).not.toEqual(messagesWithLargeContent) // Should truncate
			expect(resultWithLarge.summary).toBe("")
			expect(resultWithLarge.cost).toBe(0)
			expect(resultWithLarge.prevContextTokens).toBe(baseTokensForLarge + largeContentTokens)

			// Test case 3: Very large content that will definitely exceed threshold
			const veryLargeContent = [{ type: "text" as const, text: "X".repeat(1000) }]
			const veryLargeContentTokens = await estimateTokenCount(veryLargeContent, mockApiHandler)
			const messagesWithVeryLargeContent: ApiMessage[] = [
				...messages.slice(0, -1),
				{ role: messages[messages.length - 1].role, content: veryLargeContent },
			]

			// Set base tokens so we're just below threshold without content
			const baseTokensForVeryLarge = availableTokens - Math.floor(veryLargeContentTokens / 2)
			const resultWithVeryLarge = await manageContext({
				messages: messagesWithVeryLargeContent,
				totalTokens: baseTokensForVeryLarge,
				contextWindow: modelInfo.contextWindow,
				maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(resultWithVeryLarge.messages).not.toEqual(messagesWithVeryLargeContent) // Should truncate
			expect(resultWithVeryLarge.summary).toBe("")
			expect(resultWithVeryLarge.cost).toBe(0)
			expect(resultWithVeryLarge.prevContextTokens).toBe(baseTokensForVeryLarge + veryLargeContentTokens)
		})

		it("should truncate if tokens are within TOKEN_BUFFER_PERCENTAGE of the threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const dynamicBuffer = modelInfo.contextWindow * TOKEN_BUFFER_PERCENTAGE // 10% of 100000 = 10000
			const totalTokens = 70000 - dynamicBuffer + 1 // Just within the dynamic buffer of threshold (70000)

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Should have truncation
			expect(result.truncationId).toBeDefined()
			expect(result.messagesRemoved).toBe(2) // With 4 messages after first, 0.5 fraction = 2 to remove
			expect(result.summary).toBe("")
			expect(result.cost).toBe(0)
			expect(result.prevContextTokens).toBe(totalTokens)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result.messages.length).toBe(6) // 5 original + 1 marker
		})

		it("should use summarizeConversation when autoCondenseContext is true and tokens exceed threshold", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "This is a summary of the conversation"
			const mockCost = 0.05
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "user", content: mockSummary, isSummary: true },
					{ role: "assistant", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 100,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			// User content must be empty to prevent tryBuildLightweightSummary from intercepting
			const messagesWithSmallContent = messages.map((m) =>
				m.role === "user" ? { ...m, content: "" } : m,
			)

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was called with the right parameters
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
			})

			// Verify the result contains the summary information
			expect(result).toMatchObject({
				messages: mockSummarizeResponse.messages,
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})
			// newContextTokens might be present, but we don't need to verify its exact value

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should fall back to truncateConversation when autoCondenseContext is true but summarization fails", async () => {
			// Mock the summarizeConversation function to return an error
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: messages, // Original messages unchanged
				summary: "", // Empty summary
				cost: 0.01,
				error: "Summarization failed", // Error indicates failure
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			// User content must be empty to prevent tryBuildLightweightSummary from intercepting
			const messagesWithSmallContent = messages.map((m) =>
				m.role === "user" ? { ...m, content: "" } : m,
			)

			// When truncating, always uses 0.5 fraction
			// With 4 messages after the first, 0.5 fraction means remove 2 messages
			const _expectedMessages = [
				messagesWithSmallContent[0],
				messagesWithSmallContent[3],
				messagesWithSmallContent[4],
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was called
			expect(summarizeSpy).toHaveBeenCalled()

			// Verify it fell back to truncation (non-destructive)
			expect(result.truncationId).toBeDefined()
			expect(result.messagesRemoved).toBe(2)
			expect(result.summary).toBe("")
			expect(result.prevContextTokens).toBe(totalTokens)
			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(6) // 5 original + 1 marker
			// The cost might be different than expected, so we don't check it

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should not call summarizeConversation when autoCondenseContext is false", async () => {
			// Reset any previous mock calls
			vi.clearAllMocks()
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// When truncating, always uses 0.5 fraction
			// With 4 messages after the first, 0.5 fraction means remove 2 messages
			const _expectedMessages = [
				messagesWithSmallContent[0],
				messagesWithSmallContent[3],
				messagesWithSmallContent[4],
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 50, // This shouldn't matter since autoCondenseContext is false
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was not called
			expect(summarizeSpy).not.toHaveBeenCalled()

			// Verify it used truncation (non-destructive)
			expect(result.truncationId).toBeDefined()
			expect(result.messagesRemoved).toBe(2)
			expect(result.summary).toBe("")
			expect(result.cost).toBe(0)
			expect(result.prevContextTokens).toBe(totalTokens)
			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(6) // 5 original + 1 marker

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should use summarizeConversation when autoCondenseContext is true and context percent exceeds threshold", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "This is a summary of the conversation"
			const mockCost = 0.05
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "user", content: mockSummary, isSummary: true },
					{ role: "assistant", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 100,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			// Set tokens to be below the allowedTokens threshold but above the percentage threshold
			const contextWindow = modelInfo.contextWindow
			const totalTokens = 60000 // Below allowedTokens but 60% of context window
			// User content must be empty to prevent tryBuildLightweightSummary from intercepting
			const messagesWithSmallContent = messages.map((m) =>
				m.role === "user" ? { ...m, content: "" } : m,
			)

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // Set threshold to 50% - our tokens are at 60%
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was called with the right parameters
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
			})

			// Verify the result contains the summary information
			expect(result).toMatchObject({
				messages: mockSummarizeResponse.messages,
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should not use summarizeConversation when autoCondenseContext is true but context percent is below threshold", async () => {
			// Reset any previous mock calls
			vi.clearAllMocks()
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")

			const modelInfo = createModelInfo(100000, 30000)
			// Set tokens to be below both the allowedTokens threshold and the percentage threshold
			const contextWindow = modelInfo.contextWindow
			const totalTokens = 40000 // 40% of context window
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // Set threshold to 50% - our tokens are at 40%
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was not called
			expect(summarizeSpy).not.toHaveBeenCalled()

			// Verify no truncation or summarization occurred
			expect(result).toMatchObject({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		describe("compactFailures circuit breaker", () => {
			it("falls back to truncation when compactFailures reaches the limit", async () => {
				vi.clearAllMocks()
				const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")
				const modelInfo = createModelInfo(100000, 30000)
				const messagesWithSmallContent = messages.map((m) =>
					m.role === "user" ? { ...m, content: "" } : m,
				)

				const result = await manageContext({
					messages: messagesWithSmallContent,
					totalTokens: 70001,
					contextWindow: modelInfo.contextWindow,
					maxTokens: modelInfo.maxTokens,
					apiHandler: mockApiHandler,
					autoCondenseContext: true,
					autoCondenseContextPercent: 100,
					systemPrompt: "System prompt",
					taskId,
					profileThresholds: {},
					currentProfileId: "default",
					compactFailures: 3,
				})

				expect(summarizeSpy).not.toHaveBeenCalled()
				expect(result.truncationId).toBeDefined()
				expect(result.messagesRemoved).toBe(2)
				expect(result.error).toContain("Circuit breaker")
				expect(result.compactFailures).toBe(3)

				summarizeSpy.mockRestore()
			})

			it("uses condensation and resets compactFailures after a successful retry", async () => {
				const mockSummarizeResponse: condenseModule.SummarizeResponse = {
					messages: [
						{ role: "user", content: "First message" },
						{ role: "user", content: "Recovered summary", isSummary: true },
						{ role: "assistant", content: "Last message" },
					],
					summary: "Recovered summary",
					cost: 0.02,
					newContextTokens: 100,
				}
				const summarizeSpy = vi
					.spyOn(condenseModule, "summarizeConversation")
					.mockResolvedValue(mockSummarizeResponse)
				const modelInfo = createModelInfo(100000, 30000)
				const messagesWithSmallContent = messages.map((m) =>
					m.role === "user" ? { ...m, content: "" } : m,
				)

				const result = await manageContext({
					messages: messagesWithSmallContent,
					totalTokens: 70001,
					contextWindow: modelInfo.contextWindow,
					maxTokens: modelInfo.maxTokens,
					apiHandler: mockApiHandler,
					autoCondenseContext: true,
					autoCondenseContextPercent: 100,
					systemPrompt: "System prompt",
					taskId,
					profileThresholds: {},
					currentProfileId: "default",
					compactFailures: 2,
				})

				expect(summarizeSpy).toHaveBeenCalled()
				expect(result.summary).toBe("Recovered summary")
				expect(result.compactFailures).toBe(0)

				summarizeSpy.mockRestore()
			})

			it("increments compactFailures when condensation fails", async () => {
				const summarizeSpy = vi
					.spyOn(condenseModule, "summarizeConversation")
					.mockResolvedValue({
						messages,
						summary: "",
						cost: 0.01,
						error: "Summarization failed",
					})
				const modelInfo = createModelInfo(100000, 30000)
				const messagesWithSmallContent = messages.map((m) =>
					m.role === "user" ? { ...m, content: "" } : m,
				)

				const result = await manageContext({
					messages: messagesWithSmallContent,
					totalTokens: 70001,
					contextWindow: modelInfo.contextWindow,
					maxTokens: modelInfo.maxTokens,
					apiHandler: mockApiHandler,
					autoCondenseContext: true,
					autoCondenseContextPercent: 100,
					systemPrompt: "System prompt",
					taskId,
					profileThresholds: {},
					currentProfileId: "default",
					compactFailures: 2,
				})

				expect(summarizeSpy).toHaveBeenCalled()
				expect(result.truncationId).toBeDefined()
				expect(result.compactFailures).toBe(3)

				summarizeSpy.mockRestore()
			})
		})

		describe("isSubAgent path", () => {
			it("skips condensation and returns original messages when under the limit", async () => {
				vi.clearAllMocks()
				const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")
				const modelInfo = createModelInfo(100000, 30000)
				const messagesWithSmallContent = [
					...messages.slice(0, -1),
					{ ...messages[messages.length - 1], content: "" },
				]

				const result = await manageContext({
					messages: messagesWithSmallContent,
					totalTokens: 1000,
					contextWindow: modelInfo.contextWindow,
					maxTokens: modelInfo.maxTokens,
					apiHandler: mockApiHandler,
					autoCondenseContext: true,
					autoCondenseContextPercent: 1,
					systemPrompt: "System prompt",
					taskId,
					profileThresholds: {},
					currentProfileId: "default",
					isSubAgent: true,
				})

				expect(summarizeSpy).not.toHaveBeenCalled()
				expect(result.messages).toEqual(messagesWithSmallContent)
				expect(result.summary).toBe("")
				expect(result.cost).toBe(0)
				expect(result.truncationId).toBeUndefined()

				summarizeSpy.mockRestore()
			})

			it("falls back to truncation when a sub-agent is over the limit", async () => {
				vi.clearAllMocks()
				const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")
				const modelInfo = createModelInfo(100000, 30000)
				const messagesWithSmallContent = [
					...messages.slice(0, -1),
					{ ...messages[messages.length - 1], content: "" },
				]

				const result = await manageContext({
					messages: messagesWithSmallContent,
					totalTokens: 70001,
					contextWindow: modelInfo.contextWindow,
					maxTokens: modelInfo.maxTokens,
					apiHandler: mockApiHandler,
					autoCondenseContext: true,
					autoCondenseContextPercent: 100,
					systemPrompt: "System prompt",
					taskId,
					profileThresholds: {},
					currentProfileId: "default",
					isSubAgent: true,
				})

				expect(summarizeSpy).not.toHaveBeenCalled()
				expect(result.truncationId).toBeDefined()
				expect(result.messagesRemoved).toBe(2)
				expect(result.summary).toBe("")
				expect(result.cost).toBe(0)

				summarizeSpy.mockRestore()
			})
		})

		describe("lightweight summary path", () => {
			it("falls through to LLM condensation when lightweight summary has no source material", async () => {
				const summarizeSpy = vi
					.spyOn(condenseModule, "summarizeConversation")
					.mockResolvedValue({
						messages: [{ role: "user", content: "LLM summary", isSummary: true }],
						summary: "LLM summary",
						cost: 0.03,
					})
				const modelInfo = createModelInfo(100000, 30000)
				const emptySourceMessages = messages.map((m) =>
					m.role === "user" ? { ...m, content: "" } : m,
				)

				const result = await manageContext({
					messages: emptySourceMessages,
					totalTokens: 70001,
					contextWindow: modelInfo.contextWindow,
					maxTokens: modelInfo.maxTokens,
					apiHandler: mockApiHandler,
					autoCondenseContext: true,
					autoCondenseContextPercent: 100,
					systemPrompt: "System prompt",
					taskId,
					profileThresholds: {},
					currentProfileId: "default",
				})

				expect(summarizeSpy).toHaveBeenCalled()
				expect(result.summary).toBe("LLM summary")

				summarizeSpy.mockRestore()
			})

			it("generates a zero-cost summary from recent user context and file operations", async () => {
				vi.clearAllMocks()
				const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")
				const modelInfo = createModelInfo(100000, 30000)
				const lightweightMessages: ApiMessage[] = [
					{ role: "user", content: "Please update the dashboard filters." },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool-1",
								name: "write_to_file",
								input: { path: "src/dashboard.ts" },
							},
							{ type: "text", text: "Need to finish the TODO around saved filters." },
						],
					},
					{ role: "user", content: "Also keep the pending TODO visible." },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool-2",
								name: "apply_diff",
								input: { filePath: "src/filterStore.ts" },
							},
							{ type: "text", text: "Pending TODO: add regression coverage." },
						],
					},
					{ role: "user", content: "" },
				]

				const result = await manageContext({
					messages: lightweightMessages,
					totalTokens: 70001,
					contextWindow: modelInfo.contextWindow,
					maxTokens: modelInfo.maxTokens,
					apiHandler: mockApiHandler,
					autoCondenseContext: true,
					autoCondenseContextPercent: 100,
					systemPrompt: "System prompt",
					taskId,
					profileThresholds: {},
					currentProfileId: "default",
				})

				expect(summarizeSpy).not.toHaveBeenCalled()
				expect(result.cost).toBe(0)
				expect(result.summary).toContain("## Conversation Summary (auto-extracted)")
				expect(result.summary).toContain("Please update the dashboard filters.")
				expect(result.summary).toContain("src/dashboard.ts")
				expect(result.summary).toContain("src/filterStore.ts")
				expect(result.summary).toContain("write_to_file")
				expect(result.summary).toContain("Pending TODO: add regression coverage.")
				expect(result.messages.some((msg) => msg.isSummary)).toBe(true)

				summarizeSpy.mockRestore()
			})
		})
	})

	/**
	 * Tests for filesReadByRoo being passed to summarizeConversation
	 */
	describe("filesReadByRoo parameters", () => {
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true,
			maxTokens,
		})

		const messages: ApiMessage[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "Fourth message" },
			{ role: "user", content: "Fifth message" },
		]

		it("should pass filesReadByRoo, cwd, and rooIgnoreController to summarizeConversation when provided", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "Summary with folded context"
			const mockCost = 0.05
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "assistant", content: mockSummary, isSummary: true },
					{ role: "user", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 100,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			// User content must be empty to prevent tryBuildLightweightSummary from intercepting
			const messagesWithSmallContent = messages.map((m) =>
				m.role === "user" ? { ...m, content: "" } : m,
			)

			const filesReadByRoo = ["src/test.ts", "src/utils.ts"]
			const cwd = "/test/project"
			const mockRooIgnoreController = {
				filterPaths: vi.fn(),
			} as unknown as import("../../ignore/RooIgnoreController").RooIgnoreController

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
				filesReadByRoo,
				cwd,
				rooIgnoreController: mockRooIgnoreController,
			})

			// Verify summarizeConversation was called with filesReadByRoo, cwd, and rooIgnoreController
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
				filesReadByRoo,
				cwd,
				rooIgnoreController: mockRooIgnoreController,
			})

			// Verify the result contains the summary information (messages will have
			// an extra restore message from postCompactRestore, so don't match exactly)
			expect(result).toMatchObject({
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})
			// Verify that summarizeConversation returned messages are embedded in the result
			expect(result.messages[0]).toMatchObject({ role: "user", content: "First message" })
			expect(result.messages[1]).toMatchObject({ role: "assistant", content: mockSummary, isSummary: true })
			expect(result.messages[2]).toMatchObject({ role: "user", content: "Last message" })

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should pass undefined filesReadByRoo parameters when not provided", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "Summary without folded context"
			const mockCost = 0.03
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "assistant", content: mockSummary, isSummary: true },
					{ role: "user", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 80,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			// User content must be empty to prevent tryBuildLightweightSummary from intercepting
			const messagesWithSmallContent = messages.map((m) =>
				m.role === "user" ? { ...m, content: "" } : m,
			)

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
				// filesReadByRoo, cwd, rooIgnoreController are NOT provided
			})

			// Verify summarizeConversation was called with undefined parameters
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
			})

			// Verify the result (messages may have an extra restore message from
			// postCompactRestore if filesReadByRoo was provided)
			expect(result).toMatchObject({
				summary: mockSummary,
				cost: mockCost,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should pass empty array filesReadByRoo when provided as empty", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "Summary with empty file list"
			const mockCost = 0.04
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "assistant", content: mockSummary, isSummary: true },
					{ role: "user", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 90,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			// User content must be empty to prevent tryBuildLightweightSummary from intercepting
			const messagesWithSmallContent = messages.map((m) =>
				m.role === "user" ? { ...m, content: "" } : m,
			)

			const _result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
				filesReadByRoo: [], // Empty array
				cwd: "/test/project",
			})

			// Verify summarizeConversation was called with empty array
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
				filesReadByRoo: [],
				cwd: "/test/project",
			})

			// Clean up
			summarizeSpy.mockRestore()
		})
	})

	/**
	 * Tests for profile-specific thresholds functionality
	 */
	describe("profile-specific thresholds", () => {
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true,
			maxTokens,
		})

		const messages: ApiMessage[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "Fourth message" },
			{ role: "user", content: "Fifth message" },
		]

		/**
		 * Test that a profile's specific threshold is correctly used instead of the global threshold
		 * when defined in profileThresholds
		 */
		it("should use profile-specific threshold when enabled and profile has specific threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const profileThresholds = {
				"test-profile": 60, // Profile-specific threshold of 60%
			}
			const currentProfileId = "test-profile"
			const contextWindow = modelInfo.contextWindow

			// Set tokens to 65% of context window - above profile threshold (60%) but below global default (100%)
			const totalTokens = Math.floor(contextWindow * 0.65) // 65000 tokens

			// User content must be empty to prevent tryBuildLightweightSummary from intercepting
			const messagesWithSmallContent = messages.map((m) =>
				m.role === "user" ? { ...m, content: "" } : m,
			)

			// Mock the summarizeConversation function
			const mockSummary = "Profile-specific threshold summary"
			const mockCost = 0.03
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "user", content: mockSummary, isSummary: true },
					{ role: "assistant", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 100,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100, // Global threshold of 100%
				systemPrompt: "System prompt",
				taskId,
				profileThresholds,
				currentProfileId,
			})

			// Should use summarization because 65% > 60% (profile threshold)
			expect(summarizeSpy).toHaveBeenCalled()
			expect(result).toMatchObject({
				messages: mockSummarizeResponse.messages,
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		/**
		 * Test that when a profile's threshold is set to -1,
		 * the function correctly falls back to using the global autoCondenseContextPercent
		 */
		it("should fall back to global threshold when profile threshold is -1", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const profileThresholds = {
				"test-profile": -1, // Profile threshold set to -1 (use global)
			}
			const currentProfileId = "test-profile"
			const contextWindow = modelInfo.contextWindow

			// Set tokens to 80% of context window - above global threshold (75%) but would be below if profile had its own
			const totalTokens = Math.floor(contextWindow * 0.8) // 80000 tokens

			// User content must be empty to prevent tryBuildLightweightSummary from intercepting
			const messagesWithSmallContent = messages.map((m) =>
				m.role === "user" ? { ...m, content: "" } : m,
			)

			// Mock the summarizeConversation function
			const mockSummary = "Global threshold fallback summary"
			const mockCost = 0.04
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "user", content: mockSummary, isSummary: true },
					{ role: "assistant", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 120,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 75, // Global threshold of 75%
				systemPrompt: "System prompt",
				taskId,
				profileThresholds,
				currentProfileId,
			})

			// Should use summarization because 80% > 75% (global threshold, since profile is -1)
			expect(summarizeSpy).toHaveBeenCalled()
			expect(result).toMatchObject({
				messages: mockSummarizeResponse.messages,
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		/**
		 * Test that when a profile does not have a specific threshold defined,
		 * the function correctly falls back to the global default
		 */
		it("should fall back to global threshold when profile has no specific threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const profileThresholds = {
				"other-profile": 50, // Different profile has a threshold
			}
			const currentProfileId = "test-profile" // This profile is not in profileThresholds
			const contextWindow = modelInfo.contextWindow

			// Calculate allowedTokens: contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens
			// allowedTokens = 100000 * 0.9 - 30000 = 60000
			// Set tokens to be below both the global threshold (80%) and allowedTokens
			const totalTokens = 50000 // 50% of context window, well below 60000 allowedTokens and 80% threshold

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Reset any previous mock calls
			vi.clearAllMocks()
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 80, // Global threshold of 80%
				systemPrompt: "System prompt",
				taskId,
				profileThresholds,
				currentProfileId,
			})

			// Should NOT use summarization because 50% < 80% (global threshold, since profile has no specific threshold)
			// and totalTokens (50000) < allowedTokens (60000)
			expect(summarizeSpy).not.toHaveBeenCalled()
			expect(result).toMatchObject({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})
	})

	/**
	 * Tests for the getMaxTokens function (private but tested through manageContext)
	 */
	describe("getMaxTokens", () => {
		// We'll test this indirectly through manageContext
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true, // Not relevant for getMaxTokens
			maxTokens,
		})

		// Reuse across tests for consistency
		const messages: ApiMessage[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "Fourth message" },
			{ role: "user", content: "Fifth message" },
		]

		it("should use maxTokens as buffer when specified", async () => {
			const modelInfo = createModelInfo(100000, 50000)
			// Max tokens = 100000 - 50000 = 50000

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// allowedTokens = contextWindow - maxTokens - TOKEN_BUFFER_TOKENS = 100000 - 50000 - 13000 = 37000
			// Below max tokens and buffer - no truncation
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 35000, // Well below threshold + buffer
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result1).toMatchObject({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: 35000,
			})

			// Above max tokens - truncate
			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 50001, // Above threshold
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result2.messages).not.toEqual(messagesWithSmallContent)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result2.messages.length).toBe(6) // 5 original + 1 marker
			expect(result2.truncationId).toBeDefined()
			expect(result2.messagesRemoved).toBe(2)
			expect(result2.summary).toBe("")
			expect(result2.cost).toBe(0)
			expect(result2.prevContextTokens).toBe(50001)
		})

		it("should use ANTHROPIC_DEFAULT_MAX_TOKENS as buffer when maxTokens is undefined", async () => {
			const modelInfo = createModelInfo(100000, undefined)
			// Max tokens = 100000 - ANTHROPIC_DEFAULT_MAX_TOKENS = 100000 - 8192 = 91808

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// allowedTokens = contextWindow - ANTHROPIC_DEFAULT_MAX_TOKENS - TOKEN_BUFFER_TOKENS = 100000 - 8192 - 13000 = 78808
			// Below max tokens and buffer - no truncation
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 70000, // Well below threshold + buffer
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result1).toMatchObject({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: 70000,
			})

			// Above max tokens - truncate
			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 81809, // Above threshold (81808)
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result2.messages).not.toEqual(messagesWithSmallContent)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result2.messages.length).toBe(6) // 5 original + 1 marker
			expect(result2.truncationId).toBeDefined()
			expect(result2.summary).toBe("")
			expect(result2.cost).toBe(0)
			expect(result2.prevContextTokens).toBe(81809)
		})

		it("should handle small context windows appropriately", async () => {
			const modelInfo = createModelInfo(50000, 10000)
			// Max tokens = 50000 - 10000 = 40000

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// allowedTokens = contextWindow - maxTokens - TOKEN_BUFFER_TOKENS = 50000 - 10000 - 13000 = 27000
			// Below max tokens and buffer - no truncation
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 25000, // Well below threshold + buffer
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result1.messages).toEqual(messagesWithSmallContent)

			// Above max tokens - truncate
			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 40001, // Above threshold
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result2.messages).not.toEqual(messagesWithSmallContent)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result2.messages.length).toBe(6) // 5 original + 1 marker
			expect(result2.truncationId).toBeDefined()
		})

		it("should handle large context windows appropriately", async () => {
			const modelInfo = createModelInfo(200000, 30000)
			// Max tokens = 200000 - 30000 = 170000

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Account for the dynamic buffer which is 10% of context window (20,000 tokens for this test)
			// Below max tokens and buffer - no truncation
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 149999, // Well below threshold + dynamic buffer
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result1.messages).toEqual(messagesWithSmallContent)

			// Above max tokens - truncate
			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 170001, // Above threshold
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result2.messages).not.toEqual(messagesWithSmallContent)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result2.messages.length).toBe(6) // 5 original + 1 marker
			expect(result2.truncationId).toBeDefined()
		})
	})

	/**
	 * Tests for the willManageContext helper function
	 */
	describe("willManageContext", () => {
		it("should return true when context percent exceeds threshold", () => {
			const result = willManageContext({
				totalTokens: 60000,
				contextWindow: 100000, // 60% of context window
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // 50% threshold
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(result).toBe(true)
		})

		it("should return false when context percent is below threshold", () => {
			const result = willManageContext({
				totalTokens: 40000,
				contextWindow: 100000, // 40% of context window
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // 50% threshold
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(result).toBe(false)
		})

		it("should return true when tokens exceed allowedTokens even if autoCondenseContext is false", () => {
			// allowedTokens = contextWindow - maxTokens - TOKEN_BUFFER_TOKENS = 100000 - 30000 - 13000 = 57000
			const result = willManageContext({
				totalTokens: 58000, // Exceeds allowedTokens
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: false, // Even with auto-condense disabled
				autoCondenseContextPercent: 50,
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(result).toBe(true)
		})

		it("should return false when autoCondenseContext is false and tokens are below allowedTokens", () => {
			// allowedTokens = contextWindow - maxTokens - TOKEN_BUFFER_TOKENS = 100000 - 30000 - 13000 = 57000
			const result = willManageContext({
				totalTokens: 50000, // Below allowedTokens
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: false,
				autoCondenseContextPercent: 50, // This shouldn't matter since autoCondenseContext is false
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(result).toBe(false)
		})

		it("should use profile-specific threshold when available", () => {
			const result = willManageContext({
				totalTokens: 55000,
				contextWindow: 100000, // 55% of context window
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 80, // Global threshold 80%
				profileThresholds: { "test-profile": 50 }, // Profile threshold 50%
				currentProfileId: "test-profile",
				lastMessageTokens: 0,
			})
			// Should trigger because 55% > 50% (profile threshold)
			expect(result).toBe(true)
		})

		it("should fall back to global threshold when profile threshold is -1", () => {
			const result = willManageContext({
				totalTokens: 55000,
				contextWindow: 100000, // 55% of context window
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 80, // Global threshold 80%
				profileThresholds: { "test-profile": -1 }, // Profile uses global
				currentProfileId: "test-profile",
				lastMessageTokens: 0,
			})
			// Should NOT trigger because 55% < 80% (global threshold)
			expect(result).toBe(false)
		})

		it("should include lastMessageTokens in the calculation", () => {
			// Without lastMessageTokens: 47000 tokens = 47%
			// With lastMessageTokens: 47000 + 2000 = 49000 tokens = 49%
			// 49% is within nearCondenseThreshold of 50% (≥48.5)
			const resultWithoutLastMessage = willManageContext({
				totalTokens: 47000,
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // 50% threshold
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(resultWithoutLastMessage).toBe(false)

			const resultWithLastMessage = willManageContext({
				totalTokens: 47000,
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // 50% threshold
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 2000, // Pushes total to 49% (within nearCondenseThreshold)
			})
			expect(resultWithLastMessage).toBe(true)
		})
	})

	/**
	 * Tests for newContextTokensAfterTruncation including system prompt
	 */
	describe("newContextTokensAfterTruncation", () => {
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true,
			maxTokens,
		})

		it("should include system prompt tokens in newContextTokensAfterTruncation", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold to trigger truncation

			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "" }, // Small content in last message
			]

			const systemPrompt = "You are a helpful assistant. Follow these rules carefully."

			const result = await manageContext({
				messages,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt,
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Should have truncation
			expect(result.truncationId).toBeDefined()
			expect(result.newContextTokensAfterTruncation).toBeDefined()

			// The newContextTokensAfterTruncation should include system prompt tokens
			// Count system prompt tokens to verify
			const systemPromptTokens = await estimateTokenCount([{ type: "text", text: systemPrompt }], mockApiHandler)
			expect(systemPromptTokens).toBeGreaterThan(0)

			// newContextTokensAfterTruncation should be >= system prompt tokens
			// (since it includes system prompt + remaining message tokens)
			expect(result.newContextTokensAfterTruncation).toBeGreaterThanOrEqual(systemPromptTokens)
		})

		it("should produce consistent prev vs new token comparison (both including system prompt)", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold to trigger truncation

			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "" }, // Small content in last message
			]

			const systemPrompt = "System prompt for testing"

			const result = await manageContext({
				messages,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt,
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// After truncation, newContextTokensAfterTruncation should be less than prevContextTokens
			// because we removed some messages
			expect(result.newContextTokensAfterTruncation).toBeDefined()
			expect(result.newContextTokensAfterTruncation).toBeLessThan(result.prevContextTokens)

			// But newContextTokensAfterTruncation should still be a reasonable value
			// (not near-zero like the bug showed) - it should be at least
			// a significant fraction of prevContextTokens after 50% truncation
			// With system prompt included, we expect roughly 50% of the messages remaining
			expect(result.newContextTokensAfterTruncation).toBeGreaterThan(0)
		})
	})
})
