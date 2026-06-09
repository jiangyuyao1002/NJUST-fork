import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime"

import { logger } from "../../utils/logging"
import { getErrorMessage } from "../../shared/error-utils"

import { isBedrockError } from "./bedrock-types"

import type { ModelInfo } from "@njust-ai/types"

/************************************************************************************
 *
 *     ERROR TYPES
 *
 *************************************************************************************/

/**
 * Error type definitions for Bedrock API errors
 */
export const BEDROCK_ERROR_TYPES: Record<
	string,
	{
		patterns: string[] // Strings to match in lowercase error message or name
		messageTemplate: string // Template with placeholders like {region}, {modelId}, etc.
		logLevel: "error" | "warn" | "info" // Log level for this error type
	}
> = {
	ACCESS_DENIED: {
		patterns: ["access", "denied", "permission"],
		messageTemplate: `You don't have access to the model specified.

Please verify:
1. Try cross-region inference if you're using a foundation model
2. If using an ARN, verify the ARN is correct and points to a valid model
3. Your AWS credentials have permission to access this model (check IAM policies)
4. The region in the ARN matches the region where the model is deployed
5. If using a provisioned model, ensure it's active and not in a failed state`,
		logLevel: "error",
	},
	NOT_FOUND: {
		patterns: ["not found", "does not exist"],
		messageTemplate: `The specified ARN does not exist or is invalid. Please check:

1. The ARN format is correct (arn:aws:bedrock:region:account-id:resource-type/resource-name)
2. The model exists in the specified region
3. The account ID in the ARN is correct`,
		logLevel: "error",
	},
	THROTTLING: {
		patterns: [
			"throttl",
			"rate",
			"limit",
			"bedrock is unable to process your request", // Amazon Bedrock specific throttling message
			"please wait",
			"quota exceeded",
			"service unavailable",
			"busy",
			"overloaded",
			"too many requests",
			"request limit",
			"concurrent requests",
		],
		messageTemplate: `Request was throttled or rate limited. Please try:
1. Reducing the frequency of requests
2. If using a provisioned model, check its throughput settings
3. Contact AWS support to request a quota increase if needed

`,
		logLevel: "error",
	},
	TOO_MANY_TOKENS: {
		patterns: ["too many tokens", "token limit exceeded", "context length", "maximum context length"],
		messageTemplate: `"Too many tokens" error detected.
Possible Causes:
1. Input exceeds model's context window limit
2. Rate limiting (too many tokens per minute)
3. Quota exceeded for token usage
4. Other token-related service limitations

Suggestions:
1. Reduce the size of your input
2. Split your request into smaller chunks
3. Use a model with a larger context window
4. If rate limited, reduce request frequency
5. Check your Amazon Bedrock quotas and limits

`,
		logLevel: "error",
	},
	SERVICE_QUOTA_EXCEEDED: {
		patterns: ["service quota exceeded", "service quota", "quota exceeded for model"],
		messageTemplate: `Service quota exceeded. This error indicates you've reached AWS service limits.

Please try:
1. Contact AWS support to request a quota increase
2. Reduce request frequency temporarily
3. Check your Amazon Bedrock quotas in the AWS console
4. Consider using a different model or region with available capacity

`,
		logLevel: "error",
	},
	MODEL_NOT_READY: {
		patterns: ["model not ready", "model is not ready", "provisioned throughput not ready", "model loading"],
		messageTemplate: `Model is not ready or still loading. This can happen with:
1. Provisioned throughput models that are still initializing
2. Custom models that are being loaded
3. Models that are temporarily unavailable

Please try:
1. Wait a few minutes and retry
2. Check the model status in Amazon Bedrock console
3. Verify the model is properly provisioned

`,
		logLevel: "error",
	},
	INTERNAL_SERVER_ERROR: {
		patterns: ["internal server error", "internal error", "server error", "service error"],
		messageTemplate: `Amazon Bedrock internal server error. This is a temporary service issue.

Please try:
1. Retry the request after a brief delay
2. If the error persists, check AWS service health
3. Contact AWS support if the issue continues

`,
		logLevel: "error",
	},
	ON_DEMAND_NOT_SUPPORTED: {
		patterns: ["with on-demand throughput isn't supported."],
		messageTemplate: `
1. Try enabling cross-region inference in settings.
2. Or, create an inference profile and then leverage the "Use custom ARN..." option of the model selector in settings.`,
		logLevel: "error",
	},
	ABORT: {
		patterns: ["aborterror"], // This will match error.name.toLowerCase() for AbortError
		messageTemplate: `Request was aborted: The operation timed out or was manually cancelled. Please try again or check your network connection.`,
		logLevel: "info",
	},
	INVALID_ARN_FORMAT: {
		patterns: ["invalid_arn_format:", "invalid arn format"],
		messageTemplate: `Invalid ARN format. ARN should follow the pattern: arn:aws:bedrock:region:account-id:resource-type/resource-name`,
		logLevel: "error",
	},
	VALIDATION_ERROR: {
		patterns: [
			"input tag",
			"does not match any of the expected tags",
			"field required",
			"validation",
			"invalid parameter",
		],
		messageTemplate: `Parameter validation error: {errorMessage}

This error indicates that the request parameters don't match Amazon Bedrock's expected format.

Common causes:
1. Extended thinking parameter format is incorrect
2. Model-specific parameters are not supported by this model
3. API parameter structure has changed

Please check:
- Model supports the requested features (extended thinking, etc.)
- Parameter format matches Amazon Bedrock specification
- Model ID is correct for the requested features`,
		logLevel: "error",
	},
	// Default/generic error
	GENERIC: {
		patterns: [], // Empty patterns array means this is the default
		messageTemplate: `Unknown Error: {errorMessage}`,
		logLevel: "error",
	},
}

