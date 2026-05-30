import { render, screen, fireEvent } from "@/utils/test-utils"

import * as ExtensionStateContext from "@src/context/ExtensionStateContext"
const { ExtensionStateContextProvider } = ExtensionStateContext

import WelcomeViewProvider from "../WelcomeViewProvider"
import { vscode } from "@src/utils/vscode"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeRadioGroup: ({ children, value }: any) => (
		<div data-testid="radio-group" data-value={value}>
			{children}
		</div>
	),
	VSCodeRadio: ({ children, value }: any) => (
		<div data-testid={`radio-${value}`} data-value={value}>
			{children}
		</div>
	),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick, variant }: any) => (
		<button onClick={onClick} data-testid={`button-${variant}`}>
			{children}
		</button>
	),
}))

vi.mock("../../settings/ApiOptions", () => ({
	default: () => <div data-testid="api-options">API Options Component</div>,
}))

vi.mock("../../common/Tab", () => ({
	Tab: ({ children }: any) => <div data-testid="tab">{children}</div>,
	TabContent: ({ children }: any) => <div data-testid="tab-content">{children}</div>,
}))

vi.mock("../RooHero", () => ({
	default: () => <div data-testid="njust-ai-hero">Njust-AI Hero</div>,
}))

vi.mock("lucide-react", () => ({
	Brain: () => <span data-testid="brain-icon">🧠</span>,
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("react-i18next", () => ({
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

const renderWelcomeViewProvider = (extensionState = {}) => {
	const useExtensionStateMock = vi.spyOn(ExtensionStateContext, "useExtensionState")
	useExtensionStateMock.mockReturnValue({
		apiConfiguration: {},
		currentApiConfigName: "default",
		setApiConfiguration: vi.fn(),
		uriScheme: "vscode",
		...extensionState,
	} as any)

	render(
		<ExtensionStateContextProvider>
			<WelcomeViewProvider />
		</ExtensionStateContextProvider>,
	)

	return useExtensionStateMock
}

describe("WelcomeViewProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders landing screen by default", () => {
		renderWelcomeViewProvider()
		expect(screen.getByText(/welcome:landing.greeting/)).toBeInTheDocument()
		expect(screen.getByText(/welcome:landing.introduction/)).toBeInTheDocument()
		expect(screen.getByTestId("button-primary")).toBeInTheDocument()
	})

	it("clicking Get Started enters provider signup view", () => {
		renderWelcomeViewProvider()

		fireEvent.click(screen.getByTestId("button-primary"))

		expect(screen.getByText(/welcome:providerSignup.heading/)).toBeInTheDocument()
		expect(screen.getByTestId("radio-group")).toBeInTheDocument()
		expect(screen.getByTestId("radio-custom")).toBeInTheDocument()
		expect(screen.getByTestId("api-options")).toBeInTheDocument()
	})

	it("clicking import settings button sends import message", () => {
		renderWelcomeViewProvider()

		fireEvent.click(screen.getByText("welcome:importSettings"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "importSettings" })
	})
})
