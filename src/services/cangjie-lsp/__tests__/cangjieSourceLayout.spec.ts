import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		getWorkspaceFolder: vi.fn(),
	},
	Uri: {
		file: (p: string) => ({ fsPath: p, toString: () => p }),
	},
}))

import * as vscode from "vscode"
import { inferCangjiePackageFromSrcLayout } from "../cangjieSourceLayout"

function makeUri(fsPath: string) {
	return { fsPath, toString: () => fsPath } as unknown as Parameters<typeof inferCangjiePackageFromSrcLayout>[0]
}

describe("inferCangjiePackageFromSrcLayout", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns 'main' for file directly under src/", () => {
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
			uri: { fsPath: "/ws" },
		} as any)
		const result = inferCangjiePackageFromSrcLayout(makeUri("/ws/src/main.cj"))
		expect(result).toBe("main")
	})

	it("returns dot-separated package for nested src path", () => {
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
			uri: { fsPath: "/ws" },
		} as any)
		const result = inferCangjiePackageFromSrcLayout(makeUri("/ws/src/utils/helpers.cj"))
		expect(result).toBe("utils")
	})

	it("returns 'main' for file directly under test/", () => {
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
			uri: { fsPath: "/ws" },
		} as any)
		const result = inferCangjiePackageFromSrcLayout(makeUri("/ws/test/main_test.cj"))
		expect(result).toBe("main")
	})

	it("returns dot-separated package for nested test path", () => {
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
			uri: { fsPath: "/ws" },
		} as any)
		const result = inferCangjiePackageFromSrcLayout(makeUri("/ws/test/utils/helpers_test.cj"))
		expect(result).toBe("utils")
	})

	it("returns undefined when no workspace folder", () => {
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue(undefined)
		const result = inferCangjiePackageFromSrcLayout(makeUri("/ws/src/main.cj"))
		expect(result).toBeUndefined()
	})

	it("returns undefined for file outside src/ and test/", () => {
		vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValue({
			uri: { fsPath: "/ws" },
		} as any)
		const result = inferCangjiePackageFromSrcLayout(makeUri("/ws/other/main.cj"))
		expect(result).toBeUndefined()
	})
})
