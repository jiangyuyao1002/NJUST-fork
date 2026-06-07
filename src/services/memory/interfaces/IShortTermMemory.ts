/**
 * Minimal interface for short-term memory exposed to core/task code.
 */
export interface IShortTermMemory {
	push(role: "user" | "assistant", content: string): void
	summarize(): string
}
