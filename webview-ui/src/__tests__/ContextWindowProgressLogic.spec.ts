// This test directly tests the logic of the ContextWindowProgress component calculations
// without needing to render the full component
import { calculateTokenDistribution } from "@src/utils/model-utils"

export {} // This makes the file a proper TypeScript module

describe("ContextWindowProgress Logic", () => {
	// Using the shared utility function from model-utils.ts instead of reimplementing it

	test("calculates correct token distribution with default 8192 reservation", () => {
		const contextWindow = 10000
		const contextTokens = 1000

		const result = calculateTokenDistribution(contextWindow, contextTokens)

		// Expected calculations:
		// reservedForOutput = 8192 (ANTHROPIC_DEFAULT_MAX_TOKENS)
		// availableSize = 10000 - 1000 - 8192 = 808
		expect(result.reservedForOutput).toBe(8192)
		expect(result.availableSize).toBe(808)

		// Check percentages - now relative to contextWindow
		expect(result.currentPercent).toBe(10) // 1000/10000 * 100 = 10%
		expect(result.reservedPercent).toBeCloseTo(81.92) // 8192/10000 * 100 = 81.92%
		expect(result.availablePercent).toBeCloseTo(8.08) // 808/10000 * 100 = 8.08%
	})

	test("uses provided maxTokens when available instead of default calculation", () => {
		const contextWindow = 10000
		const contextTokens = 1000

		// First calculate with default 8192 reservation (no maxTokens provided)
		const defaultResult = calculateTokenDistribution(contextWindow, contextTokens)

		// Then calculate with custom maxTokens value
		const customMaxTokens = 1500 // Custom maxTokens instead of default 8192
		const customResult = calculateTokenDistribution(contextWindow, contextTokens, customMaxTokens)

		// VERIFY MAXTOKEN PROP EFFECT: Custom maxTokens should be used directly instead of 8192 calculation
		const defaultReserved = 8192 // ANTHROPIC_DEFAULT_MAX_TOKENS
		expect(defaultResult.reservedForOutput).toBe(defaultReserved)
		expect(customResult.reservedForOutput).toBe(customMaxTokens) // Should use exact provided value

		// Verify the effect on available space
		expect(customResult.availableSize).toBe(10000 - 1000 - 1500) // 7500 tokens available
		expect(defaultResult.availableSize).toBe(10000 - 1000 - 8192) // 808 tokens available

		// Verify the effect on percentages - now relative to contextWindow
		expect(defaultResult.reservedPercent).toBeCloseTo(81.92) // 8192/10000 * 100 = 81.92%
		expect(customResult.reservedPercent).toBeCloseTo(15) // 1500/10000 * 100 = 15%
	})

	test("handles negative input values", () => {
		const contextWindow = 10000
		const contextTokens = -500 // Negative tokens should be handled gracefully

		const result = calculateTokenDistribution(contextWindow, contextTokens)

		// Expected calculations:
		// safeContextTokens = Math.max(0, -500) = 0
		// reservedForOutput = 8192 (ANTHROPIC_DEFAULT_MAX_TOKENS)
		// availableSize = 10000 - 0 - 8192 = 1808
		expect(result.currentPercent).toBeCloseTo(0) // 0/10000 * 100 = 0%
		expect(result.reservedPercent).toBeCloseTo(81.92) // 8192/10000 * 100 = 81.92%
		expect(result.availablePercent).toBeCloseTo(18.08) // 1808/10000 * 100 = 18.08%
	})

	test("handles zero context window gracefully", () => {
		const contextWindow = 0
		const contextTokens = 1000

		const result = calculateTokenDistribution(contextWindow, contextTokens)

		// With zero context window, the function uses ANTHROPIC_DEFAULT_MAX_TOKENS but available size becomes 0
		expect(result.reservedForOutput).toBe(8192) // ANTHROPIC_DEFAULT_MAX_TOKENS
		expect(result.availableSize).toBe(0) // max(0, 0 - 1000 - 8192) = 0

		// With zero context window, denominator falls back to reservedForOutput (8192)
		expect(result.currentPercent).toBeCloseTo((1000 / 8192) * 100, 5) // (1000/8192)*100 ≈ 12.207
		expect(result.reservedPercent).toBe(100) // (8192/8192)*100 = 100
	})

	test("handles case where tokens exceed context window", () => {
		const contextWindow = 10000
		const contextTokens = 12000 // More tokens than the window size

		const result = calculateTokenDistribution(contextWindow, contextTokens)

		// Expected calculations:
		// reservedForOutput = 8192 (ANTHROPIC_DEFAULT_MAX_TOKENS)
		// availableSize = Math.max(0, 10000 - 12000 - 8192) = 0
		expect(result.reservedForOutput).toBe(8192)
		expect(result.availableSize).toBe(0)

		// Percentages are now relative to contextWindow, so can exceed 100%
		expect(result.currentPercent).toBe(120) // 12000/10000 * 100 = 120%
		expect(result.reservedPercent).toBeCloseTo(81.92) // 8192/10000 * 100 = 81.92%
		expect(result.availablePercent).toBe(0)
	})

	test("handles very large context windows", () => {
		const contextWindow = 200000
		const contextTokens = 150000

		const result = calculateTokenDistribution(contextWindow, contextTokens)

		expect(result.currentPercent).toBe(75) // 150000/200000 * 100 = 75%
		expect(result.reservedPercent).toBeCloseTo(4.096) // 8192/200000 * 100 = 4.096%
		expect(result.availableSize).toBe(200000 - 150000 - 8192)
	})

	test("handles custom maxTokens that equals contextWindow", () => {
		// When maxTokens equals contextWindow, it's likely a configuration error
		const contextWindow = 100000
		const contextTokens = 50000

		const result = calculateTokenDistribution(contextWindow, contextTokens, contextWindow)

		// Should fall back to default since maxTokens === contextWindow is invalid
		expect(result.reservedForOutput).toBe(8192)
	})

	test("handles zero maxTokens", () => {
		const contextWindow = 100000
		const contextTokens = 50000

		const result = calculateTokenDistribution(contextWindow, contextTokens, 0)

		// Should fall back to default since maxTokens === 0 is invalid
		expect(result.reservedForOutput).toBe(8192)
	})
})
