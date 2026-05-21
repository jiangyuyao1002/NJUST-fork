import type { ServiceTier } from "@njust-ai-cj/types"
import type { ApiStreamUsageChunk } from "../../../transform/stream"
import type { OpenAiNativeModel, ResponsesOutputItem } from "../base"

export interface EventHandlerContext {
	lastServiceTier: ServiceTier | undefined
	lastResponseOutput: ResponsesOutputItem[] | undefined
	lastResponseId: string | undefined
	pendingToolCallId: string | undefined
	pendingToolCallName: string | undefined
	sawTextOutputInCurrentResponse: boolean
	sawTextDeltaInCurrentResponse: boolean
	streamedToolCallIds: Set<string>
	normalizeUsage(usage: unknown, model: OpenAiNativeModel): ApiStreamUsageChunk | undefined
}
