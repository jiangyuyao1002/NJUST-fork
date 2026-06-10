export type StartupProfileEntry = {
	name: string
	startedAt: number
	endedAt?: number
	durationMs?: number
}

class StartupProfiler {
	private entries: StartupProfileEntry[] = []

	start(name: string): void {
		this.entries.push({ name, startedAt: Date.now() })
	}

	end(name: string): void {
		const candidate = [...this.entries].reverse().find((e) => e.name === name && e.endedAt === undefined)
		if (!candidate) return
		candidate.endedAt = Date.now()
		candidate.durationMs = candidate.endedAt - candidate.startedAt
	}

	/**
	 * Exception-safe wrapper: guarantees end() is called even if fn() throws.
	 * Prefer this over manual start()/end() pairs.
	 */
	async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
		this.start(name)
		try {
			return await fn()
		} finally {
			this.end(name)
		}
	}

	summary(): StartupProfileEntry[] {
		return this.entries.map((e) => ({ ...e }))
	}
}

export const startupProfiler = new StartupProfiler()
