/**
 * Shared constants for API layer.
 * These are intentionally placed in the shared layer so that both
 * `src/api/` and `src/core/` can import them without creating
 * cross-layer dependencies.
 */

/**
 * Marker string injected into the system prompt to separate the static
 * prefix (cacheable) from the dynamic suffix (changes per turn).
 * Anthropic prompt-caching uses this to split cache breakpoints.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "\n\n====\n\nSYSTEM_PROMPT_DYNAMIC_BOUNDARY\n\n====\n\n"
