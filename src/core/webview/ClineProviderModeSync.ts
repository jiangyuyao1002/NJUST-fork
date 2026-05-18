import * as vscode from "vscode"

import { TelemetryService } from "@njust-ai-cj/telemetry"
import {
	NJUST_AI_CJEventName,
	type HistoryItem,
	type ProviderSettings,
	type ProviderSettingsEntry,
} from "@njust-ai-cj/types"

import { t } from "../../i18n"
import { defaultModeSlug, getModeBySlug, type Mode } from "../../shared/modes"
import { cangjieDiagnosticModeSwitch } from "../../services/cangjie-lsp/cangjieDiagnosticModeSwitch"
import { getErrorMessage } from "../../shared/error-utils"
import type { Task } from "../task/Task"
import type { ClineProvider } from "./ClineProvider"
import { shouldRebuildTaskApiHandler } from "./ClineProviderProfiles"

export async function restoreHistoryModeAndProfileWithProvider(
	provider: ClineProvider,
	historyItem: HistoryItem & { rootTask?: Task; parentTask?: Task },
	skipProfileRestoreFromHistory: boolean,
): Promise<void> {
		if (historyItem.mode) {
			const customModes = await provider.customModesManager.getCustomModes()
			const modeExists = getModeBySlug(historyItem.mode, customModes) !== undefined
			if (!modeExists) {
				provider.log(
					`Mode '${historyItem.mode}' from history no longer exists. Falling back to default mode '${defaultModeSlug}'.`,
				)
				historyItem.mode = defaultModeSlug
			}
			await provider.updateGlobalState("mode", historyItem.mode)
			const lockApiConfigAcrossModes = provider.context.workspaceState.get("lockApiConfigAcrossModes", false)
			if (!historyItem.apiConfigName && !lockApiConfigAcrossModes && !skipProfileRestoreFromHistory) {
				await restoreModeBoundProfile(provider, historyItem.mode)
			}
		}

		if (historyItem.apiConfigName && !skipProfileRestoreFromHistory) {
			await restoreTaskBoundProfile(provider, historyItem.apiConfigName)
		} else if (historyItem.apiConfigName && skipProfileRestoreFromHistory) {
			provider.log(
				`Skipping restore of provider profile '${historyItem.apiConfigName}' for task ${historyItem.id} in CLI runtime.`,
			)
		}
	}

async function restoreModeBoundProfile(provider: ClineProvider, mode: string): Promise<void> {
		const [savedConfigId, listApiConfig] = await Promise.all([
			provider.providerSettingsManager.getModeConfigId(mode),
			provider.providerSettingsManager.listConfig(),
		])
		await provider.settingsManager.setGlobalValue("listApiConfigMeta", listApiConfig)
		if (!savedConfigId) {
			return
		}
		const profile = listApiConfig.find(({ id }) => id === savedConfigId)
		if (!profile?.name) {
			return
		}
		try {
			const fullProfile = await provider.providerSettingsManager.getProfile({ name: profile.name })
			if (fullProfile.apiProvider) {
				await provider.activateProviderProfile({ name: profile.name })
			}
		} catch (error) {
			provider.log(
				`Failed to restore API configuration for mode '${mode}': ${
					getErrorMessage(error)
				}. Continuing with default configuration.`,
			)
		}
	}

async function restoreTaskBoundProfile(provider: ClineProvider, apiConfigName: string): Promise<void> {
		const listApiConfig = await provider.providerSettingsManager.listConfig()
		await provider.settingsManager.setGlobalValue("listApiConfigMeta", listApiConfig)
		const profile = listApiConfig.find(({ name }) => name === apiConfigName)
		if (!profile?.name) {
			provider.log(`Provider profile '${apiConfigName}' from history no longer exists. Using current configuration.`)
			return
		}
		try {
			await provider.activateProviderProfile({ name: profile.name }, { persistModeConfig: false, persistTaskHistory: false })
		} catch (error) {
			provider.log(
				`Failed to restore API configuration '${apiConfigName}' for task: ${
					getErrorMessage(error)
				}. Continuing with current configuration.`,
			)
		}
	}

export async function handleModeSwitchWithProvider(provider: ClineProvider, newMode: Mode): Promise<void> {
		await clearCangjieDiagnosticsIfNeeded(provider, newMode)
		await persistTaskModeSwitch(provider, newMode)
		await provider.settingsManager.setGlobalValue("mode", newMode)

		provider.emit(NJUST_AI_CJEventName.ModeChanged, newMode)

		const lockApiConfigAcrossModes = provider.context.workspaceState.get("lockApiConfigAcrossModes", false)
		if (lockApiConfigAcrossModes) {
			await provider.postStateToWebview()
			return
		}

		await syncModeProviderProfile(provider, newMode)
		await provider.postStateToWebview()
	}

