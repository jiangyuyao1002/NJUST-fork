import React, { useState, useEffect, useCallback, useRef } from "react"
import {
	VSCodeCheckbox,
	VSCodeRadioGroup,
	VSCodeRadio,
	VSCodeTextArea,
	VSCodeTextField,
} from "@vscode/webview-ui-toolkit/react"
import { Trans } from "react-i18next"
import { ChevronDown, X, Upload, Download } from "lucide-react"

import {
	ModeConfig,
	GroupEntry,
	PromptComponent,
	ToolGroup,
	modeConfigSchema,
	NJUST_AI_CONFIG_DIR,
	DEFAULT_CLOUD_AGENT_URL,
	CloudAgentProfile,
	CloudAgentProtocolType,
} from "@njust-ai/types"

import {
	Mode,
	getRoleDefinition,
	getWhenToUse,
	getDescription,
	getCustomInstructions,
	getAllModes,
	findModeBySlug as findCustomModeBySlug,
	defaultModeSlug,
} from "@shared/modes"
import { TOOL_GROUPS } from "@shared/tools"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { Section } from "@src/components/settings/Section"
import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Command,
	CommandInput,
	CommandList,
	CommandEmpty,
	CommandItem,
	CommandGroup,
	Input,
	StandardTooltip,
} from "@src/components/ui"
import { useEscapeKey } from "@src/hooks/useEscapeKey"

