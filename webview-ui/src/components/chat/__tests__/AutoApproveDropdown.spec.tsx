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
	ToggleSwitch: ({ checked, onChange, ...props }: { checked: boolean; onChange: () => void }) => (
		<button role="switch" aria-checked={checked} onClick={onChange} {...props} />
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

	it("enables all fine-grained toggles when selecting all", () => {
		const state = createState()

		renderDropdown(state)

		fireEvent.click(screen.getByText("chat:autoApprove.all"))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: expect.objectContaining({
				alwaysAllowReadOnlyOutsideWorkspace: true,
				alwaysAllowWriteOutsideWorkspace: true,
				alwaysAllowWriteProtected: true,
				allowedCommands: ["*"],
			}),
		})
		// Force Bypass should NOT be set by "Select All".
		expect(state.setAlwaysAllowAll).not.toHaveBeenCalled()
		// Fine-grained toggles should be set.
		expect(state.setAlwaysAllowReadOnlyOutsideWorkspace).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowWriteOutsideWorkspace).toHaveBeenCalledWith(true)
		expect(state.setAlwaysAllowWriteProtected).toHaveBeenCalledWith(true)
		expect(state.setAllowedCommands).toHaveBeenCalledWith(["*"])
	})

	it("disables all toggles including bypass when selecting none", () => {
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

	it("hides Force Bypass section when mode is not in the allowed list", () => {
		renderDropdown({
			...createState(),
			mode: "ask",
		})

		expect(screen.queryByTestId("force-bypass-section")).not.toBeInTheDocument()
	})

	it("shows Force Bypass section when mode is allowed", () => {
		renderDropdown({
			...createState(),
			mode: "code",
		})

		expect(screen.getByTestId("force-bypass-section")).toBeInTheDocument()
	})

	it("disables all fine-grained toggle buttons when Force Bypass is enabled", () => {
		renderDropdown({
			...createState(),
			alwaysAllowAll: true,
		})

		// Fine-grained toggle buttons should be disabled.
		const readOnlyButton = screen.getByTestId("auto-approve-alwaysAllowReadOnly")
		expect(readOnlyButton).toBeDisabled()

		const executeButton = screen.getByTestId("auto-approve-alwaysAllowExecute")
		expect(executeButton).toBeDisabled()
	})

	it("toggles Force Bypass via the switch", () => {
		const state = createState()

		renderDropdown(state)

		const bypassToggle = screen.getByTestId("force-bypass-toggle")
		fireEvent.click(bypassToggle)

		expect(state.setAlwaysAllowAll).toHaveBeenCalledWith(true)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: expect.objectContaining({ alwaysAllowAll: true }),
		})
	})
})
