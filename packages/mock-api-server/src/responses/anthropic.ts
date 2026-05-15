import type { MockScenarioResponse } from "../scenarios/index.js"

type StreamableScenarioResponse = Exclude<MockScenarioResponse, { type: "error" }>

export function anthropicSSE(response: StreamableScenarioResponse): string[] {
	const events: string[] = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_mock",
				type: "message",
				role: "assistant",
				content: [],
				model: "mock-model",
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		})}\n\n`,
	]

	if (response.type === "tool_calls") {
		response.toolCalls.forEach((toolCall, index) => {
			events.push(
				`event: content_block_start\ndata: ${JSON.stringify({
					type: "content_block_start",
					index,
					content_block: {
						type: "tool_use",
						id: toolCall.id,
						name: toolCall.name,
						input: {},
					},
				})}\n\n`,
				`event: content_block_delta\ndata: ${JSON.stringify({
					type: "content_block_delta",
					index,
					delta: {
						type: "input_json_delta",
						partial_json: JSON.stringify(toolCall.arguments),
					},
				})}\n\n`,
				`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`,
			)
		})
		events.push(
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "tool_use", stop_sequence: null },
				usage: { output_tokens: 5 },
			})}\n\n`,
		)
	} else {
		events.push(
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			})}\n\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: response.text },
			})}\n\n`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			})}\n\n`,
		)
	}

	events.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`)
	return events
}
