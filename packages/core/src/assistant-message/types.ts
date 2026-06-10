export interface ToolCallStreamEventStart {
	type: "tool_call_start"
	id: string
	name: string
}

export interface ToolCallStreamEventDelta {
	type: "tool_call_delta"
	id: string
	delta: string
}

export interface ToolCallStreamEventEnd {
	type: "tool_call_end"
	id: string
}

export type ToolCallStreamEvent = ToolCallStreamEventStart | ToolCallStreamEventDelta | ToolCallStreamEventEnd

export interface IToolCallParser {
	processFinishReason(finishReason: string | null | undefined): ToolCallStreamEvent[]
	clearRawChunkState?(): void
	clearAllStreamingToolCalls?(): void
}
