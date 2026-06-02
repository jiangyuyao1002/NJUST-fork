import { beforeEach, describe, expect, it, vi } from "vitest"

import { SettingsManager } from "../SettingsManager"

describe("SettingsManager", () => {
	let contextProxy: {
		setValue: ReturnType<typeof vi.fn>
		getValue: ReturnType<typeof vi.fn>
		getValues: ReturnType<typeof vi.fn>
		setValues: ReturnType<typeof vi.fn>
	}
	let manager: SettingsManager

	beforeEach(() => {
		contextProxy = {
			setValue: vi.fn().mockResolvedValue(undefined),
			getValue: vi.fn((key: string) => (key === "mode" ? "code" : undefined)),
			getValues: vi.fn(function () {
				return {
					mode: "code",
				}
			}),
			setValues: vi.fn().mockResolvedValue(undefined),
		}
		manager = new SettingsManager(contextProxy as any)
	})

	it("delegates global values to ContextProxy", async () => {
		await manager.setGlobalValue("taskHistory", [])

		expect(contextProxy.setValue).toHaveBeenCalledWith("taskHistory", [])
		expect(manager.getGlobalValue("mode")).toBe("code")
	})

	it("delegates settings values to ContextProxy", async () => {
		await manager.setValue("mode", "architect" as any)
		await manager.setValues({ mode: "debug" } as any)

		expect(contextProxy.setValue).toHaveBeenCalledWith("mode", "architect")
		expect(contextProxy.setValues).toHaveBeenCalledWith({ mode: "debug" })
		expect(manager.getValue("mode")).toBe("code")
		expect(manager.getValues()).toEqual({ mode: "code" })
	})
})
