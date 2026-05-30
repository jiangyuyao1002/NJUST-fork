import React from "react"

import { render, screen } from "@/utils/test-utils"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@shared/package", () => ({
	Package: {
		version: "2026.4.30",
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} onClick={onClick} {...props}>
			{children}
		</a>
	),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { version?: string }) => {
			const translations: Record<string, string> = {
				"chat:announcement.release.heading": "What's New:",
				"chat:announcement.release.cangjieToolchain":
					"Cangjie toolchain integration: improved cjpm/cjfmt/cjlint workflow support.",
				"chat:announcement.release.cangjieContext":
					"Context management enhancements for Cangjie projects with more stable compaction behavior.",
				"chat:announcement.release.cangjieWelcome":
					"Updated welcome and onboarding experience for NJUST_AI.",
			}

			if (key === "chat:announcement.title") {
				return `NJUST_AI ${options?.version ?? ""} Released`
			}

			return translations[key] ?? key
		},
	}),
}))

describe("Announcement", () => {
	it("renders current announcement title and highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("NJUST_AI 2026.4.30 Released")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Cangjie toolchain integration: improved cjpm/cjfmt/cjlint workflow support.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Context management enhancements for Cangjie projects with more stable compaction behavior.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Updated welcome and onboarding experience for NJUST_AI."),
		).toBeInTheDocument()
	})

	it("renders exactly three release highlight bullets", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(3)
	})
})