async function clearCangjieDiagnosticsIfNeeded(provider: ClineProvider, newMode: Mode): Promise<void> {
		const previousMode = (await provider.settingsManager.getGlobalValue("mode")) as Mode | undefined
		if (previousMode === "cangjie" && newMode !== "cangjie") {
			cangjieDiagnosticModeSwitch.clearExtensionCangjieDiagnostics()
		}
	}

async function persistTaskModeSwitch(provider: ClineProvider, newMode: Mode): Promise<void> {
		const task = provider.getCurrentTask()
		if (!task) {
			return
		}

		TelemetryService.instance.captureModeSwitch(task.taskId, newMode)
		task.emit(NJUST_AI_CJEventName.TaskModeSwitched, task.taskId, newMode)

		try {
			const taskHistoryItem =
				provider.taskHistoryStore.get(task.taskId) ??
				(provider.getGlobalState("taskHistory") ?? []).find((item) => item.id === task.taskId)

			if (taskHistoryItem) {
				await provider.updateTaskHistory({ ...taskHistoryItem, mode: newMode })
			}

			task.setTaskMode(newMode)
		} catch (error) {
			provider.log(
				`Failed to persist mode switch for task ${task.taskId}: ${getErrorMessage(error)}`,
			)
			throw error
		}
	}

async function syncModeProviderProfile(provider: ClineProvider, newMode: Mode): Promise<void> {
		const [savedConfigId, listApiConfig] = await Promise.all([
			provider.providerSettingsManager.getModeConfigId(newMode),
			provider.providerSettingsManager.listConfig(),
		])

		await provider.settingsManager.setGlobalValue("listApiConfigMeta", listApiConfig)

		if (savedConfigId) {
			await activateModeSavedProfile(provider, newMode, listApiConfig, savedConfigId)
			return
		}

		const currentApiConfigNameAfter = provider.settingsManager.getGlobalValue("currentApiConfigName")
		if (!currentApiConfigNameAfter) {
			return
		}

		const config = listApiConfig.find((c) => c.name === currentApiConfigNameAfter)
		if (config?.id) {
			await provider.providerSettingsManager.setModeConfig(newMode, config.id)
		}
	}

async function activateModeSavedProfile(provider: ClineProvider, newMode: Mode, listApiConfig: ProviderSettingsEntry[], savedConfigId: string): Promise<void> {
		const profile = listApiConfig.find(({ id }) => id === savedConfigId)
		if (!profile?.name) {
			return
		}

		const fullProfile = await provider.providerSettingsManager.getProfile({ name: profile.name })
		if (!fullProfile.apiProvider) {
			return
		}

		await provider.activateProviderProfile({ name: profile.name })
	}

function updateTaskApiHandlerIfNeeded(
	provider: ClineProvider,
	providerSettings: ProviderSettings,
	options: { forceRebuild?: boolean } = {},
): void {
		const task = provider.getCurrentTask()
		if (!task) return

		const { forceRebuild = false } = options

		// Determine if we need to rebuild using the previous configuration snapshot
		const needsRebuild = shouldRebuildTaskApiHandler(task.apiConfiguration, providerSettings, forceRebuild)

		if (needsRebuild) {
			// Use updateApiConfiguration which handles both API handler rebuild and parser sync.
			// Note: updateApiConfiguration is declared async but has no actual async operations,
			// so we can safely call it without awaiting.
			task.updateApiConfiguration(providerSettings)
		} else {
			task.updateApiConfiguration(providerSettings)
		}
	}

export function getProviderProfileEntriesWithProvider(provider: ClineProvider): ProviderSettingsEntry[] {
		return provider.contextProxy.getValues().listApiConfigMeta || []
	}

export function getProviderProfileEntryWithProvider(provider: ClineProvider, name: string): ProviderSettingsEntry | undefined {
		return getProviderProfileEntriesWithProvider(provider).find((profile) => profile.name === name)
	}

export function hasProviderProfileEntryWithProvider(provider: ClineProvider, name: string): boolean {
		return !!getProviderProfileEntryWithProvider(provider, name)
	}

