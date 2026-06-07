/**
 * MemRL Memory System — Path constants & hyperparameters.
 *
 * Dual-write strategy:
 *  - Primary:    .njust_ai/memories/  (episodic, LTM)
 *  - Secondary:  .roo/session-memories/  (acceptance criteria mirror)
 */

// ── Storage directories (relative to workspace root) ──────────────────────────
export const MEMRL_PRIMARY_DIR = ".njust_ai/memories"
export const MEMRL_ROO_DIR = ".roo/session-memories"

// File names inside the above directories
export const EPISODIC_FILE = "episodic.json"
export const LTM_FILE = "ltm_rules.json"

// ── Two-Phase Retrieval hyperparameters (paper defaults) ──────────────────────
/** Phase A: cosine similarity threshold to form candidate set */
export const SIM_THRESHOLD = 0.3
/** Phase A: max candidates to keep after threshold filter */
export const TOP_K1 = 20
/** Phase B: Q-weight in composite score: (1-λ)·sim̂ + λ·Q̂ */
export const LAMBDA = 0.3
/** Phase B: final top-K results to return */
export const TOP_K2 = 5

// ── Q-value update ─────────────────────────────────────────────────────────────
/** Monte Carlo learning rate: Q_new = Q_old + α·(r - Q_old) */
export const ALPHA = 0.1
/** Initial Q-value for new entries */
export const Q_INIT = 0.5

// ── LTM distillation ──────────────────────────────────────────────────────────
/** Trigger LTM distillation every N episodic writes */
export const LTM_DISTILL_INTERVAL = 10
/** Max recent episodes fed to LLM for distillation */
export const LTM_DISTILL_BATCH = 20
/** Max RuleCards to keep in LTM */
export const LTM_MAX_RULES = 200

// ── STM ───────────────────────────────────────────────────────────────────────
/** Max characters stored in a single ShortTermMemory */
export const STM_MAX_CHARS = 8_000
/** Max concurrent STM entries (LRU eviction above this) */
export const STM_LRU_LIMIT = 2_000

// ── Embedding provider (dedicated to MemRL) ───────────────────────────────────
// MemRL uses its OWN OpenAI-compatible embedder, independent of the user's
// code-index embedder setting. Values are resolved at RUNTIME in memory-embedder.ts
// with precedence:  VSCode setting  >  environment variable  >  default literal.
//
// 🔑 The API key is never hardcoded — users set it in VSCode Settings
// (njust-ai.memrl.embeddingApiKey), or devs export MEMRL_EMBED_API_KEY.
//
// Examples:
//   OpenAI:       base "https://api.openai.com/v1"      model "text-embedding-3-small" (1536d)
//   SiliconFlow:  base "https://api.siliconflow.cn/v1"  model "BAAI/bge-m3"            (1024d)

/** VSCode settings sub-keys (read via getConfiguration(Package.name).get(<key>)). */
export const MEMORY_EMBED_SETTING_BASE_URL = "memrl.embeddingBaseUrl"
export const MEMORY_EMBED_SETTING_API_KEY = "memrl.embeddingApiKey"
export const MEMORY_EMBED_SETTING_MODEL = "memrl.embeddingModel"

/** Environment-variable fallbacks (dev / CI / build-time inject). */
export const MEMORY_EMBED_ENV_BASE_URL = "MEMRL_EMBED_BASE_URL"
export const MEMORY_EMBED_ENV_KEY = "MEMRL_EMBED_API_KEY"
export const MEMORY_EMBED_ENV_MODEL = "MEMRL_EMBED_MODEL"

/** Code-level defaults (used when neither setting nor env var is provided). */
export const MEMORY_EMBED_DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1"
export const MEMORY_EMBED_DEFAULT_MODEL = "BAAI/bge-m3"
