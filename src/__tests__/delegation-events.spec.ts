// npx vitest run __tests__/delegation-events.spec.ts

import { describe, expect, it } from "vitest"

import { NJUST_AIEventName, NjustAiEventsSchema, taskEventSchema } from "@njust-ai/types"

describe("delegation event schemas", () => {
	it("NjustAiEventsSchema validates tuples", () => {
		expect(() =>
			(NjustAiEventsSchema.shape as any)[NJUST_AIEventName.TaskDelegated].parse(["p", "c"]),
		).not.toThrow()
		expect(() =>
			(NjustAiEventsSchema.shape as any)[NJUST_AIEventName.TaskDelegationCompleted].parse(["p", "c", "s"]),
		).not.toThrow()
		expect(() =>
			(NjustAiEventsSchema.shape as any)[NJUST_AIEventName.TaskDelegationResumed].parse(["p", "c"]),
		).not.toThrow()

		// invalid shapes
		expect(() => (NjustAiEventsSchema.shape as any)[NJUST_AIEventName.TaskDelegated].parse(["p"])).toThrow()
		expect(() =>
			(NjustAiEventsSchema.shape as any)[NJUST_AIEventName.TaskDelegationCompleted].parse(["p", "c"]),
		).toThrow()
		expect(() => (NjustAiEventsSchema.shape as any)[NJUST_AIEventName.TaskDelegationResumed].parse(["p"])).toThrow()
	})

	it("taskEventSchema discriminated union includes delegation events", () => {
		expect(() =>
			taskEventSchema.parse({
				eventName: NJUST_AIEventName.TaskDelegated,
				payload: ["p", "c"],
				taskId: 1,
			}),
		).not.toThrow()

		expect(() =>
			taskEventSchema.parse({
				eventName: NJUST_AIEventName.TaskDelegationCompleted,
				payload: ["p", "c", "s"],
				taskId: 1,
			}),
		).not.toThrow()

		expect(() =>
			taskEventSchema.parse({
				eventName: NJUST_AIEventName.TaskDelegationResumed,
				payload: ["p", "c"],
				taskId: 1,
			}),
		).not.toThrow()
	})
})
