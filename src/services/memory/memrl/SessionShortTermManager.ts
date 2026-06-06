import { STM_LRU_LIMIT, STM_MAX_CHARS } from "./constants"
import { ShortTermMemory } from "./ShortTermMemory"
export class SessionShortTermManager {
	private readonly store = new Map<string, ShortTermMemory>()
	constructor(
		private readonly maxEntries = STM_LRU_LIMIT,
		private readonly maxCharsPerTask = STM_MAX_CHARS,
	) {}
	get(taskId: string): ShortTermMemory {
		if (this.store.has(taskId)) {
			const stm = this.store.get(taskId)!
			this.store.delete(taskId)
			this.store.set(taskId, stm)
			return stm
		}
		if (this.store.size >= this.maxEntries) this.store.delete(this.store.keys().next().value as string)
		const stm = new ShortTermMemory(this.maxCharsPerTask)
		this.store.set(taskId, stm)
		return stm
	}
	delete(taskId: string): void {
		this.store.delete(taskId)
	}
	get size(): number {
		return this.store.size
	}
}
