/**
 * Backward-compatible re-export.
 *
 * The actual implementation lives in @njust-ai/core/task.
 * This re-export keeps existing imports (`../core/task/ModelFallback`)
 * working without forcing every consumer to migrate at once.
 */
export * from "@njust-ai/core/task"