/**
 * Determines the error type based on the error message or name
 */
export function getBedrockErrorType(error: UnsafeAny): string {
	if (!(error instanceof Error)) {
		return "GENERIC"
	}

	// Check for HTTP 429 status code (Too Many Requests)
	if (isBedrockError(error) && (error.status === 429 || error.$metadata?.httpStatusCode === 429)) {
		return "THROTTLING"
	}

	// Check for Amazon Bedrock specific throttling exception names
	if (isBedrockError(error) && (error.name === "ThrottlingException" || error.__type === "ThrottlingException")) {
		return "THROTTLING"
	}

	const errorMessage = error.message.toLowerCase()
	const errorName = error.name.toLowerCase()

	// Check each error type's patterns in order of specificity (most specific first)
	const errorTypeOrder = [
		"SERVICE_QUOTA_EXCEEDED", // Most specific - check before THROTTLING
		"MODEL_NOT_READY",
		"TOO_MANY_TOKENS",
		"INTERNAL_SERVER_ERROR",
		"ON_DEMAND_NOT_SUPPORTED",
		"NOT_FOUND",
		"ACCESS_DENIED",
		"THROTTLING", // Less specific - check after more specific patterns
	]

	for (const errorType of errorTypeOrder) {
		const definition = BEDROCK_ERROR_TYPES[errorType]
		if (!definition) continue

		// If any pattern matches in either message or name, return this error type
		if (definition.patterns.some((pattern) => errorMessage.includes(pattern) || errorName.includes(pattern))) {
			return errorType
		}
	}

	// Default to generic error
	return "GENERIC"
}

/**
 * Formats an error message based on the error type and context
 */
export function formatBedrockErrorMessage(
	error: UnsafeAny,
	errorType: string,
	_isStreamContext: boolean,
	modelConfig: { id: string; info: ModelInfo },
	region: UnsafeAny,
): string {
	const definition = BEDROCK_ERROR_TYPES[errorType] || BEDROCK_ERROR_TYPES.GENERIC
	let template = definition!.messageTemplate

	// Prepare template variables
	const templateVars: Record<string, string> = {}

	if (error instanceof Error) {
		templateVars.errorMessage = error.message
		templateVars.errorName = error.name

		templateVars.modelId = modelConfig.id
		templateVars.contextWindow = String(modelConfig.info.contextWindow || "UnsafeAny")
	}

	// Add context-specific template variables
	templateVars.regionInfo = `(${region})`

	// Replace template variables
	for (const [key, value] of Object.entries(templateVars)) {
		template = template.replace(new RegExp(`{${key}}`, "g"), value || "")
	}

	return template
}

/**
 * Handles Bedrock API errors and generates appropriate error messages
 * @param error The error that occurred
 * @param isStreamContext Whether the error occurred in a streaming context (true) or not (false)
 * @returns Error message string for non-streaming context or array of stream chunks for streaming context
 */
export function handleBedrockError(
	error: UnsafeAny,
	isStreamContext: boolean,
	customArn: string | undefined,
	region: UnsafeAny,
	modelConfig: { id: string; info: ModelInfo },
	client: BedrockRuntimeClient | undefined,
): string | Array<{ type: string; text?: string; inputTokens?: number; outputTokens?: number }> {
	// Determine error type
	const errorType = getBedrockErrorType(error)

	// Format error message
	const errorMessage = formatBedrockErrorMessage(error, errorType, isStreamContext, modelConfig, region)

	// Log the error
	const definition = BEDROCK_ERROR_TYPES[errorType]
	const logMethod = definition!.logLevel
	const contextName = isStreamContext ? "createMessage" : "completePrompt"
	logger[logMethod](`${errorType} error in ${contextName}`, {
		ctx: "bedrock",
		customArn,
		errorType,
		errorMessage: getErrorMessage(error),
		...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
		...(client?.config?.region ? { clientRegion: client.config.region } : {}),
	})

	// Return appropriate response based on isStreamContext
	if (isStreamContext) {
		return [
			{ type: "text", text: `Error: ${errorMessage}` },
			{ type: "usage", inputTokens: 0, outputTokens: 0 },
		]
	} else {
		// For non-streaming context, add the expected prefix
		return `Bedrock completion error: ${errorMessage}`
	}
}
