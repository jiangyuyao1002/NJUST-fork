import type { ProviderSettings } from "@njust-ai/types"

const MAX_AUDIO_BYTES = 24 * 1024 * 1024 // ~24MB raw

export interface OpenAiWhisperCredentials {
	apiKey: string
	baseUrl: string
}

/**
 * Resolve OpenAI / OpenAI-Native profile credentials for Whisper transcription.
 */
export function getWhisperCredentialsFromProviderSettings(
	config: ProviderSettings | undefined,
): OpenAiWhisperCredentials | null {
	if (!config) {
		return null
	}
	if (config.apiProvider === "openai" && config.openAiApiKey?.trim()) {
		return {
			apiKey: config.openAiApiKey.trim(),
			baseUrl: (config.openAiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, ""),
		}
	}
	if (config.apiProvider === "openai-native" && config.openAiNativeApiKey?.trim()) {
		return {
			apiKey: config.openAiNativeApiKey.trim(),
			baseUrl: (config.openAiNativeBaseUrl || "https://api.openai.com/v1").replace(/\/$/, ""),
		}
	}
	return null
}

/**
 * POST audio to OpenAI-compatible `/audio/transcriptions` (Whisper).
 */
export async function transcribeWithOpenAiWhisper(options: {
	apiKey: string
	baseUrl: string
	audioBuffer: Buffer
	mimeType: string
	filename: string
	language?: string
}): Promise<string> {
	if (options.audioBuffer.length > MAX_AUDIO_BYTES) {
		throw new Error("Audio too large")
	}

	const url = `${options.baseUrl}/audio/transcriptions`
	const form = new FormData()
	const blob = new Blob([new Uint8Array(options.audioBuffer)], { type: options.mimeType })
	form.append("file", blob, options.filename)
	form.append("model", "whisper-1")
	if (options.language && /^[a-z]{2}(-[A-Z]{2})?$/i.test(options.language)) {
		form.append("language", options.language.slice(0, 2).toLowerCase())
	}

	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
		},
		body: form,
	})

	if (!res.ok) {
		const errBody = await res.text().catch(() => "")
		throw new Error(errBody || `Transcription HTTP ${res.status}`)
	}

	const data = (await res.json()) as { text?: string }
	if (typeof data.text !== "string" || !data.text.trim()) {
		throw new Error("Empty transcription response")
	}

	return data.text.trim()
}
