import React from "react"
import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@radix-ui/react-tooltip"

import { OpenMarkdownPreviewButton } from "../OpenMarkdownPreviewButton"

const { postMessageMock } = vi.hoisted(() => ({
	postMessageMock: vi.fn(),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: postMessageMock,
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("OpenMarkdownPreviewButton", () => {
	const complex = "# One\n## Two"
	const simple = "Just text"

	beforeEach(() => {
		postMessageMock.mockClear()
	})

	it("does not render when markdown has fewer than 2 headings", () => {
		render(
			<TooltipProvider>
				<OpenMarkdownPreviewButton markdown={simple} />
			</TooltipProvider>,
		)
		expect(screen.queryByLabelText("chat:openMarkdownPreview")).toBeNull()
	})

	it("renders when markdown has 2+ headings", () => {
		render(
			<TooltipProvider>
				<OpenMarkdownPreviewButton markdown={complex} />
			</TooltipProvider>,
		)
		expect(screen.getByLabelText("chat:openMarkdownPreview")).toBeInTheDocument()
	})

	it("posts message on click", () => {
		render(
			<TooltipProvider>
				<OpenMarkdownPreviewButton markdown={complex} />
			</TooltipProvider>,
		)
		fireEvent.click(screen.getByLabelText("chat:openMarkdownPreview"))
		expect(postMessageMock).toHaveBeenCalledWith({ type: "openMarkdownPreview", text: complex })
	})
})
