import {
	loadRooLastModelSelection,
	NJUST_AI_LAST_MODEL_SELECTION_KEY,
	saveRooLastModelSelection,
} from "../njust-ai-last-model-selection"

class LocalStorageMock implements Storage {
	private store = new Map<string, string>()

	get length(): number {
		return this.store.size
	}

	clear(): void {
		this.store.clear()
	}

	getItem(key: string): string | null {
		return this.store.get(key) ?? null
	}

	key(index: number): string | null {
		return Array.from(this.store.keys())[index] ?? null
	}

	removeItem(key: string): void {
		this.store.delete(key)
	}

	setItem(key: string, value: string): void {
		this.store.set(key, value)
	}
}

beforeEach(() => {
	Object.defineProperty(globalThis, "localStorage", {
		value: new LocalStorageMock(),
		configurable: true,
	})
})

describe("njust-ai-last-model-selection", () => {
	it("saves and loads (deduped + trimmed)", () => {
		saveRooLastModelSelection([" njust-ai/model-a ", "njust-ai/model-a", "njust-ai/model-b"])
		expect(loadRooLastModelSelection()).toEqual(["njust-ai/model-a", "njust-ai/model-b"])
	})

	it("ignores invalid JSON", () => {
		localStorage.setItem(NJUST_AI_LAST_MODEL_SELECTION_KEY, "{this is not json")
		expect(loadRooLastModelSelection()).toEqual([])
	})

	it("clears when empty", () => {
		localStorage.setItem(NJUST_AI_LAST_MODEL_SELECTION_KEY, JSON.stringify(["njust-ai/model-a"]))
		saveRooLastModelSelection([])
		expect(localStorage.getItem(NJUST_AI_LAST_MODEL_SELECTION_KEY)).toBeNull()
	})

	it("does not throw if localStorage access fails", () => {
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: () => {
					throw new Error("blocked")
				},
				setItem: () => {
					throw new Error("blocked")
				},
				removeItem: () => {
					throw new Error("blocked")
				},
			},
			configurable: true,
		})

		expect(() => loadRooLastModelSelection()).not.toThrow()
		expect(() => saveRooLastModelSelection(["njust-ai/model-a"])).not.toThrow()
	})
})
