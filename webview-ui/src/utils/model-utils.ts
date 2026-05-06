import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@njust-ai-cj/types"

/**
 * Result of token distribution calculation
 */
export interface TokenDistributionResult {
	/**
	 * Percentage of context window used by current tokens (0-100)
	 */
	currentPercent: number

	/**
	 * Percentage of context window reserved for model output (0-100)
	 */
	reservedPercent: number

	/**
	 * Percentage of context window still available (0-100)
	 */
	availablePercent: number

	/**
	 * Number of tokens reserved for model output
	 */
	reservedForOutput: number

	/**
	 * Number of tokens still available in the context window
	 */
	availableSize: number
}

/**
 * Calculates distribution of tokens within the context window
 * This is used for visualizing the token distribution in the UI
 *
 * @param contextWindow The total size of the context window
 * @param contextTokens The number of tokens currently used
 * @param maxTokens Optional override for tokens reserved for model output (otherwise uses 8192)
 * @returns Distribution of tokens with percentages and raw numbers
 */
export const calculateTokenDistribution = (
	contextWindow: number,
	contextTokens: number,
	maxTokens?: number,
): TokenDistributionResult => {
	// Handle potential invalid inputs with positive fallbacks
	const safeContextWindow = Math.max(0, contextWindow)
	const safeContextTokens = Math.max(0, contextTokens)

	// Get the actual max tokens value from the model
	// If maxTokens is valid (positive and not equal to context window), use it, otherwise reserve 8192 tokens as a default
	const reservedForOutput =
		maxTokens && maxTokens > 0 && maxTokens !== safeContextWindow ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS

	// Calculate sizes directly without buffer display
	const availableSize = Math.max(0, safeContextWindow - safeContextTokens - reservedForOutput)

	// Calculate percentages relative to the context window for consistent visualization.
	// When usage exceeds the window, the bar will overflow (clipped by overflow-hidden
	// in the UI) giving users an accurate sense of how far over the limit they are.
	const denominator = safeContextWindow > 0 ? safeContextWindow : reservedForOutput

	return {
		currentPercent: (safeContextTokens / denominator) * 100,
		reservedPercent: (reservedForOutput / denominator) * 100,
		availablePercent: (availableSize / denominator) * 100,
		reservedForOutput,
		availableSize,
	}
}
