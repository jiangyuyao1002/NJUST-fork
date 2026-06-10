import * as os from "os"

import { Package } from "../../../shared/package"
import { t } from "../../../i18n"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { codexCompleteResponseSchema } from "./types"

const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

/**
 * Build standard Codex API request headers.
 * Shared between streaming (executeRequest) and non-streaming (completePrompt) paths.
 */
export async function buildCodexHeaders(
	accessToken: string,
	sessionId: string,
	extra?: Record<string, string>,
): Promise<Record<string, string>> {
	const accountId = await openAiCodexOAuthManager.getAccountId()

	const headers: Record<string, string> = {
		originator: "Njust-AI",
		session_id: sessionId,
		"User-Agent": `Njust-AI/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
		...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
		...extra,
	}

	return headers
}

/**
 * Execute a non-streaming POST request to the Codex Responses API and
 * return the extracted text response.
 *
 * Extracted from OpenAiCodexHandler.completePrompt.
 */
export async function executeNonStreamingRequest(
	requestBody: UnsafeAny,
	accessToken: string,
	sessionId: string,
	signal: AbortSignal,
): Promise<string> {
	const url = `${CODEX_API_BASE_URL}/responses`

	const headers = await buildCodexHeaders(accessToken, sessionId, {
		"Content-Type": "application/json",
		Authorization: `Bearer ${accessToken}`,
	})

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(requestBody),
		signal,
	})

	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(
			t("common:errors.openAiCodex.genericError", { status: response.status }) +
				(errorText ? `: ${errorText}` : ""),
		)
	}

	const responseData = codexCompleteResponseSchema.parse(await response.json())

	if (responseData?.output && Array.isArray(responseData.output)) {
		for (const outputItem of responseData.output) {
			if (outputItem.type === "message" && outputItem.content) {
				for (const content of outputItem.content) {
					if (content.type === "output_text" && content.text) {
						return content.text
					}
				}
			}
		}
	}

	if (responseData?.text) {
		return responseData.text
	}

	return ""
}
