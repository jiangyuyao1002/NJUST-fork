import * as vscode from "vscode"
import { setDeviceToken } from "../services/cloud-agent/deviceToken"

/**
 * Initialize Cloud Agent device token (SecretStorage with legacy migration)
 * and ProfileStorageService (with legacy config migration).
 */
export async function initializeCloudAgent(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	const DEVICE_TOKEN_KEY = "njust-ai.cloudAgent.deviceToken"
	let deviceToken = await context.secrets.get(DEVICE_TOKEN_KEY)
	if (!deviceToken) {
		// Migration: check old globalState key then old config value
		const legacyToken =
			context.globalState.get<string>("njustCloudDeviceToken") ||
			vscode.workspace.getConfiguration("njust-ai").get<string>("cloudAgent.deviceToken", "")
		if (legacyToken?.trim()) {
			deviceToken = legacyToken.trim()
		} else {
			const { randomUUID } = await import("crypto")
			deviceToken = randomUUID()
		}
		await context.secrets.store(DEVICE_TOKEN_KEY, deviceToken)
		// Clean up legacy storage
		await context.globalState.update("njustCloudDeviceToken", undefined)
		outputChannel.appendLine("[CloudAgent] Device token generated and saved to SecretStorage.")
	}
	setDeviceToken(deviceToken)

	// Initialize Cloud Agent ProfileStorageService and migrate legacy config.
	const { ProfileStorageService, setProfileStorageService } = await import(
		"../services/cloud-agent/ProfileStorageService"
	)
	const profileStorage = new ProfileStorageService(context.globalState, context.workspaceState, context.secrets)
	await profileStorage.initialize()
	setProfileStorageService(profileStorage)
	const migratedProfile = await profileStorage.migrateFromLegacyConfig()
	if (migratedProfile) {
		outputChannel.appendLine(
			`[CloudAgent] Migrated legacy config to Profile: ${migratedProfile.name} (${migratedProfile.serverUrl})`,
		)
		void vscode.window.showInformationMessage(
			`Cloud Agent 配置已迁移为 Profile「${migratedProfile.name}」。可在 Cloud Agent 设置中管理。`,
		)
	}
}