// Get all available groups that should show in prompts view
const availableGroups = (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((group) => !TOOL_GROUPS[group].alwaysAvailable)

type ModeSource = "global" | "project"

type ImportModeResult = { type: "importModeResult"; success: boolean; slug?: string; error?: string }

// Helper to get group name regardless of format
function getGroupName(group: GroupEntry): ToolGroup {
	return Array.isArray(group) ? group[0] : group
}

const ModesView = () => {
	const { t } = useAppTranslation()

	const {
		customModePrompts,
		listApiConfigMeta,
		currentApiConfigName,
		mode,
		customInstructions,
		setCustomInstructions,
		customModes,
		cloudAgentServerUrl: cloudAgentServerUrlFromState,
	} = useExtensionState()

	// Use a local state to track the visually active mode
	// This prevents flickering when switching modes rapidly by:
	// 1. Updating the UI immediately when a mode is clicked
	// 2. Not syncing with the backend mode state (which would cause flickering)
	// 3. Still sending the mode change to the backend for persistence
	const [visualMode, setVisualMode] = useState(mode)

	// Build modes fresh each render so search reflects inline rename updates immediately
	const modes = getAllModes(customModes)

	const [isDialogOpen, setIsDialogOpen] = useState(false)
	const [selectedPromptContent, setSelectedPromptContent] = useState("")
	const [selectedPromptTitle, setSelectedPromptTitle] = useState("")
	const [isToolsEditMode, setIsToolsEditMode] = useState(false)
	const [showConfigMenu, setShowConfigMenu] = useState(false)
	const [isCreateModeDialogOpen, setIsCreateModeDialogOpen] = useState(false)
	const [isExporting, setIsExporting] = useState(false)
	const [isImporting, setIsImporting] = useState(false)
	const [showImportDialog, setShowImportDialog] = useState(false)
	const [importLevel, setImportLevel] = useState<"global" | "project">("project")
	const [hasRulesToExport, setHasRulesToExport] = useState<Record<string, boolean>>({})

	// Cloud Agent Profile state
	const [cloudAgentProfiles, setCloudAgentProfiles] = useState<CloudAgentProfile[]>([])
	const [activeProfileId, setActiveProfileId] = useState<string | undefined>()
	const [isLoadingProfiles, setIsLoadingProfiles] = useState(false)

	// Profile editor state
	const [isProfileEditorOpen, setIsProfileEditorOpen] = useState(false)
	const [profileFormName, setProfileFormName] = useState("")
	const [profileFormServerUrl, setProfileFormServerUrl] = useState("")
	const [profileFormApiKey, setProfileFormApiKey] = useState("")
	const [profileFormProtocolType, setProfileFormProtocolType] = useState<CloudAgentProtocolType>("rest")
	const [profileFormId, setProfileFormId] = useState<string | undefined>(undefined)

	const defaultCloudAgentServerUrl = DEFAULT_CLOUD_AGENT_URL
	const [cloudAgentServerUrlDraft, setCloudAgentServerUrlDraft] = useState(
		() => cloudAgentServerUrlFromState?.trim() || defaultCloudAgentServerUrl,
	)

	useEffect(() => {
		const next = cloudAgentServerUrlFromState?.trim()
		if (next) {
			setCloudAgentServerUrlDraft(next)
		}
	}, [cloudAgentServerUrlFromState])

	// Load Cloud Agent Profiles
	useEffect(() => {
		if (visualMode === "cloud-agent") {
			setIsLoadingProfiles(true)
			vscode.postMessage({ type: "cloudAgentGetProfiles" })
		}
	}, [visualMode])

	// Listen for profile updates from extension
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "cloudAgentProfiles") {
				setCloudAgentProfiles(message.profiles || [])
				setActiveProfileId(message.activeProfileId)
				setIsLoadingProfiles(false)
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	// Sync serverUrl draft when active profile changes
	useEffect(() => {
		if (activeProfileId && cloudAgentProfiles.length > 0) {
			const activeProfile = cloudAgentProfiles.find((p) => p.id === activeProfileId)
			if (activeProfile?.serverUrl) {
				setCloudAgentServerUrlDraft(activeProfile.serverUrl)
			}
		}
	}, [activeProfileId, cloudAgentProfiles])

	// State for mode selection popover and search
	const [open, setOpen] = useState(false)
	const [searchValue, setSearchValue] = useState("")
	const searchInputRef = useRef<HTMLInputElement>(null)

	// Direct update functions
	const updateAgentPrompt = useCallback(
		(mode: Mode, promptData: PromptComponent) => {
			const existingPrompt = customModePrompts?.[mode] as PromptComponent
			const updatedPrompt = { ...existingPrompt, ...promptData }

			// Only include properties that differ from defaults
			if (updatedPrompt.roleDefinition === getRoleDefinition(mode)) {
				delete updatedPrompt.roleDefinition
			}
			if (updatedPrompt.description === getDescription(mode)) {
				delete updatedPrompt.description
			}
			if (updatedPrompt.whenToUse === getWhenToUse(mode)) {
				delete updatedPrompt.whenToUse
			}

			vscode.postMessage({
				type: "updatePrompt",
				promptMode: mode,
				customPrompt: updatedPrompt,
			})
		},
		[customModePrompts],
	)

	const updateCustomMode = useCallback((slug: string, modeConfig: ModeConfig) => {
		const source = modeConfig.source || "global"

		vscode.postMessage({
			type: "updateCustomMode",
			slug,
			modeConfig: {
				...modeConfig,
				source, // Ensure source is set
			},
		})
	}, [])

	// Helper function to find a mode by slug
	const findModeBySlug = useCallback(
		(searchSlug: string, modes: readonly ModeConfig[] | undefined): ModeConfig | undefined => {
			return findCustomModeBySlug(searchSlug, modes)
		},
		[],
	)

	const switchMode = useCallback((slug: string) => {
		vscode.postMessage({
			type: "mode",
			text: slug,
		})
	}, [])

	// Handle mode switching with explicit state initialization
	const handleModeSwitch = useCallback(
		(modeConfig: ModeConfig) => {
			if (modeConfig.slug === visualMode) return // Prevent unnecessary updates

			// Immediately update visual state for instant feedback
			setVisualMode(modeConfig.slug)

			// Then send the mode change message to the backend
			switchMode(modeConfig.slug)

			// Exit tools edit mode when switching modes
			setIsToolsEditMode(false)
		},
		[visualMode, switchMode],
	)

	// Refs to track latest state/functions for message handler (which has no dependencies)
	const handleModeSwitchRef = useRef(handleModeSwitch)
	const customModesRef = useRef(customModes)
	const switchModeRef = useRef(switchMode)

	// Update refs when dependencies change
	useEffect(() => {
		handleModeSwitchRef.current = handleModeSwitch
	}, [handleModeSwitch])

	useEffect(() => {
		customModesRef.current = customModes
	}, [customModes])

	useEffect(() => {
		switchModeRef.current = switchMode
	}, [switchMode])

	// Sync visualMode with backend mode changes to prevent desync
	useEffect(() => {
		setVisualMode(mode)
	}, [mode])

	// Handler for popover open state change
	const onOpenChange = useCallback((open: boolean) => {
		setOpen(open)
		// Reset search when closing the popover
		if (!open) {
			setTimeout(() => setSearchValue(""), 100)
		}
	}, [])

	// Use the shared ESC key handler hook
	useEscapeKey(open, () => setOpen(false))

	// Handler for clearing search input
	const onClearSearch = useCallback(() => {
		setSearchValue("")
		searchInputRef.current?.focus()
	}, [])

	// Helper function to get current mode's config
	const getCurrentMode = useCallback((): ModeConfig | undefined => {
		const findMode = (m: ModeConfig): boolean => m.slug === visualMode
		return customModes?.find(findMode) || modes.find(findMode)
	}, [visualMode, customModes, modes])

	// Check if the current mode has rules to export
	const checkRulesDirectory = useCallback((slug: string) => {
		vscode.postMessage({
			type: "checkRulesDirectory",
			slug: slug,
		})
	}, [])

	// Check rules directory when mode changes
	useEffect(() => {
		const currentMode = getCurrentMode()
		if (currentMode?.slug && hasRulesToExport[currentMode.slug] === undefined) {
			checkRulesDirectory(currentMode.slug)
		}
	}, [getCurrentMode, checkRulesDirectory, hasRulesToExport])

	// State for create mode dialog
	const [newModeName, setNewModeName] = useState("")
	const [newModeSlug, setNewModeSlug] = useState("")
	const [newModeDescription, setNewModeDescription] = useState("")
	const [newModeRoleDefinition, setNewModeRoleDefinition] = useState("")
	const [newModeWhenToUse, setNewModeWhenToUse] = useState("")
	const [newModeCustomInstructions, setNewModeCustomInstructions] = useState("")
	const [newModeGroups, setNewModeGroups] = useState<GroupEntry[]>(availableGroups)
	const [newModeSource, setNewModeSource] = useState<ModeSource>("global")

	// Field-specific error states
	const [nameError, setNameError] = useState<string>("")
	const [slugError, setSlugError] = useState<string>("")
	const [descriptionError, setDescriptionError] = useState<string>("")
	const [roleDefinitionError, setRoleDefinitionError] = useState<string>("")
	const [groupsError, setGroupsError] = useState<string>("")

	// Helper to reset form state
	const resetFormState = useCallback(() => {
		// Reset form fields
		setNewModeName("")
		setNewModeSlug("")
		setNewModeDescription("")
		setNewModeGroups(availableGroups)
		setNewModeRoleDefinition("")
		setNewModeWhenToUse("")
		setNewModeCustomInstructions("")
		setNewModeSource("global")
		// Reset error states
		setNameError("")
		setSlugError("")
		setDescriptionError("")
		setRoleDefinitionError("")
		setGroupsError("")
	}, [])

	// Reset form fields when dialog opens
	useEffect(() => {
		if (isCreateModeDialogOpen) {
			resetFormState()
		}
	}, [isCreateModeDialogOpen, resetFormState])

	// Ensure import dialog defaults to "project" each open
	useEffect(() => {
		if (showImportDialog) {
			setImportLevel("project")
		}
	}, [showImportDialog])

	// Helper function to generate a unique slug from a name
	const generateSlug = useCallback((name: string, attempt = 0): string => {
		const baseSlug = name
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
		return attempt === 0 ? baseSlug : `${baseSlug}-${attempt}`
	}, [])

	// Handler for name changes
	const handleNameChange = useCallback(
		(name: string) => {
			setNewModeName(name)
			setNewModeSlug(generateSlug(name))
		},
		[generateSlug],
	)

	const handleCreateMode = useCallback(() => {
		// Clear previous errors
		setNameError("")
		setSlugError("")
		setDescriptionError("")
		setRoleDefinitionError("")
		setGroupsError("")

		const source = newModeSource
		const newMode: ModeConfig = {
			slug: newModeSlug,
			name: newModeName,
			description: newModeDescription.trim() || undefined,
			roleDefinition: newModeRoleDefinition.trim(),
			whenToUse: newModeWhenToUse.trim() || undefined,
			customInstructions: newModeCustomInstructions.trim() || undefined,
			groups: newModeGroups,
			source,
		}

		// Validate the mode against the schema
		const result = modeConfigSchema.safeParse(newMode)

		if (!result.success) {
			// Map Zod errors to specific fields
			result.error.errors.forEach((error) => {
				const field = error.path[0] as string
				const message = error.message

				switch (field) {
					case "name":
						setNameError(message)
						break
					case "slug":
						setSlugError(message)
						break
					case "description":
						setDescriptionError(message)
						break
					case "roleDefinition":
						setRoleDefinitionError(message)
						break
					case "groups":
						setGroupsError(message)
						break
				}
			})
			return
		}

		updateCustomMode(newModeSlug, newMode)
		// Immediately select the newly created mode in the UI
		setVisualMode(newModeSlug)
		switchMode(newModeSlug)
		setIsCreateModeDialogOpen(false)
		resetFormState()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		newModeName,
		newModeSlug,
		newModeDescription,
		newModeRoleDefinition,
		newModeWhenToUse, // Add whenToUse dependency
		newModeCustomInstructions,
		newModeGroups,
		newModeSource,
		updateCustomMode,
	])

	const isNameOrSlugTaken = useCallback(
		(name: string, slug: string) => {
			return modes.some((m) => m.slug === slug || m.name === name)
		},
		[modes],
	)

	const openCreateModeDialog = useCallback(() => {
		const baseNamePrefix = "New Custom Mode"
		// Find unique name and slug
		let attempt = 0
		let name = baseNamePrefix
		let slug = generateSlug(name)
		while (isNameOrSlugTaken(name, slug)) {
			attempt++
			name = `${baseNamePrefix} ${attempt + 1}`
			slug = generateSlug(name)
		}
		setNewModeName(name)
		setNewModeSlug(slug)
		setIsCreateModeDialogOpen(true)
	}, [generateSlug, isNameOrSlugTaken])

	// Handler for group checkbox changes
	const handleGroupChange = useCallback(
		(group: ToolGroup, isCustomMode: boolean, customMode: ModeConfig | undefined) =>
			(e: Event | React.FormEvent<HTMLElement>) => {
				if (!isCustomMode) return // Prevent changes to built-in modes
				const target = (e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
				const checked = target.checked
				const oldGroups = customMode?.groups || []
				let newGroups: GroupEntry[]
				if (checked) {
					newGroups = [...oldGroups, group]
				} else {
					newGroups = oldGroups.filter((g) => getGroupName(g) !== group)
				}
				if (customMode) {
					const source = customMode.source || "global"

					updateCustomMode(customMode.slug, {
						...customMode,
						groups: newGroups,
						source,
					})
				}
			},
		[updateCustomMode],
	)

	// Handle clicks outside the config menu
	useEffect(() => {
		const handleClickOutside = () => {
			if (showConfigMenu) {
				setShowConfigMenu(false)
			}
		}

		document.addEventListener("click", handleClickOutside)
		return () => document.removeEventListener("click", handleClickOutside)
	}, [showConfigMenu])

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "systemPrompt") {
				if (message.text) {
					setSelectedPromptContent(message.text)
					setSelectedPromptTitle(`System Prompt (${message.mode} mode)`)
					setIsDialogOpen(true)
				}
			} else if (message.type === "exportModeResult") {
				setIsExporting(false)

				if (!message.success) {
					// Show error message
					console.error("Failed to export mode:", message.error)
				}
			} else if (message.type === "importModeResult") {
				setIsImporting(false)
				setShowImportDialog(false)

				if (message.success) {
					const { slug } = message as ImportModeResult
					if (slug) {
						// Try switching using the freshest mode list available
						const all = getAllModes(customModesRef.current)
						const importedMode = all.find((m) => m.slug === slug)
						if (importedMode) {
							handleModeSwitchRef.current(importedMode)
						} else {
							// Fallback: slug not yet in state (race condition) - select default mode
							setVisualMode(defaultModeSlug)
							switchModeRef.current?.(defaultModeSlug)
						}
					}
				} else {
					// Only log error if it's not a cancellation
					if (message.error !== "cancelled") {
						console.error("Failed to import mode:", message.error)
					}
				}
				// Note: Auto-select after import will be handled by PR #9003
			} else if (message.type === "checkRulesDirectoryResult") {
				setHasRulesToExport((prev) => ({
					...prev,
					[message.slug]: message.hasContent,
				}))
			}
		}

		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [checkRulesDirectory, switchMode])

	const handleAgentReset = (
		modeSlug: string,
		type: "roleDefinition" | "description" | "whenToUse" | "customInstructions",
	) => {
		// Only reset for built-in modes
		const existingPrompt = customModePrompts?.[modeSlug] as PromptComponent
		const updatedPrompt = { ...existingPrompt }
		delete updatedPrompt[type] // Remove the field entirely to ensure it reloads from defaults

		vscode.postMessage({
			type: "updatePrompt",
			promptMode: modeSlug,
			customPrompt: updatedPrompt,
		})
	}

	return (
		<div>
			<Section>
				<div>
					<div onClick={(e) => e.stopPropagation()} className="flex justify-between items-center mb-3">
						<h3 className="text-[1.25em] font-semibold text-vscode-foreground mt-4 mb-2">
							{t("prompts:modes.title")}
						</h3>
						<div className="flex gap-2">
							<div className="relative inline-block">
								<StandardTooltip content={t("prompts:modes.editModesConfig")}>
									<Button
										variant="ghost"
										size="icon"
										className="flex"
										onClick={(e: React.MouseEvent) => {
											e.preventDefault()
											e.stopPropagation()
											setShowConfigMenu((prev) => !prev)
										}}
										onBlur={() => {
											// Add slight delay to allow menu item clicks to register
											setTimeout(() => setShowConfigMenu(false), 200)
										}}>
										<span className="codicon codicon-json"></span>
									</Button>
								</StandardTooltip>
								{showConfigMenu && (
									<div
										onClick={(e) => e.stopPropagation()}
										onMouseDown={(e) => e.stopPropagation()}
										className="absolute top-full right-0 w-[200px] mt-1 bg-vscode-editor-background border border-vscode-input-border rounded shadow-md z-[1000]">
										<div
											className="p-2 cursor-pointer text-vscode-foreground text-sm"
											onMouseDown={(e) => {
												e.preventDefault() // Prevent blur
												vscode.postMessage({
													type: "openCustomModesSettings",
												})
												setShowConfigMenu(false)
											}}
											onClick={(e) => e.preventDefault()}>
											{t("prompts:modes.editGlobalModes")}
										</div>
										<div
											className="p-2 cursor-pointer text-vscode-foreground text-sm border-t border-vscode-input-border"
											onMouseDown={(e) => {
												e.preventDefault() // Prevent blur
												vscode.postMessage({
													type: "openFile",
													text: "./.roomodes",
													values: {
														create: true,
														content: JSON.stringify({ customModes: [] }, null, 2),
													},
												})
												setShowConfigMenu(false)
											}}
											onClick={(e) => e.preventDefault()}>
											{t("prompts:modes.editProjectModes")}
										</div>
									</div>
								)}
							</div>
						<StandardTooltip content={t("prompts:modes.importMode")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => setShowImportDialog(true)}
									disabled={isImporting}
									title={t("prompts:modes.importMode")}
									data-testid="import-mode-toolbar-button">
									<Download className="h-4 w-4" />
								</Button>
							</StandardTooltip>
						</div>
					</div>

					<div className="text-sm text-vscode-descriptionForeground mb-3">
						{t("prompts:modes.createModeHelpText")}
					</div>

					<div className="flex items-center gap-1 mb-3">
						<Popover open={open} onOpenChange={onOpenChange}>
							<PopoverTrigger asChild>
								<Button
									variant="combobox"
									role="combobox"
									aria-expanded={open}
									className="justify-between grow"
									data-testid="mode-select-trigger">
									<div className="truncate">
										{getCurrentMode()?.name ?? t("prompts:modes.selectMode")}
									</div>
									<ChevronDown className="opacity-50" />
								</Button>
							</PopoverTrigger>
							<PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]">
								<Command>
									<div className="relative">
										<CommandInput
											ref={searchInputRef}
											value={searchValue}
											onValueChange={setSearchValue}
											placeholder={t("prompts:modes.selectMode")}
											className="h-9 mr-4"
											data-testid="mode-search-input"
										/>
										{searchValue.length > 0 && (
											<div className="absolute right-2 top-0 bottom-0 flex items-center justify-center">
												<X
													className="text-vscode-input-foreground opacity-50 hover:opacity-100 size-4 p-0.5 cursor-pointer"
													onClick={onClearSearch}
												/>
											</div>
										)}
									</div>
									<CommandList>
										<CommandEmpty>
											{searchValue && (
												<div className="py-2 px-1 text-sm">
													{t("prompts:modes.noMatchFound")}
												</div>
											)}
										</CommandEmpty>
										<CommandGroup>
											{modes
												.filter((modeConfig) =>
													searchValue
														? modeConfig.name
																.toLowerCase()
																.includes(searchValue.toLowerCase())
														: true,
												)
												.map((modeConfig) => (
													<CommandItem
														key={modeConfig.slug}
														value={`${modeConfig.name} ${modeConfig.slug}`}
														onSelect={() => {
															handleModeSwitch(modeConfig)
															setOpen(false)
														}}
														data-testid={`mode-option-${modeConfig.slug}`}>
														<div className="flex items-center justify-between w-full">
															<span
																style={{
																	whiteSpace: "nowrap",
																	overflow: "hidden",
																	textOverflow: "ellipsis",
																	flex: 2,
																	minWidth: 0,
																}}>
																{modeConfig.name}
															</span>
															<span
																className="text-foreground"
																style={{
																	whiteSpace: "nowrap",
																	overflow: "hidden",
																	textOverflow: "ellipsis",
																	direction: "rtl",
																	textAlign: "right",
																	flex: 1,
																	minWidth: 0,
																	marginLeft: "0.5em",
																}}>
																{modeConfig.slug}
															</span>
														</div>
													</CommandItem>
												))}
										</CommandGroup>
									</CommandList>
								</Command>
							</PopoverContent>
						</Popover>

						<StandardTooltip content={t("prompts:modes.createNewMode")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={openCreateModeDialog}
								data-testid="add-mode-button">
								<span className="codicon codicon-add" />
							</Button>
						</StandardTooltip>

						<StandardTooltip content={t("prompts:exportMode.title")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									const currentMode = getCurrentMode()
									if (currentMode?.slug && !isExporting) {
										setIsExporting(true)
										vscode.postMessage({
											type: "exportMode",
											slug: currentMode.slug,
										})
									}
								}}
								disabled={isExporting}
								title={t("prompts:exportMode.title")}
								data-testid="export-mode-toolbar-button">
								<Upload className="h-4 w-4" />
							</Button>
						</StandardTooltip>
					</div>

					{/* API Configuration - Moved Here */}
					<div className="mb-3">
						<div className="font-bold mb-1">{t("prompts:apiConfiguration.title")}</div>
						<div className="text-sm text-vscode-descriptionForeground mb-2">
							{t("prompts:apiConfiguration.select")}
						</div>
						<div className="mb-2">
							<Select
								value={currentApiConfigName}
								onValueChange={(value) => {
									vscode.postMessage({
										type: "loadApiConfiguration",
										text: value,
									})
								}}>
								<SelectTrigger className="w-full">
									<SelectValue placeholder={t("settings:common.select")} />
								</SelectTrigger>
								<SelectContent>
									{(listApiConfigMeta || []).map((config) => (
										<SelectItem key={config.id} value={config.name}>
											{config.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{/* Cloud Agent Settings - Only show for cloud-agent mode */}
					{visualMode === "cloud-agent" && (
						<div className="mb-3 space-y-3">
							{/* Profile Selector */}
							<div>
								<div className="flex justify-between items-center mb-1">
									<div className="font-bold">{t("prompts:cloudAgent.profile.title")}</div>
										<Popover
											open={isProfileEditorOpen}
											onOpenChange={(open) => {
												setIsProfileEditorOpen(open)
												if (!open) {
													setProfileFormId(undefined)
													setProfileFormName("")
													setProfileFormServerUrl("")
													setProfileFormApiKey("")
												}
											}}>
											<div className="flex gap-1">
												<PopoverTrigger asChild>
													<Button
														variant="outline"
														size="sm"
														onClick={() => {
															setProfileFormId(undefined)
														setProfileFormName("")
														setProfileFormServerUrl(defaultCloudAgentServerUrl)
														setProfileFormApiKey("")
														setProfileFormProtocolType("rest")
														setIsProfileEditorOpen(true)
														}}>
														{t("prompts:cloudAgent.profile.create")}
													</Button>
												</PopoverTrigger>
												<Button
													variant="outline"
													size="sm"
													disabled={!activeProfileId}
													onClick={() => {
														const profile = cloudAgentProfiles.find((p) => p.id === activeProfileId)
														if (profile) {
															setProfileFormId(profile.id)
															setProfileFormName(profile.name)
															setProfileFormServerUrl(profile.serverUrl)
															setProfileFormApiKey(profile.auth?.apiKey || "")
															setProfileFormProtocolType(profile.protocolType || "rest")
															setIsProfileEditorOpen(true)
														}
													}}>
													{t("prompts:cloudAgent.profile.edit")}
												</Button>
											</div>
											<PopoverContent className="w-80 p-4 space-y-3">
											<div className="font-bold">
												{profileFormId ? t("prompts:cloudAgent.profile.editProfile") : t("prompts:cloudAgent.profile.newProfile")}
											</div>
											<div>
												<div className="text-sm mb-1">{t("prompts:cloudAgent.profile.name")}</div>
												<Input
													value={profileFormName}
													onChange={(e) => setProfileFormName(e.target.value)}
													placeholder={t("prompts:cloudAgent.profile.namePlaceholder")}
												/>
											</div>
											<div>
												<div className="text-sm mb-1">{t("prompts:cloudAgent.profile.serverUrl")}</div>
												<Input
													value={profileFormServerUrl}
													onChange={(e) => setProfileFormServerUrl(e.target.value)}
													placeholder={defaultCloudAgentServerUrl}
												/>
											</div>
											<div>
												<div className="text-sm mb-1">{t("prompts:cloudAgent.profile.apiKey")}</div>
												<Input
													type="password"
													value={profileFormApiKey}
													onChange={(e) => setProfileFormApiKey(e.target.value)}
													placeholder={t("prompts:cloudAgent.profile.apiKeyPlaceholder")}
												/>
													</div>
														<div>
															<div className="text-sm mb-1">{t("prompts:cloudAgent.profile.protocolType")}</div>
															<Select
																value={profileFormProtocolType}
																onValueChange={(value) => setProfileFormProtocolType(value as CloudAgentProtocolType)}>
																<SelectTrigger>
																	<SelectValue placeholder={t("prompts:cloudAgent.profile.protocolTypePlaceholder")} />
																</SelectTrigger>
																<SelectContent>
																	<SelectItem value="rest">{t("prompts:cloudAgent.profile.protocol.rest")}</SelectItem>
																	<SelectItem value="mcp">{t("prompts:cloudAgent.profile.protocol.mcp")}</SelectItem>
																</SelectContent>
															</Select>
														</div>
														<div className="flex gap-2 justify-end">
													{profileFormId && (
														<Button
															variant="destructive"
															size="sm"
															onClick={() => {
																if (profileFormId) {
																	vscode.postMessage({
																		type: "cloudAgentDeleteProfile",
																		cloudAgentDeleteProfile: profileFormId,
																	})
																	setIsProfileEditorOpen(false)
																}
															}}>
															{t("prompts:cloudAgent.profile.delete")}
														</Button>
													)}
													<Button
														variant="outline"
														size="sm"
														onClick={() => setIsProfileEditorOpen(false)}>
	{t("prompts:cloudAgent.profile.cancel")}
													</Button>
													<Button
														size="sm"
														onClick={() => {
															const now = Date.now()
															const profile: CloudAgentProfile = {
																id: profileFormId || crypto.randomUUID(),
																name: profileFormName || t("prompts:cloudAgent.profile.unnamed"),
																protocolType: profileFormProtocolType,
																serverUrl: profileFormServerUrl || defaultCloudAgentServerUrl,
																auth: {
																	type: profileFormApiKey ? "api-key" : "device-token",
																	apiKey: profileFormApiKey || undefined,
																},
																createdAt: now,
																updatedAt: now,
																isBuiltIn: false,
															}
															vscode.postMessage({
																	type: "cloudAgentSaveProfile",
																	cloudAgentSaveProfile: profile,
																})
															setIsProfileEditorOpen(false)
														}}>
													{t("prompts:cloudAgent.profile.save")}
												</Button>
												</div>
											</PopoverContent>
										</Popover>
								</div>
									<div className="text-sm text-vscode-descriptionForeground mb-2">
										{t("prompts:cloudAgent.profile.description")}
									</div>
								<Select
									value={activeProfileId || ""}
									onValueChange={(value) => {
										if (value) {
											vscode.postMessage({
												type: "cloudAgentSetActiveProfile",
												cloudAgentSetActiveProfile: value,
											})
											setActiveProfileId(value)
										}
									}}
									disabled={isLoadingProfiles}>
									<SelectTrigger className="w-full">
										<SelectValue placeholder={isLoadingProfiles ? t("prompts:cloudAgent.profile.loading") : t("prompts:cloudAgent.profile.selectPlaceholder")} />
									</SelectTrigger>
									<SelectContent>
										{cloudAgentProfiles.map((profile) => (
											<SelectItem key={profile.id} value={profile.id}>
												{profile.name}
												{profile.isBuiltIn && (
													<span className="ml-2 text-xs text-vscode-descriptionForeground">({t("prompts:cloudAgent.profile.builtIn")})</span>
												)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							{/* Server URL (read-only from profile) */}
							<div>
								<div className="font-bold mb-1">{t("prompts:cloudAgent.serverUrl.title")}</div>
								<div className="text-sm text-vscode-descriptionForeground mb-2">
									{t("prompts:cloudAgent.serverUrl.description")}
								</div>
								<VSCodeTextField
									type="text"
									value={cloudAgentServerUrlDraft}
									onChange={(e) => {
										const value = (e.target as HTMLInputElement).value
										setCloudAgentServerUrlDraft(value)
									}}
									onBlur={() => {
										vscode.postMessage({
											type: "updateSettings",
											updatedSettings: { cloudAgentServerUrl: cloudAgentServerUrlDraft },
										})
									}}
									placeholder={t("prompts:cloudAgent.serverUrl.placeholder")}
									className="w-full"
								/>
							</div>
						</div>
					)}
				</div>

				{/* Role Definition section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:roleDefinition.title")}</div>
						{!findModeBySlug(visualMode, customModes) && (
							<StandardTooltip content={t("prompts:roleDefinition.resetToDefault")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => {
										const currentMode = getCurrentMode()
										if (currentMode?.slug) {
											handleAgentReset(currentMode.slug, "roleDefinition")
										}
									}}
									data-testid="role-definition-reset">
									<span className="codicon codicon-discard"></span>
								</Button>
							</StandardTooltip>
						)}
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:roleDefinition.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return customMode?.roleDefinition ?? prompt?.roleDefinition ?? getRoleDefinition(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								(e.target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									roleDefinition: value.trim() || "",
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								updateAgentPrompt(visualMode, {
									roleDefinition: value.trim() || undefined,
								})
							}
						}}
						className="w-full"
						rows={5}
						data-testid={`${getCurrentMode()?.slug || "code"}-prompt-textarea`}
					/>
				</div>

				{/* Description section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:description.title")}</div>
						{!findModeBySlug(visualMode, customModes) && (
							<StandardTooltip content={t("prompts:description.resetToDefault")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => {
										const currentMode = getCurrentMode()
										if (currentMode?.slug) {
											handleAgentReset(currentMode.slug, "description")
										}
									}}
									data-testid="description-reset">
									<span className="codicon codicon-discard"></span>
								</Button>
							</StandardTooltip>
						)}
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:description.description")}
					</div>
					<VSCodeTextField
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return customMode?.description ?? prompt?.description ?? getDescription(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								(e.target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									description: value.trim() || undefined,
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								updateAgentPrompt(visualMode, {
									description: value.trim() || undefined,
								})
							}
						}}
						className="w-full"
						data-testid={`${getCurrentMode()?.slug || "code"}-description-textfield`}
					/>
				</div>

				{/* When to Use section */}
				<div className="mb-4">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:whenToUse.title")}</div>
						{!findModeBySlug(visualMode, customModes) && (
							<StandardTooltip content={t("prompts:whenToUse.resetToDefault")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => {
										const currentMode = getCurrentMode()
										if (currentMode?.slug) {
											handleAgentReset(currentMode.slug, "whenToUse")
										}
									}}
									data-testid="when-to-use-reset">
									<span className="codicon codicon-discard"></span>
								</Button>
							</StandardTooltip>
						)}
					</div>
					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:whenToUse.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return customMode?.whenToUse ?? prompt?.whenToUse ?? getWhenToUse(visualMode)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								(e.target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									whenToUse: value.trim() || undefined,
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								updateAgentPrompt(visualMode, {
									whenToUse: value.trim() || undefined,
								})
							}
						}}
						className="w-full"
						rows={4}
						data-testid={`${getCurrentMode()?.slug || "code"}-when-to-use-textarea`}
					/>
				</div>

				{/* Mode settings */}
				<>
					{/* Show tools for all modes */}
					<div className="mb-4">
						<div className="flex justify-between items-center mb-1">
							<div className="font-bold">{t("prompts:tools.title")}</div>
							{findModeBySlug(visualMode, customModes) && (
								<StandardTooltip
									content={
										isToolsEditMode ? t("prompts:tools.doneEditing") : t("prompts:tools.editTools")
									}>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => setIsToolsEditMode(!isToolsEditMode)}>
										<span
											className={`codicon codicon-${isToolsEditMode ? "check" : "edit"}`}></span>
									</Button>
								</StandardTooltip>
							)}
						</div>
						{!findModeBySlug(visualMode, customModes) && (
							<div className="text-sm text-vscode-descriptionForeground mb-2">
								{t("prompts:tools.builtInModesText")}
							</div>
						)}
						{isToolsEditMode && findModeBySlug(visualMode, customModes) ? (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
								{availableGroups.map((group) => {
									const currentMode = getCurrentMode()
									const isCustomMode = findModeBySlug(visualMode, customModes)
									const customMode = isCustomMode
									const isGroupEnabled = isCustomMode
										? customMode?.groups?.some((g) => getGroupName(g) === group)
										: currentMode?.groups?.some((g) => getGroupName(g) === group)

									return (
										<VSCodeCheckbox
											key={group}
											checked={isGroupEnabled}
											onChange={handleGroupChange(group, Boolean(isCustomMode), customMode)}
											disabled={!isCustomMode}>
											{t(`prompts:tools.toolNames.${group}`)}
											{group === "edit" && (
												<div className="text-xs text-vscode-descriptionForeground mt-0.5">
													{t("prompts:tools.allowedFiles")}{" "}
													{(() => {
														const currentMode = getCurrentMode()
														const editGroup = currentMode?.groups?.find(
															(g) =>
																Array.isArray(g) && g[0] === "edit" && g[1]?.fileRegex,
														)
														if (!Array.isArray(editGroup)) return t("prompts:allFiles")
														return editGroup[1].description || `/${editGroup[1].fileRegex}/`
													})()}
												</div>
											)}
										</VSCodeCheckbox>
									)
								})}
							</div>
						) : (
							<div className="text-sm text-vscode-foreground mb-2 leading-relaxed">
								{(() => {
									const currentMode = getCurrentMode()
									const enabledGroups = currentMode?.groups || []

									// If there are no enabled groups, display translated "None"
									if (enabledGroups.length === 0) {
										return t("prompts:tools.noTools")
									}

									return enabledGroups
										.map((group) => {
											const groupName = getGroupName(group)
											const displayName = t(`prompts:tools.toolNames.${groupName}`)
											if (Array.isArray(group) && group[1]?.fileRegex) {
												const description = group[1].description || `/${group[1].fileRegex}/`
												return `${displayName} (${description})`
											}
											return displayName
										})
										.join(", ")
								})()}
							</div>
						)}
					</div>
				</>

				{/* Role definition for both built-in and custom modes */}
				<div className="mb-2">
					<div className="flex justify-between items-center mb-1">
						<div className="font-bold">{t("prompts:customInstructions.title")}</div>
						{!findModeBySlug(visualMode, customModes) && (
							<StandardTooltip content={t("prompts:customInstructions.resetToDefault")}>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => {
										const currentMode = getCurrentMode()
										if (currentMode?.slug) {
											handleAgentReset(currentMode.slug, "customInstructions")
										}
									}}
									data-testid="custom-instructions-reset">
									<span className="codicon codicon-discard"></span>
								</Button>
							</StandardTooltip>
						)}
					</div>
					<div className="text-[13px] text-vscode-descriptionForeground mb-2">
						{t("prompts:customInstructions.description", {
							modeName: getCurrentMode()?.name || "Code",
						})}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={(() => {
							const customMode = findModeBySlug(visualMode, customModes)
							const prompt = customModePrompts?.[visualMode] as PromptComponent
							return (
								customMode?.customInstructions ??
								prompt?.customInstructions ??
								getCustomInstructions(visualMode, customModes)
							)
						})()}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								(e.target as HTMLTextAreaElement).value
							const customMode = findModeBySlug(visualMode, customModes)
							if (customMode) {
								// For custom modes, update the JSON file
								updateCustomMode(visualMode, {
									...customMode,
									// Preserve empty string; only treat null/undefined as unset
									customInstructions: value ?? undefined,
									source: customMode.source || "global",
								})
							} else {
								// For built-in modes, update the prompts
								const existingPrompt = customModePrompts?.[visualMode] as PromptComponent
								updateAgentPrompt(visualMode, {
									...existingPrompt,
									customInstructions: value.trim() || undefined,
								})
							}
						}}
						rows={10}
						className="w-full"
						data-testid={`${getCurrentMode()?.slug || "code"}-custom-instructions-textarea`}
					/>
					<div className="text-xs text-vscode-descriptionForeground mt-1.5">
						<Trans
							i18nKey="prompts:customInstructions.loadFromFile"
							values={{
								mode: getCurrentMode()?.name || "Code",
								slug: getCurrentMode()?.slug || "code",
							}}
							components={{
								span: (
									<span
										className="text-vscode-textLink-foreground cursor-pointer underline"
										onClick={() => {
											const currentMode = getCurrentMode()
											if (!currentMode) return

											// Open or create an empty file
											vscode.postMessage({
												type: "openFile",
												text: `./${NJUST_AI_CONFIG_DIR}/rules-${currentMode.slug}/rules.md`,
												values: {
													create: true,
													content: "",
												},
											})
										}}
									/>
								),
								"0": <></>,
							}}
						/>
					</div>
				</div>

				<div className="pb-4 border-b border-vscode-input-border">
					<div className="flex gap-2 mb-4">
						<Button
							variant="primary"
							onClick={() => {
								const currentMode = getCurrentMode()
								if (currentMode) {
									vscode.postMessage({
										type: "getSystemPrompt",
										mode: currentMode.slug,
									})
								}
							}}
							data-testid="preview-prompt-button">
							{t("prompts:systemPrompt.preview")}
						</Button>
						<StandardTooltip content={t("prompts:systemPrompt.copy")}>
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									const currentMode = getCurrentMode()
									if (currentMode) {
										vscode.postMessage({
											type: "copySystemPrompt",
											mode: currentMode.slug,
										})
									}
								}}
								data-testid="copy-prompt-button">
								<span className="codicon codicon-copy"></span>
							</Button>
						</StandardTooltip>
					</div>
				</div>

				<div className="pb-5">
					<h3 className="text-vscode-foreground mb-3">{t("prompts:globalCustomInstructions.title")}</h3>

					<div className="text-sm text-vscode-descriptionForeground mb-2">
						{t("prompts:globalCustomInstructions.description")}
					</div>
					<VSCodeTextArea
						resize="vertical"
						value={customInstructions || ""}
						onChange={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								(e.target as HTMLTextAreaElement).value
							setCustomInstructions(value ?? undefined)
							vscode.postMessage({
								type: "customInstructions",
								text: value ?? undefined,
							})
						}}
						rows={4}
						className="w-full"
						data-testid="global-custom-instructions-textarea"
					/>
					<div className="text-xs text-vscode-descriptionForeground mt-1.5">
						<Trans
							i18nKey="prompts:globalCustomInstructions.loadFromFile"
							components={{
								span: (
									<span
										className="text-vscode-textLink-foreground cursor-pointer underline"
										onClick={() =>
											vscode.postMessage({
												type: "openFile",
												text: `./${NJUST_AI_CONFIG_DIR}/rules/rules.md`,
												values: {
													create: true,
													content: "",
												},
											})
										}
									/>
								),
								"0": <></>,
							}}
						/>
					</div>
				</div>
			</Section>

			{isCreateModeDialogOpen && (
				<div className="fixed inset-0 flex justify-end bg-black/50 z-[1000]">
					<div className="w-[calc(100vw-100px)] h-full bg-vscode-editor-background shadow-md flex flex-col relative">
						<div className="flex-1 p-5 overflow-y-auto min-h-0">
							<Button
								variant="ghost"
								size="icon"
								onClick={() => setIsCreateModeDialogOpen(false)}
								className="absolute top-5 right-5">
								<span className="codicon codicon-close"></span>
							</Button>
							<h2 className="mb-4">{t("prompts:createModeDialog.title")}</h2>
							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.name.label")}</div>
								<Input
									type="text"
									value={newModeName}
									onChange={(e) => {
										handleNameChange(e.target.value)
									}}
									className="w-full"
								/>
								{nameError && (
									<div className="text-xs text-vscode-errorForeground mt-1">{nameError}</div>
								)}
							</div>
							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.slug.label")}</div>
								<Input
									type="text"
									value={newModeSlug}
									onChange={(e) => {
										setNewModeSlug(e.target.value)
									}}
									className="w-full"
								/>
								<div className="text-xs text-vscode-descriptionForeground mt-1">
									{t("prompts:createModeDialog.slug.description")}
								</div>
								{slugError && (
									<div className="text-xs text-vscode-errorForeground mt-1">{slugError}</div>
								)}
							</div>
							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.saveLocation.label")}</div>
								<div className="text-sm text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.saveLocation.description")}
								</div>
								<VSCodeRadioGroup
									value={newModeSource}
									onChange={(e: Event | React.FormEvent<HTMLElement>) => {
										const target = ((e as CustomEvent)?.detail?.target ||
											(e.target as HTMLInputElement)) as HTMLInputElement
										setNewModeSource(target.value as ModeSource)
									}}>
									<VSCodeRadio value="global">
										{t("prompts:createModeDialog.saveLocation.global.label")}
										<div className="text-xs text-vscode-descriptionForeground mt-0.5">
											{t("prompts:createModeDialog.saveLocation.global.description")}
										</div>
									</VSCodeRadio>
									<VSCodeRadio value="project">
										{t("prompts:createModeDialog.saveLocation.project.label")}
										<div className="text-xs text-vscode-descriptionForeground mt-0.5">
											{t("prompts:createModeDialog.saveLocation.project.description")}
										</div>
									</VSCodeRadio>
								</VSCodeRadioGroup>
							</div>

							<div style={{ marginBottom: "16px" }}>
								<div style={{ fontWeight: "bold", marginBottom: "4px" }}>
									{t("prompts:createModeDialog.roleDefinition.label")}
								</div>
								<div
									style={{
										fontSize: "13px",
										color: "var(--vscode-descriptionForeground)",
										marginBottom: "8px",
									}}>
									{t("prompts:createModeDialog.roleDefinition.description")}
								</div>
								<VSCodeTextArea
									resize="vertical"
									value={newModeRoleDefinition}
									onChange={(e) => {
										setNewModeRoleDefinition((e.target as HTMLTextAreaElement).value)
									}}
									rows={4}
									className="w-full"
								/>
								{roleDefinitionError && (
									<div className="text-xs text-vscode-errorForeground mt-1">
										{roleDefinitionError}
									</div>
								)}
							</div>

							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.description.label")}</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.description.description")}
								</div>
								<VSCodeTextField
									value={newModeDescription}
									onChange={(e) => {
										setNewModeDescription((e.target as HTMLInputElement).value)
									}}
									className="w-full"
								/>
								{descriptionError && (
									<div className="text-xs text-vscode-errorForeground mt-1">{descriptionError}</div>
								)}
							</div>

							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.whenToUse.label")}</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.whenToUse.description")}
								</div>
								<VSCodeTextArea
									resize="vertical"
									value={newModeWhenToUse}
									onChange={(e) => {
										setNewModeWhenToUse((e.target as HTMLTextAreaElement).value)
									}}
									rows={3}
									className="w-full"
								/>
							</div>
							<div className="mb-4">
								<div className="font-bold mb-1">{t("prompts:createModeDialog.tools.label")}</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.tools.description")}
								</div>
								<div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2">
									{availableGroups.map((group) => (
										<VSCodeCheckbox
											key={group}
											checked={newModeGroups.some((g) => getGroupName(g) === group)}
											onChange={(e: Event | React.FormEvent<HTMLElement>) => {
												const target =
													(e as CustomEvent)?.detail?.target || (e.target as HTMLInputElement)
												const checked = target.checked
												if (checked) {
													setNewModeGroups([...newModeGroups, group])
												} else {
													setNewModeGroups(
														newModeGroups.filter((g) => getGroupName(g) !== group),
													)
												}
											}}>
											{t(`prompts:tools.toolNames.${group}`)}
										</VSCodeCheckbox>
									))}
								</div>
								{groupsError && (
									<div className="text-xs text-vscode-errorForeground mt-1">{groupsError}</div>
								)}
							</div>
							<div className="mb-4">
								<div className="font-bold mb-1">
									{t("prompts:createModeDialog.customInstructions.label")}
								</div>
								<div className="text-[13px] text-vscode-descriptionForeground mb-2">
									{t("prompts:createModeDialog.customInstructions.description")}
								</div>
								<VSCodeTextArea
									resize="vertical"
									value={newModeCustomInstructions}
									onChange={(e) => {
										setNewModeCustomInstructions((e.target as HTMLTextAreaElement).value)
									}}
									rows={4}
									className="w-full"
								/>
							</div>
						</div>
						<div className="flex justify-end p-3 px-5 gap-2 border-t border-vscode-editor-lineHighlightBorder bg-vscode-editor-background">
							<Button variant="secondary" onClick={() => setIsCreateModeDialogOpen(false)}>
								{t("prompts:createModeDialog.buttons.cancel")}
							</Button>
							<Button variant="primary" onClick={handleCreateMode}>
								{t("prompts:createModeDialog.buttons.create")}
							</Button>
						</div>
					</div>
				</div>
			)}

			{isDialogOpen && (
				<div className="fixed inset-0 flex justify-end bg-black/50 z-[1000]">
					<div className="w-[calc(100vw-100px)] h-full bg-vscode-editor-background shadow-md flex flex-col relative">
						<div className="flex-1 p-5 overflow-y-auto min-h-0">
							<Button
								variant="ghost"
								size="icon"
								onClick={() => setIsDialogOpen(false)}
								className="absolute top-5 right-5">
								<span className="codicon codicon-close"></span>
							</Button>
							<h2 className="mb-4">
								{selectedPromptTitle ||
									t("prompts:systemPrompt.title", {
										modeName: getCurrentMode()?.name || "Code",
									})}
							</h2>
							<pre className="p-2 whitespace-pre-wrap break-words font-mono text-vscode-editor-font-size text-vscode-editor-foreground bg-vscode-editor-background border border-vscode-editor-lineHighlightBorder rounded overflow-y-auto">
								{selectedPromptContent}
							</pre>
						</div>
						<div className="flex justify-end p-3 px-5 border-t border-vscode-editor-lineHighlightBorder bg-vscode-editor-background">
							<Button variant="secondary" onClick={() => setIsDialogOpen(false)}>
								{t("prompts:createModeDialog.close")}
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Import Mode Dialog */}
			{showImportDialog && (
				<div className="fixed inset-0 flex items-center justify-center bg-black/50 z-[1000]">
					<div className="bg-vscode-editor-background border border-vscode-editor-lineHighlightBorder rounded-lg shadow-lg p-6 max-w-md w-full">
						<h3 className="text-lg font-semibold mb-4">{t("prompts:modes.importMode")}</h3>
						<p className="text-sm text-vscode-descriptionForeground mb-4">
							{t("prompts:importMode.selectLevel")}
						</p>
						<div className="space-y-3 mb-6">
							<label className="flex items-start gap-2 cursor-pointer">
								<input
									type="radio"
									name="importLevel"
									value="project"
									className="mt-1"
									checked={importLevel === "project"}
									onChange={() => setImportLevel("project")}
								/>
								<div>
									<div className="font-medium">{t("prompts:importMode.project.label")}</div>
									<div className="text-xs text-vscode-descriptionForeground">
										{t("prompts:importMode.project.description")}
									</div>
								</div>
							</label>
							<label className="flex items-start gap-2 cursor-pointer">
								<input
									type="radio"
									name="importLevel"
									value="global"
									className="mt-1"
									checked={importLevel === "global"}
									onChange={() => setImportLevel("global")}
								/>
								<div>
									<div className="font-medium">{t("prompts:importMode.global.label")}</div>
									<div className="text-xs text-vscode-descriptionForeground">
										{t("prompts:importMode.global.description")}
									</div>
								</div>
							</label>
						</div>
						<div className="flex justify-end gap-2">
							<Button variant="secondary" onClick={() => setShowImportDialog(false)}>
								{t("prompts:createModeDialog.buttons.cancel")}
							</Button>
							<Button
								variant="primary"
								onClick={() => {
									if (!isImporting) {
										setIsImporting(true)
										vscode.postMessage({
											type: "importMode",
											source: importLevel,
										})
									}
								}}
								disabled={isImporting}>
								{isImporting ? t("prompts:importMode.importing") : t("prompts:importMode.import")}
							</Button>
						</div>
					</div>
				</div>
			)}

		</div>
	)
}

export default ModesView
