import { describe, expect, it } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import { appendRetryEvent, clearRetryEvents, readRetryEvents } from "../retryPersistence"

describe("retryPersistence", () => {
	it("appends and reads retry events", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "njust-ai-retry-"))
		const taskId = "task-1"

		await appendRetryEvent(root, {
			taskId,
			retryAttempt: 1,
			errorKind: "network_error",
			timestamp: Date.now(),
		})

		const events = await readRetryEvents(root, taskId)
		expect(events.length).toBe(1)
		expect(events[0].errorKind).toBe("network_error")

		await clearRetryEvents(root, taskId)
		const empty = await readRetryEvents(root, taskId)
		expect(empty).toEqual([])
	})
})
