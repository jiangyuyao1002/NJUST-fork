import { describe, expect, it } from "vitest"

import {
	addToApiConversationHistoryWithTask,
	addToClineMessagesWithTask,
	findMessageByIdWithTask,
	findMessageByTimestampWithTask,
	flushPendingToolResultsToHistoryWithTask,
	getSavedApiConversationHistoryWithTask,
	getSavedClineMessagesWithTask,
	overwriteApiConversationHistoryWithTask,
	overwriteClineMessagesWithTask,
	retrySaveApiConversationHistoryWithTask,
	saveApiConversationHistoryWithTask,
	saveClineMessagesWithTask,
	updateClineMessageWithTask,
} from "../TaskPersistence"

describe("TaskPersistence extraction boundaries", () => {
	it("exposes API history persistence helpers", () => {
		expect(typeof getSavedApiConversationHistoryWithTask).toBe("function")
		expect(typeof addToApiConversationHistoryWithTask).toBe("function")
		expect(typeof overwriteApiConversationHistoryWithTask).toBe("function")
		expect(typeof flushPendingToolResultsToHistoryWithTask).toBe("function")
		expect(typeof saveApiConversationHistoryWithTask).toBe("function")
		expect(typeof retrySaveApiConversationHistoryWithTask).toBe("function")
	})

	it("exposes Cline message persistence helpers", () => {
		expect(typeof getSavedClineMessagesWithTask).toBe("function")
		expect(typeof addToClineMessagesWithTask).toBe("function")
		expect(typeof overwriteClineMessagesWithTask).toBe("function")
		expect(typeof updateClineMessageWithTask).toBe("function")
		expect(typeof saveClineMessagesWithTask).toBe("function")
		expect(typeof findMessageByTimestampWithTask).toBe("function")
		expect(typeof findMessageByIdWithTask).toBe("function")
	})
})
