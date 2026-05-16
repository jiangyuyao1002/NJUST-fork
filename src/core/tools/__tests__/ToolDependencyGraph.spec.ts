import { describe, expect, it } from "vitest"

import { ToolDependencyGraph } from "../ToolDependencyGraph"

describe("ToolDependencyGraph", () => {
	it("starts empty", () => {
		const graph = new ToolDependencyGraph()

		expect(graph.isEmpty()).toBe(true)
		expect([...graph.getDependencies("a")]).toEqual([])
		expect([...graph.getDependents("a")]).toEqual([])
	})

	it("records direct dependencies and dependents", () => {
		const graph = new ToolDependencyGraph()
		graph.addDependency("write", "read")

		expect([...graph.getDependencies("write")]).toEqual(["read"])
		expect([...graph.getDependents("read")]).toEqual(["write"])
		expect(graph.isEmpty()).toBe(false)
	})

	it("ignores self-dependencies", () => {
		const graph = new ToolDependencyGraph()
		graph.addDependency("read", "read")

		expect(graph.isEmpty()).toBe(true)
	})

	it("deduplicates repeated dependencies", () => {
		const graph = new ToolDependencyGraph()
		graph.addDependency("write", "read")
		graph.addDependency("write", "read")

		expect([...graph.getDependencies("write")]).toEqual(["read"])
		expect([...graph.getDependents("read")]).toEqual(["write"])
	})

	it("returns transitive dependents", () => {
		const graph = new ToolDependencyGraph()
		graph.addDependency("b", "a")
		graph.addDependency("c", "b")
		graph.addDependency("d", "a")

		expect([...graph.getTransitiveDependents("a")].sort()).toEqual(["b", "c", "d"])
	})

	it("builds graph from tool declarations", () => {
		const graph = ToolDependencyGraph.fromTools([
			{ name: "b", dependsOn: ["a"] },
			{ name: "c", dependsOn: ["a", "b"] },
		])

		expect([...graph.getDependencies("c")].sort()).toEqual(["a", "b"])
		expect([...graph.getDependents("a")].sort()).toEqual(["b", "c"])
	})
})
