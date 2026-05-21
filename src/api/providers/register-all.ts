// Auto-registration side-effect file.
// Importing this file triggers self-registration of all built-in providers.
import { providerRegistry } from "../registry/ProviderRegistry"
import type { ApiHandlerOptions } from "../../shared/api"
import type { ApiHandler } from "../types"

import { AnthropicHandler } from "./anthropic"
import { AwsBedrockHandler } from "./bedrock"
import { OpenRouterHandler } from "./openrouter"
import { VertexHandler } from "./vertex"
import { AnthropicVertexHandler } from "./anthropic-vertex"
import { OpenAiHandler } from "./openai"
import { OpenAiCodexHandler } from "./openai-codex"
import { LmStudioHandler } from "./lm-studio"
import { GeminiHandler } from "./gemini"
import { OpenAiNativeHandler } from "./openai-native"
import { DeepSeekHandler } from "./deepseek"
import { MoonshotHandler } from "./moonshot"
import { MistralHandler } from "./mistral"
import { VsCodeLmHandler } from "./vscode-lm"
import { RequestyHandler } from "./requesty"
import { UnboundHandler } from "./unbound"
import { FakeAIHandler } from "./fake-ai"
import { XAIHandler } from "./xai"
import { LiteLLMHandler } from "./lite-llm"
import { QwenCodeHandler } from "./qwen-code"
import { SambaNovaHandler } from "./sambanova"
import { ZAiHandler } from "./zai"
import { FireworksHandler } from "./fireworks"
import { RooHandler } from "./roo"
import { VercelAiGatewayHandler } from "./vercel-ai-gateway"
import { MiniMaxHandler } from "./minimax"
import { BasetenHandler } from "./baseten"
import { QwenHandler } from "./qwen"
import { DoubaoHandler } from "./doubao"
import { GlmHandler } from "./glm"
import { NativeOllamaHandler } from "./native-ollama"

// Register all providers
providerRegistry.register("anthropic", (o: ApiHandlerOptions) => new AnthropicHandler(o), "native")
providerRegistry.register("openrouter", (o: ApiHandlerOptions) => new OpenRouterHandler(o))
providerRegistry.register("bedrock", (o: ApiHandlerOptions) => new AwsBedrockHandler(o), "native")
providerRegistry.register("openai", (o: ApiHandlerOptions) => new OpenAiHandler(o))
providerRegistry.register("ollama", (o: ApiHandlerOptions) => new NativeOllamaHandler(o), "estimated")
providerRegistry.register("lmstudio", (o: ApiHandlerOptions) => new LmStudioHandler(o), "estimated")
providerRegistry.register("gemini", (o: ApiHandlerOptions) => new GeminiHandler(o))
providerRegistry.register("openai-codex", (o: ApiHandlerOptions) => new OpenAiCodexHandler(o))
providerRegistry.register("openai-native", (o: ApiHandlerOptions) => new OpenAiNativeHandler(o) as ApiHandler)
providerRegistry.register("deepseek", (o: ApiHandlerOptions) => new DeepSeekHandler(o))
providerRegistry.register("qwen-code", (o: ApiHandlerOptions) => new QwenCodeHandler(o))
providerRegistry.register("moonshot", (o: ApiHandlerOptions) => new MoonshotHandler(o))
providerRegistry.register("vscode-lm", (o: ApiHandlerOptions) => new VsCodeLmHandler(o))
providerRegistry.register("mistral", (o: ApiHandlerOptions) => new MistralHandler(o))
providerRegistry.register("requesty", (o: ApiHandlerOptions) => new RequestyHandler(o))
providerRegistry.register("unbound", (o: ApiHandlerOptions) => new UnboundHandler(o))
providerRegistry.register("fake-ai", (o: ApiHandlerOptions) => new FakeAIHandler(o), "estimated")
providerRegistry.register("xai", (o: ApiHandlerOptions) => new XAIHandler(o))
providerRegistry.register("litellm", (o: ApiHandlerOptions) => new LiteLLMHandler(o))
providerRegistry.register("sambanova", (o: ApiHandlerOptions) => new SambaNovaHandler(o))
providerRegistry.register("zai", (o: ApiHandlerOptions) => new ZAiHandler(o))
providerRegistry.register("fireworks", (o: ApiHandlerOptions) => new FireworksHandler(o))
providerRegistry.register("roo", (o: ApiHandlerOptions) => new RooHandler(o))
providerRegistry.register("vercel-ai-gateway", (o: ApiHandlerOptions) => new VercelAiGatewayHandler(o))
providerRegistry.register("minimax", (o: ApiHandlerOptions) => new MiniMaxHandler(o))
providerRegistry.register("baseten", (o: ApiHandlerOptions) => new BasetenHandler(o))
providerRegistry.register("qwen", (o: ApiHandlerOptions) => new QwenHandler(o))
providerRegistry.register("doubao", (o: ApiHandlerOptions) => new DoubaoHandler(o))
providerRegistry.register("glm", (o: ApiHandlerOptions) => new GlmHandler(o))
providerRegistry.register(
	"vertex",
	(o: ApiHandlerOptions) => (o.apiModelId?.startsWith("claude") ? new AnthropicVertexHandler(o) : new VertexHandler(o)),
	"native",
)
