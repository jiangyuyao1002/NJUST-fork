import type { IEmbedder } from "../../code-index/interfaces/embedder"
export class MemoryEmbeddingAdapter {
	constructor(private readonly embedder: IEmbedder) {}
	async embed(text: string): Promise<number[]> {
		try {
			return (await this.embedder.createEmbeddings([text])).embeddings[0] ?? []
		} catch {
			return []
		}
	}
	async embedBatch(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return []
		try {
			return (await this.embedder.createEmbeddings(texts)).embeddings
		} catch {
			return texts.map(() => [])
		}
	}
	static cosineSim(a: number[], b: number[]): number {
		if (!a.length || !b.length || a.length !== b.length) return 0
		let dot = 0,
			nA = 0,
			nB = 0
		for (let i = 0; i < a.length; i++) {
			const ai = a[i] ?? 0,
				bi = b[i] ?? 0
			dot += ai * bi
			nA += ai * ai
			nB += bi * bi
		}
		const d = Math.sqrt(nA) * Math.sqrt(nB)
		return d === 0 ? 0 : dot / d
	}
	static zScore(values: number[]): number[] {
		if (!values.length) return []
		const mean = values.reduce((s, v) => s + v, 0) / values.length
		const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
		return std === 0 ? values.map(() => 0) : values.map((v) => (v - mean) / std)
	}
}
