import type { ProviderName } from "@njust-ai/types"
import type { FetcherKind } from "./modelTypes"

export const providerFetcherMap: Record<ProviderName, FetcherKind> = {
	"openai": "openai-compatible",
	"mistral": "openai-compatible",
	"xai": "openai-compatible",
	"qwen": "openai-compatible",
	"moonshot": "openai-compatible",
	"glm": "openai-compatible",
	"minimax": "openai-compatible",
	"deepseek": "openai-compatible",

	"anthropic": "anthropic",
	"gemini": "gemini",

	"openrouter": "existing",
	"ollama": "existing",
	"lmstudio": "existing",

	"bedrock": "fallback-only",
	"vertex": "fallback-only",
	"fireworks": "openai-compatible",
	"sambanova": "openai-compatible",
	"baseten": "openai-compatible",
	"doubao": "openai-compatible",
	"mimo": "openai-compatible",
	"mimo-token-plan": "openai-compatible",
	"njust-ai": "existing",
	"litellm": "existing",
	"requesty": "existing",
	"unbound": "existing",
	"vercel-ai-gateway": "existing",
	"vscode-lm": "fallback-only",
	"fake-ai": "fallback-only",
	"openai-native": "openai-compatible",
	"openai-codex": "fallback-only",
	"qwen-code": "fallback-only",
	"gemini-cli": "fallback-only",
	"zai": "fallback-only",
}