export async function upsertProviderProfileWithProvider(
	provider: ClineProvider,
	name: string,
	providerSettings: ProviderSettings,
	activate: boolean = true,
): Promise<string | undefined> {
		try {
			// TODO: Do we need to be calling `activateProfile`? It's not
			// clear to me what the source of truth should be; in some cases
			// we rely on the `ContextProxy`'s data store and in other cases
			// we rely on the `ProviderSettingsManager`'s data store. It might
			// be simpler to unify these two.
			const id = await provider.providerSettingsManager.saveConfig(name, providerSettings)

			if (activate) {
				const { mode } = await provider.getState()

				// These promises do the following:
				// 1. Adds or updates the list of provider profiles.
				// 2. Sets the current provider profile.
				// 3. Sets the current mode's provider profile.
				// 4. Copies the provider settings to the context.
				//
				// Note: 1, 2, and 4 can be done in one `ContextProxy` call:
				// provider.contextProxy.setValues({ ...providerSettings, listApiConfigMeta: ..., currentApiConfigName: ... })
				// We should probably switch to that and verify that it works.
				// I left the original implementation in just to be safe.
				await Promise.all([
					provider.settingsManager.setGlobalValue("listApiConfigMeta", await provider.providerSettingsManager.listConfig()),
					provider.settingsManager.setGlobalValue("currentApiConfigName", name),
					provider.providerSettingsManager.setModeConfig(mode, id),
					provider.contextProxy.setProviderSettings(providerSettings),
				])

				// Change the provider for the current task.
				// TODO: We should rename `buildApiHandler` for clarity (e.g. `getProviderClient`).
				updateTaskApiHandlerIfNeeded(provider, providerSettings, { forceRebuild: true })

				// Keep the current task's sticky provider profile in sync with the newly-activated profile.
				await persistStickyProviderProfileToCurrentTask(provider, name)
			} else {
				await provider.settingsManager.setGlobalValue("listApiConfigMeta", await provider.providerSettingsManager.listConfig())
			}

			await provider.postStateToWebview()
			return id
		} catch (error) {
			provider.log(
				`Error create new api configuration: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
			)

			vscode.window.showErrorMessage(t("common:errors.create_api_config"))
			return undefined
		}
	}

export async function deleteProviderProfileWithProvider(provider: ClineProvider, profileToDelete: ProviderSettingsEntry): Promise<void> {
		const globalSettings = provider.contextProxy.getValues()
		let profileToActivate: string | undefined = globalSettings.currentApiConfigName

		if (profileToDelete.name === profileToActivate) {
			profileToActivate = getProviderProfileEntriesWithProvider(provider).find(({ name }) => name !== profileToDelete.name)?.name
		}

		if (!profileToActivate) {
			throw new Error("You cannot delete the last profile")
		}

		const entries = getProviderProfileEntriesWithProvider(provider).filter(({ name }) => name !== profileToDelete.name)

		await provider.contextProxy.setValues({
			...globalSettings,
			currentApiConfigName: profileToActivate,
			listApiConfigMeta: entries,
		})

		await provider.postStateToWebview()
	}

async function persistStickyProviderProfileToCurrentTask(provider: ClineProvider, apiConfigName: string): Promise<void> {
		const task = provider.getCurrentTask()
		if (!task) {
			return
		}

		try {
			// Update in-memory state immediately so sticky behavior works even before the task has
			// been persisted into taskHistory (it will be captured on the next save).
			task.setTaskApiConfigName(apiConfigName)
			await persistCurrentTaskProfileName(provider, task.taskId, apiConfigName)
		} catch (error) {
			// If persistence fails, log the error but don't fail the profile switch.
			provider.log(
				`Failed to persist provider profile switch for task ${task.taskId}: ${
					getErrorMessage(error)
				}`,
			)
		}
	}

async function persistCurrentTaskProfileName(provider: ClineProvider, taskId: string, apiConfigName: string): Promise<void> {
		const taskHistoryItem =
			provider.taskHistoryStore.get(taskId) ??
			(provider.getGlobalState("taskHistory") ?? []).find((item) => item.id === taskId)

		if (taskHistoryItem) {
			await provider.updateTaskHistory({ ...taskHistoryItem, apiConfigName })
		}
	}

export async function activateProviderProfileWithProvider(
	provider: ClineProvider,
	args: { name: string } | { id: string },
	options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean },
): Promise<void> {
		const { name, id, ...providerSettings } = await provider.providerSettingsManager.activateProfile(args)

		const persistModeConfig = options?.persistModeConfig ?? true
		const persistTaskHistory = options?.persistTaskHistory ?? true
		const listApiConfig = await provider.providerSettingsManager.listConfig()

		await Promise.all([
			provider.contextProxy.setValue("listApiConfigMeta", listApiConfig),
			provider.contextProxy.setValue("currentApiConfigName", name),
			provider.contextProxy.setProviderSettings(providerSettings),
		])

		await persistActivatedProfileModeBinding(provider, id, persistModeConfig)
		updateTaskApiHandlerIfNeeded(provider, providerSettings, { forceRebuild: true })

		if (persistTaskHistory) {
			await persistStickyProviderProfileToCurrentTask(provider, name)
		}

		await provider.postStateToWebview()

		if (providerSettings.apiProvider) {
			provider.emit(NJUST_AI_CJEventName.ProviderProfileChanged, { name, provider: providerSettings.apiProvider })
		}
	}

async function persistActivatedProfileModeBinding(provider: ClineProvider, id: string | undefined, persistModeConfig: boolean): Promise<void> {
		if (!id || !persistModeConfig) {
			return
		}

		const { mode } = await provider.getState()
		await provider.providerSettingsManager.setModeConfig(mode, id)
	}

