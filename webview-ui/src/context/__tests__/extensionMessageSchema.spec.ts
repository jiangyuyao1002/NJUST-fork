import { parseExtensionStateMessage } from "../extensionMessageSchema"

describe("parseExtensionStateMessage", () => {
	it("accepts a valid state message", () => {
		expect(
			parseExtensionStateMessage({
				type: "state",
				state: {
					cloudIsAuthenticated: true,
					apiConfiguration: { apiProvider: "anthropic" },
				},
			}),
		).toEqual({
			type: "state",
			state: {
				cloudIsAuthenticated: true,
				apiConfiguration: { apiProvider: "anthropic" },
			},
		})
	})

	it("accepts a valid workspaceUpdated message", () => {
		expect(
			parseExtensionStateMessage({
				type: "workspaceUpdated",
				filePaths: ["README.md"],
				openedTabs: [{ label: "README.md", isActive: true, path: "README.md" }],
			}),
		).toEqual({
			type: "workspaceUpdated",
			filePaths: ["README.md"],
			openedTabs: [{ label: "README.md", isActive: true, path: "README.md" }],
		})
	})

	it("ignores messages handled by other listeners", () => {
		expect(parseExtensionStateMessage({ type: "dismissedUpsells", list: ["x"] })).toBeUndefined()
	})

	it("rejects handled messages with invalid payload shape", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

		expect(
			parseExtensionStateMessage({
				type: "workspaceUpdated",
				filePaths: "README.md",
			}),
		).toBeUndefined()

		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
	})

	it("rejects non-object data", () => {
		expect(parseExtensionStateMessage("bad")).toBeUndefined()
		expect(parseExtensionStateMessage(null)).toBeUndefined()
	})
	it("rejects messageUpdated without required clineMessage fields", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		expect(
			parseExtensionStateMessage({
				type: "messageUpdated",
				clineMessage: { type: "say", text: "missing id" },
			}),
		).toBeUndefined()
		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
	})
})
