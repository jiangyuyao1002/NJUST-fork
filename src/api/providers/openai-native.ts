import { OpenAiNativeHandlerBase } from "./openai-native/base"
import { ReasoningMixin } from "./openai-native/reasoning"
import { ResponsesApiMixin } from "./openai-native/responses"

export class OpenAiNativeHandler extends ResponsesApiMixin(ReasoningMixin(OpenAiNativeHandlerBase)) {}

export type { OpenAiNativeModel } from "./openai-native/base"
export type {
	ResponsesInputItem,
	ResponsesOutputItem,
	ResponsesStreamEvent,
	ResponsesRequestBody,
	ResponsesClientLike,
	OpenAiUsageData,
} from "./openai-native/base"
export { openAiErrorResponseSchema, openAiResponsesStreamEventSchema } from "./openai-native/base"
export { convertToolsForResponsesApi } from "./openai-native/tools"
