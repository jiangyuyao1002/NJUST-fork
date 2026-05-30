import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@njust-ai/types"

import type { ApiHandler, SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../types"
import type { ApiHandlerOptions } from "../../shared/api"
import { ApiStream } from "../transform/stream"
import { CONTENT_CHUNK_TYPES } from "./base-provider"

interface FakeAI {
	/**
	 * The unique identifier for the FakeAI instance.
	 * It is used to lookup the original FakeAI object in the fakeAiMap
	 * when the fakeAI object is read from the VSCode global state.
	 */
	readonly id: string

	/**
	 * A function set by the FakeAIHandler on the FakeAI instance, that removes
	 * the FakeAI instance from the fakeAIMap when the FakeAI instance is
	 * no longer needed.
	 */
	removeFromCache?: () => void

	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream
	getModel(): { id: string; info: ModelInfo }
	countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number>
	completePrompt(prompt: string): Promise<string>
}

/**
 * API providers configuration is stored in the VSCode global state.
 * Therefore, when a new task is created, the FakeAI object in the configuration
 * is a new object not related to the original one, but with the same ID.
 *
 * We use the ID to lookup the original FakeAI object in the mapping.
 */
const fakeAiMap: Map<string, FakeAI> = new Map()

export class FakeAIHandler implements ApiHandler, SingleCompletionHandler {
	private ai: FakeAI

	constructor(options: ApiHandlerOptions) {
		const optionsFakeAi = options.fakeAi as FakeAI | undefined
		if (!optionsFakeAi) {
			throw new Error("Fake AI is not set")
		}

		const id = optionsFakeAi.id
		let cachedFakeAi = fakeAiMap.get(id)
		if (cachedFakeAi === undefined) {
			cachedFakeAi = optionsFakeAi
			cachedFakeAi.removeFromCache = () => fakeAiMap.delete(id)
			fakeAiMap.set(id, cachedFakeAi)
		}
		this.ai = cachedFakeAi
	}

	async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		yield* this.guardEmptyStream(this.ai.createMessage(systemPrompt, messages, metadata))
	}

	private async *guardEmptyStream(stream: ApiStream): ApiStream {
		let hasContent = false
		for await (const chunk of stream) {
			if (CONTENT_CHUNK_TYPES.has(chunk.type)) {
				hasContent = true
			}
			yield chunk
		}
		if (!hasContent) {
			throw new Error(
				`[FakeAI] The language model did not provide any assistant messages. ` +
					`This may indicate an issue with the API or the model's output.`,
			)
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return this.ai.getModel()
	}

	countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		return this.ai.countTokens(content)
	}

	completePrompt(prompt: string): Promise<string> {
		return this.ai.completePrompt(prompt)
	}
}
