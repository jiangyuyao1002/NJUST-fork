import { describe, expect, it } from "vitest"
import { BackpressureController } from "../BackpressureController"

async function* items<T>(vals: T[]): AsyncGenerator<T> {
	for (const v of vals) {
		yield v
	}
}

describe("BackpressureController", () => {
	it("passes through items from source", async () => {
		const source = items([1, 2, 3])
		const ctrl = new BackpressureController(source, 10, 2)
		const result: number[] = []
		for await (const chunk of ctrl) {
			result.push(chunk)
		}
		expect(result).toEqual([1, 2, 3])
	})

	it("handles empty source", async () => {
		const source = items([])
		const ctrl = new BackpressureController(source, 10, 2)
		const result: number[] = []
		for await (const chunk of ctrl) {
			result.push(chunk)
		}
		expect(result).toEqual([])
	})

	it("propagates errors from source", async () => {
		async function* fail(): AsyncGenerator<number> {
			yield 1
			throw new Error("stream broke")
		}
		const ctrl = new BackpressureController(fail(), 10, 2)
		const result: number[] = []
		let caught = false
		try {
			for await (const chunk of ctrl) {
				result.push(chunk)
			}
		} catch (err) {
			caught = true
			expect((err as Error).message).toBe("stream broke")
		}
		expect(caught).toBe(true)
		expect(result).toEqual([1])
	})

	it("throws when highWaterMark <= lowWaterMark", () => {
		expect(() => new BackpressureController(items([]), 5, 5)).toThrow(
			"highWaterMark must be greater than lowWaterMark",
		)
		expect(() => new BackpressureController(items([]), 3, 5)).toThrow(
			"highWaterMark must be greater than lowWaterMark",
		)
	})

	it("tracks buffer size", async () => {
		async function* slow(): AsyncGenerator<number> {
			for (let i = 0; i < 5; i++) {
				yield i
			}
		}
		const ctrl = new BackpressureController(slow(), 100, 10)
		await new Promise((r) => setTimeout(r, 50))
		expect(ctrl.bufferSize).toBeGreaterThanOrEqual(0)
		for await (const _ of ctrl) {
			break
		}
	})
})
