import { STM_MAX_CHARS } from "./constants"
export interface StmEntry {
	role: "user" | "assistant"
	content: string
	timestamp: number
}
export class ShortTermMemory {
	private entries: StmEntry[] = []
	private totalChars = 0
	constructor(private readonly maxChars: number = STM_MAX_CHARS) {}
	push(role: StmEntry["role"], content: string): void {
		this.entries.push({ role, content, timestamp: Date.now() })
		this.totalChars += content.length
		while (this.totalChars > this.maxChars && this.entries.length > 1) {
			this.totalChars -= this.entries.shift()!.content.length
		}
	}
	getEntries(): readonly StmEntry[] {
		return this.entries
	}
	summarize(): string {
		return this.entries.map((e) => `${e.role}: ${e.content}`).join("\n")
	}
	get charCount(): number {
		return this.totalChars
	}
	clear(): void {
		this.entries = []
		this.totalChars = 0
	}
}
