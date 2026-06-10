export type {
	IToolCallParser,
	ToolCallStreamEvent,
	ToolCallStreamEventStart,
	ToolCallStreamEventDelta,
	ToolCallStreamEventEnd,
} from "@njust-ai/core"

import type { ToolCallStreamEvent } from "@njust-ai/core"

/** @deprecated Use `ToolCallStreamEvent` from `@njust-ai/core` instead. */
export type ToolCallParserStreamEvent = ToolCallStreamEvent
