import { AWS_INFERENCE_PROFILE_MAPPING } from "@njust-ai/core/providers"

/************************************************************************************
 *
 *     MODEL IDENTIFICATION HELPERS
 *
 *     Pure helpers used by AwsBedrockHandler for ARN parsing and
 *     cross-region inference profile prefix handling. The handler
 *     keeps thin private wrappers that delegate here so that test
 *     code that pokes at `handler.parseArn` / `handler.parseBaseModelId`
 *     still works.
 *
 *************************************************************************************/

/**
 * Strips the region prefix used on cross-region model inference ARNs.
 * Also strips the "global." prefix from global inference profiles.
 */
export function bedrockParseBaseModelId(modelId: string): string {
	if (!modelId) {
		return modelId
	}

	// Remove AWS cross-region inference profile prefixes
	// as defined in AWS_INFERENCE_PROFILE_MAPPING
	for (const [_, inferenceProfile] of AWS_INFERENCE_PROFILE_MAPPING) {
		if (modelId.startsWith(inferenceProfile)) {
			// Remove the inference profile prefix from the model ID
			return modelId.substring(inferenceProfile.length)
		}
	}

	// Also strip Global Inference profile prefix if present
	if (modelId.startsWith("global.")) {
		return modelId.substring("global.".length)
	}

	// Return the model ID as-is for all other cases
	return modelId
}

/**
 * Parse an Amazon Bedrock ARN and extract region, model type, and model id.
 * Supports foundation models, inference profiles, prompt routers, provisioned
 * throughput, and imported models across all AWS partitions.
 */
export function bedrockParseArn(arn: string, region?: string) {
	/*
	 * VIA Njust-AI analysis: platform-independent Regex. It's designed to parse Amazon Bedrock ARNs and doesn't rely on any platform-specific features
	 * like file path separators, line endings, or case sensitivity behaviors. The forward slashes in the regex are properly escaped and
	 * represent literal characters in the AWS ARN format, not filesystem paths. This regex will function consistently across Windows,
	 * macOS, Linux, and any other operating system where JavaScript runs.
	 *
	 * Supports any AWS partition (aws, aws-us-gov, aws-cn, or future partitions).
	 * The partition is not captured since we don't need to use it.
	 *
	 *  This matches ARNs like:
	 *  - Foundation Model: arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-v2
	 *  - GovCloud Inference Profile: arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0
	 *  - Prompt Router: arn:aws:bedrock:us-west-2:123456789012:prompt-router/anthropic-claude
	 *  - Inference Profile: arn:aws:bedrock:us-west-2:123456789012:inference-profile/anthropic.claude-v2
	 *  - Cross Region Inference Profile: arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0
	 *  - Custom Model (Provisioned Throughput): arn:aws:bedrock:us-west-2:123456789012:provisioned-model/my-custom-model
	 *  - Imported Model: arn:aws:bedrock:us-west-2:123456789012:imported-model/my-imported-model
	 *
	 * match[0] - The entire matched string
	 * match[1] - The region (e.g., "us-east-1", "us-gov-west-1")
	 * match[2] - The account ID (can be empty string for AWS-managed resources)
	 * match[3] - The resource type (e.g., "foundation-model")
	 * match[4] - The resource ID (e.g., "anthropic.claude-3-sonnet-20240229-v1:0")
	 */

	const arnRegex = /^arn:[^:]+:(?:bedrock|sagemaker):([^:]+):([^:]*):(?:([^/]+)\/([\w.\-:]+)|([^/]+))$/
	const match = arn.match(arnRegex)

	if (match?.[1] && match[3] && match[4]) {
		// Create the result object
		const result: {
			isValid: boolean
			region?: string
			modelType?: string
			modelId?: string
			errorMessage?: string
			crossRegionInference: boolean
		} = {
			isValid: true,
			crossRegionInference: false, // Default to false
		}

		result.modelType = match[3]
		const originalModelId = match[4]
		result.modelId = bedrockParseBaseModelId(originalModelId)

		// Extract the region from the first capture group
		const arnRegion = match[1]
		result.region = arnRegion

		// Check if the original model ID had a region prefix
		if (originalModelId && result.modelId !== originalModelId) {
			// If the model ID changed after parsing, it had a region prefix
			const prefix = originalModelId.replace(result.modelId, "")
			result.crossRegionInference = isSystemInferenceProfile(prefix)
		}

		// Check if region in ARN matches provided region (if specified)
		if (region && arnRegion !== region) {
			result.errorMessage = `Region mismatch: The region in your ARN (${arnRegion}) does not match your selected region (${region}). This may cause access issues. The provider will use the region from the ARN.`
			result.region = arnRegion
		}

		return result
	}

	// If we get here, the regex didn't match
	return {
		isValid: false,
		region: undefined,
		modelType: undefined,
		modelId: undefined,
		errorMessage: "Invalid ARN format. ARN should follow the Amazon Bedrock ARN pattern.",
		crossRegionInference: false,
	}
}

/**
 * Determines the AWS inference profile prefix for a given region.
 * Returns the prefix used in cross-region inference profile ARNs.
 */
export function getPrefixForRegion(region: string): string | undefined {
	// Use AWS recommended inference profile prefixes
	// Array is pre-sorted by pattern length (descending) to ensure more specific patterns match first
	for (const [regionPattern, inferenceProfile] of AWS_INFERENCE_PROFILE_MAPPING) {
		if (region.startsWith(regionPattern)) {
			return inferenceProfile
		}
	}

	return undefined
}

/**
 * Checks whether a given prefix is one of the AWS system inference profile prefixes.
 */
export function isSystemInferenceProfile(prefix: string): boolean {
	// Check if the prefix is defined in AWS_INFERENCE_PROFILE_MAPPING
	for (const [_, inferenceProfile] of AWS_INFERENCE_PROFILE_MAPPING) {
		if (prefix === inferenceProfile) {
			return true
		}
	}
	return false
}
