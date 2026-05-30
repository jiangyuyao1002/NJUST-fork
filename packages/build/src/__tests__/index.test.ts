// npx vitest run src/__tests__/index.test.ts

import { generatePackageJson } from "../index.js"

describe("generatePackageJson", () => {
	it("should be a test", () => {
		const generatedPackageJson = generatePackageJson({
			packageJson: {
				name: "njust-ai",
				displayName: "%extension.displayName%",
				description: "%extension.description%",
				publisher: "JunjieChen-YuyaoJiang",
				version: "3.17.2",
				icon: "assets/icons/icon.png",
				contributes: {
					viewsContainers: {
						activitybar: [
							{
								id: "njust-ai-ActivityBar",
								title: "%views.activitybar.title%",
								icon: "assets/icons/icon.svg",
							},
						],
					},
					views: {
						"njust-ai-ActivityBar": [
							{
								type: "webview",
								id: "njust-ai.SidebarProvider",
								name: "",
							},
						],
					},
					commands: [
						{
							command: "njust-ai.plusButtonClicked",
							title: "%command.newTask.title%",
							icon: "$(edit)",
						},
						{
							command: "njust-ai.openInNewTab",
							title: "%command.openInNewTab.title%",
							category: "%configuration.title%",
						},
					],
					menus: {
						"editor/context": [
							{
								submenu: "njust-ai.contextMenu",
								group: "navigation",
							},
						],
						"njust-ai.contextMenu": [
							{
								command: "njust-ai.addToContext",
								group: "1_actions@1",
							},
						],
						"editor/title": [
							{
								command: "njust-ai.plusButtonClicked",
								group: "navigation@1",
								when: "activeWebviewPanelId == njust-ai.TabPanelProvider",
							},
							{
								command: "njust-ai.settingsButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == njust-ai.TabPanelProvider",
							},
							{
								command: "njust-ai.accountButtonClicked",
								group: "navigation@6",
								when: "activeWebviewPanelId == njust-ai.TabPanelProvider",
							},
						],
					},
					submenus: [
						{
							id: "njust-ai.contextMenu",
							label: "%views.contextMenu.label%",
						},
						{
							id: "njust-ai.terminalMenu",
							label: "%views.terminalMenu.label%",
						},
					],
					configuration: {
						title: "%configuration.title%",
						properties: {
							"njust-ai.allowedCommands": {
								type: "array",
								items: {
									type: "string",
								},
								default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
								description: "%commands.allowedCommands.description%",
							},
							"njust-ai.customStoragePath": {
								type: "string",
								default: "",
								description: "%settings.customStoragePath.description%",
							},
						},
					},
				},
				scripts: {
					lint: "eslint **/*.ts",
				},
			},
			overrideJson: {
				name: "njust-ai-nightly",
				displayName: "NJUST_AI Nightly",
				publisher: "JunjieChen-YuyaoJiang",
				version: "0.0.1",
				icon: "assets/icons/icon-nightly.png",
				scripts: {},
			},
			substitution: ["njust-ai", "njust-ai-nightly"],
		})

		expect(generatedPackageJson).toStrictEqual({
			name: "njust-ai-nightly",
			displayName: "NJUST_AI Nightly",
			description: "%extension.description%",
			publisher: "JunjieChen-YuyaoJiang",
			version: "0.0.1",
			icon: "assets/icons/icon-nightly.png",
			contributes: {
				viewsContainers: {
					activitybar: [
						{
							id: "njust-ai-nightly-ActivityBar",
							title: "%views.activitybar.title%",
							icon: "assets/icons/icon.svg",
						},
					],
				},
				views: {
					"njust-ai-nightly-ActivityBar": [
						{
							type: "webview",
							id: "njust-ai-nightly.SidebarProvider",
							name: "",
						},
					],
				},
				commands: [
					{
						command: "njust-ai-nightly.plusButtonClicked",
						title: "%command.newTask.title%",
						icon: "$(edit)",
					},
					{
						command: "njust-ai-nightly.openInNewTab",
						title: "%command.openInNewTab.title%",
						category: "%configuration.title%",
					},
				],
				menus: {
					"editor/context": [
						{
							submenu: "njust-ai-nightly.contextMenu",
							group: "navigation",
						},
					],
					"njust-ai-nightly.contextMenu": [
						{
							command: "njust-ai-nightly.addToContext",
							group: "1_actions@1",
						},
					],
					"editor/title": [
						{
							command: "njust-ai-nightly.plusButtonClicked",
							group: "navigation@1",
							when: "activeWebviewPanelId == njust-ai-nightly.TabPanelProvider",
						},
						{
							command: "njust-ai-nightly.settingsButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == njust-ai-nightly.TabPanelProvider",
						},
						{
							command: "njust-ai-nightly.accountButtonClicked",
							group: "navigation@6",
							when: "activeWebviewPanelId == njust-ai-nightly.TabPanelProvider",
						},
					],
				},
				submenus: [
					{
						id: "njust-ai-nightly.contextMenu",
						label: "%views.contextMenu.label%",
					},
					{
						id: "njust-ai-nightly.terminalMenu",
						label: "%views.terminalMenu.label%",
					},
				],
				configuration: {
					title: "%configuration.title%",
					properties: {
						"njust-ai-nightly.allowedCommands": {
							type: "array",
							items: {
								type: "string",
							},
							default: ["npm test", "npm install", "tsc", "git log", "git diff", "git show"],
							description: "%commands.allowedCommands.description%",
						},
						"njust-ai-nightly.customStoragePath": {
							type: "string",
							default: "",
							description: "%settings.customStoragePath.description%",
						},
					},
				},
			},
			scripts: {},
		})
	})
})
