import type { MockScenarioResponse } from "../scenarios/index.js"

type StreamableScenarioResponse = Exclude<MockScenarioResponse, { type: "error" }>

type OpenAIChunk = {
	id: string
	object: "chat.completion.chunk"
	created: number
	model: string
	choices: Array<{
		index: number
		delta: Record<string, unknown>
		finish_reason: string | null
	}>
	usage?: {
		prompt_tokens: number
		completion_tokens: number
		total_tokens: number
	}
}

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): OpenAIChunk => ({
	id: "chatcmpl-mock",
	object: "chat.completion.chunk",
	created: 1_700_000_000,
	model: "mock-model",
	choices: [{ index: 0, delta, finish_reason: finishReason }],
})

export function openAISSE(response: StreamableScenarioResponse): string[] {
	const chunks: OpenAIChunk[] = [chunk({ role: "assistant", content: "" })]
	if (response.type === "tool_calls") {
		for (const [index, toolCall] of response.toolCalls.entries()) {
			chunks.push(
				chunk({
					tool_calls: [
						{
							index,
							id: toolCall.id,
							type: "function",
							function: {
								name: toolCall.name,
								arguments: "",
							},
						},
					],
				}),
				chunk({
					tool_calls: [
						{
							index,
							function: {
								arguments: JSON.stringify(toolCall.arguments),
							},
						},
					],
				}),
			)
		}
		chunks.push(chunk({}, "tool_calls"))
	} else {
		chunks.push(chunk({ content: response.text }), chunk({}, "stop"))
	}

	chunks.push({
		...chunk({}),
		choices: [],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	})

	return [...chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`), "data: [DONE]\n\n"]
}
