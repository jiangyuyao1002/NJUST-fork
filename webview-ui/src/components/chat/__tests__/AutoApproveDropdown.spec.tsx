import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"

import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { AutoApproveDropdown } from "../AutoApproveDropdown"
import { vscode } from "@/utils/vscode"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

vi.mock("@/components/ui", () => ({
	Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	PopoverTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
	StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	ToggleSwitch: ({ checked, onChange }: { checked: boolean; onChange: () => void }) => (
		<button role="switch" aria-checked={checked} onClick={onChange} />
	),
	Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
}))

const createState = () =>
	({
		autoApprovalEnabled: true,
		mode: "code",
		alwaysAllowAll: false,
		alwaysAllowReadOnly: false,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		alwaysAllowWrite: false,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		alwaysAllowExecute: false,
		alwaysAllowMcp: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		alwaysAllowFollowupQuestions: false,
		saveAllBeforeExecuteCommand: false,
		allowedCommands: [],
		setAutoApprovalEnabled: vi.fn(),
		setAlwaysAllowAll: vi.fn(),
		setAlwaysAllowReadOnly: vi.fn(),
		setAlwaysAllowReadOnlyOutsideWorkspace: vi.fn(),
		setAlwaysAllowWrite: vi.fn(),
		setAlwaysAllowWriteOutsideWorkspace: vi.fn(),
		setAlwaysAllowWriteProtected: vi.fn(),
		setAlwaysAllowExecute: vi.fn(),
		setAlwaysAllowMcp: vi.fn(),
		setAlwaysAllowModeSwitch: vi.fn(),
		setAlwaysAllowSubtasks: vi.fn(),
		setAlwaysAllowFollowupQuestions: vi.fn(),
		setSaveAllBeforeExecuteCommand: vi.fn(),
		setAllowedCommands: vi.fn(),
	}) as any

const renderDropdown = (state = createState()) => {
	render(
		<ExtensionStateContext.Provider value={state}>
			<AutoApproveDropdown />
		</ExtensionStateContext.Provider>,
	)

	return state
}

describe("AutoApproveDropdown", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("enables bypass-relevant subsettings when selecting all auto-approval options", () => {
		const state = createState()

		renderDropdown(state)

		fireEvent.click(screen.getByText("chat:autoApprove.all"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: expect.objectContaining({
				alwaysAllowAll: true,
				alwaysAllowReadOnlyOutsideWorkspace: true,
				alwaysAllowWriteOutsideWorkspace: true,
				alwaysAllowWriteProtected: true,
				allowedCommands: ["*"],
			}),
		})
		expect(state.setAlwaysAllowAll).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowReadOnlyOutsideWorkspace).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowWriteOutsideWorkspace).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowWriteProtected).toHaveBeenCalledWith(true)
		expect(state.setAllowedCommands).toHaveBeenCalledWith(["*"])
	})

	it("disables bypass-relevant subsettings when selecting no auto-approval options", () => {
		const state = {
			...createState(),
			alwaysAllowAll: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: true,
			alwaysAllowWriteProtected: true,
			alwaysAllowExecute: true,
			alwaysAllowMcp: true,
			alwaysAllowModeSwitch: true,
			alwaysAllowSubtasks: true,
			alwaysAllowFollowupQuestions: true,
			saveAllBeforeExecuteCommand: true,
			allowedCommands: ["*"],
		}

		renderDropdown(state)

		fireEvent.click(screen.getByText("chat:autoApprove.none"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: expect.objectContaining({
				alwaysAllowAll: false,
				alwaysAllowReadOnlyOutsideWorkspace: false,
				alwaysAllowWriteOutsideWorkspace: false,
				alwaysAllowWriteProtected: false,
			}),
		})
		expect(state.setAlwaysAllowAll).toHaveBeenCalledWith(false)
		expect(state.setAlwaysAllowReadOnlyOutsideWorkspace).toHaveBeenCalledWith(false)
		expect(state.setAlwaysAllowWriteOutsideWorkspace).toHaveBeenCalledWith(false)
		expect(state.setAlwaysAllowWriteProtected).toHaveBeenCalledWith(false)
	})

	it("does not show the all-enabled label when bypass-relevant subsettings are disabled", () => {
		renderDropdown({
			...createState(),
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: true,
			alwaysAllowMcp: true,
			alwaysAllowModeSwitch: true,
			alwaysAllowSubtasks: true,
			alwaysAllowFollowupQuestions: true,
			saveAllBeforeExecuteCommand: true,
		})

		expect(screen.queryByText("chat:autoApprove.triggerLabelAll")).not.toBeInTheDocument()
	})

	it("hides alwaysAllowAll button when mode is not in the allowed list", () => {
		renderDropdown({
			...createState(),
			mode: "ask",
		})

		expect(screen.queryByTestId("auto-approve-alwaysAllowAll")).not.toBeInTheDocument()
	})

	it("disables sub-toggle buttons when alwaysAllowAll is enabled", () => {
		renderDropdown({
			...createState(),
			alwaysAllowAll: true,
		})

		// The alwaysAllowAll button itself should NOT be disabled.
		const allButton = screen.getByTestId("auto-approve-alwaysAllowAll")
		expect(allButton).not.toBeDisabled()

		// Other toggle buttons should be disabled.
		const readOnlyButton = screen.getByTestId("auto-approve-alwaysAllowReadOnly")
		expect(readOnlyButton).toBeDisabled()

		const executeButton = screen.getByTestId("auto-approve-alwaysAllowExecute")
		expect(executeButton).toBeDisabled()
	})

	it("does not set alwaysAllowAll when selecting all in a disallowed mode", () => {
		const state = {
			...createState(),
			mode: "ask",
		}

		renderDropdown(state)

		fireEvent.click(screen.getByText("chat:autoApprove.all"))

		// alwaysAllowAll setter should NOT be called when mode is not allowed.
		expect(state.setAlwaysAllowAll).not.toHaveBeenCalled()
		// But sub-toggles should still be set.
		expect(state.setAlwaysAllowReadOnly).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowExecute).toHaveBeenCalledWith(true)
	})
})
