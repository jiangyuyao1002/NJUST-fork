import { describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn(),
	},
	window: {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	Uri: {
		file: vi.fn(function (fsPath: string) {
			return {
				fsPath,
			}
		}),
	},
}))

import { processTaskStreamChunk, finalizePendingStreamingToolCalls } from "../TaskStreamChunkProcessor"
import { handleAttemptApiRequestError, handleEmptyAssistantResponse, handleMidStreamFailure } from "../TaskRetryHandler"

describe("TaskExecutor extraction boundaries", () => {
	it("exposes stream chunk processing helpers", () => {
		expect(typeof processTaskStreamChunk).toBe("function")
		expect(typeof finalizePendingStreamingToolCalls).toBe("function")
	})

	it("exposes retry handling helpers", () => {
		expect(typeof handleAttemptApiRequestError).toBe("function")
		expect(typeof handleMidStreamFailure).toBe("function")
		expect(typeof handleEmptyAssistantResponse).toBe("function")
	})
})
