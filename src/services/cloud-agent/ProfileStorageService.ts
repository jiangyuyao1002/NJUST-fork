import * as vscode from "vscode"
import { Package } from "../../shared/package"
import type { CloudAgentProfile } from "./types/profile"
import { BUILT_IN_PROFILES, createFromTemplate, CUSTOM_REST_PROFILE } from "./presets/templates"

const GLOBAL_STATE_PROFILES_KEY = "cloudAgent.profiles"
const GLOBAL_STATE_ACTIVE_KEY = "cloudAgent.activeProfileId"
const WORKSPACE_STATE_ACTIVE_KEY = "cloudAgent.activeProfileId"

/**
 * Profile 存储服务。
 *
 * 存储：
 * - globalState["cloudAgent.profiles"] — 用户自定义 Profile 列表（不含内置）
 * - globalState["cloudAgent.activeProfileId"] — 全局活跃 Profile ID
 * - workspaceState["cloudAgent.activeProfileId"] — 工作区级覆盖（可选）
 *
 * 内置 Profile 每次从模板常量重建，不持久化。
 */
export class ProfileStorageService {
	constructor(
		private readonly globalState: vscode.Memento,
		private readonly workspaceState?: vscode.Memento,
	) {}

	// ─── 读取 ─────────────────────────────────────────────────────

	/** 获取所有 Profile（内置 + 用户自定义） */
	getProfiles(): CloudAgentProfile[] {
		const userProfiles = this.globalState.get<CloudAgentProfile[]>(GLOBAL_STATE_PROFILES_KEY, [])
		return [...BUILT_IN_PROFILES, ...userProfiles]
	}

	/** 获取指定 ID 的 Profile */
	getProfile(id: string): CloudAgentProfile | undefined {
		return this.getProfiles().find((p) => p.id === id)
	}

	/** 获取活跃 Profile（workspaceState > globalState > 第一个内置） */
	getActiveProfile(): CloudAgentProfile | undefined {
		const activeId =
			this.workspaceState?.get<string>(WORKSPACE_STATE_ACTIVE_KEY) ??
			this.globalState.get<string>(GLOBAL_STATE_ACTIVE_KEY)

		if (activeId) {
			return this.getProfile(activeId)
		}
		return BUILT_IN_PROFILES[0]
	}

	// ─── 写入 ─────────────────────────────────────────────────────

	/** 保存/更新 Profile */
	async saveProfile(profile: CloudAgentProfile): Promise<void> {
		if (profile.isBuiltIn) {
			throw new Error("Cannot modify built-in profiles")
		}
		const profiles = this.globalState.get<CloudAgentProfile[]>(GLOBAL_STATE_PROFILES_KEY, [])
		const idx = profiles.findIndex((p) => p.id === profile.id)
		const updated = { ...profile, updatedAt: Date.now() }
		if (idx >= 0) {
			profiles[idx] = updated
		} else {
			profiles.push(updated)
		}
		await this.globalState.update(GLOBAL_STATE_PROFILES_KEY, profiles)
	}

	/** 删除用户自定义 Profile */
	async deleteProfile(id: string): Promise<void> {
		const profiles = this.globalState.get<CloudAgentProfile[]>(GLOBAL_STATE_PROFILES_KEY, [])
		const filtered = profiles.filter((p) => p.id !== id)
		await this.globalState.update(GLOBAL_STATE_PROFILES_KEY, filtered)

		// 如果删除的是活跃 Profile，回退到默认
		const activeId = this.globalState.get<string>(GLOBAL_STATE_ACTIVE_KEY)
		if (activeId === id) {
			await this.globalState.update(GLOBAL_STATE_ACTIVE_KEY, undefined)
		}
	}

	/** 设置活跃 Profile ID */
	async setActiveProfileId(
		id: string,
		scope: "global" | "workspace" = "global",
	): Promise<void> {
		if (scope === "workspace" && this.workspaceState) {
			await this.workspaceState.update(WORKSPACE_STATE_ACTIVE_KEY, id)
		} else {
			await this.globalState.update(GLOBAL_STATE_ACTIVE_KEY, id)
		}
	}

	/** 创建自定义 REST Profile */
	async createCustomProfile(
		overrides?: Partial<CloudAgentProfile>,
	): Promise<CloudAgentProfile> {
		const profile = createFromTemplate(CUSTOM_REST_PROFILE, overrides)
		await this.saveProfile(profile)
		return profile
	}

	// ─── 迁移 ─────────────────────────────────────────────────────

	/**
	 * 从旧配置迁移。
	 * 检查 VS Code 配置中的 cloudAgent.serverUrl，创建迁移 Profile。
	 * 幂等操作：如果已存在 "migrated-default" Profile 则跳过。
	 */
	async migrateFromLegacyConfig(): Promise<CloudAgentProfile | null> {
		const MIGRATED_ID = "migrated-default"
		if (this.getProfile(MIGRATED_ID)) {
			return null // 已迁移
		}

		const config = vscode.workspace.getConfiguration(Package.name)
		const serverUrl = config.get<string>("cloudAgent.serverUrl", "")?.trim()
		if (!serverUrl) return null

		const apiKey =
			config.get<string>("cloudAgent.apiKey", "")?.trim() ||
			process.env.CLOUD_AGENT_MOCK_API_KEY?.trim() ||
			process.env.NJUST_CLOUD_AGENT_API_KEY?.trim() ||
			""

		const now = Date.now()
		const migrated: CloudAgentProfile = {
			id: MIGRATED_ID,
			name: "迁移配置",
			description: "从旧版配置自动迁移",
			protocolType: "rest",
			serverUrl,
			auth: {
				type: apiKey ? "api-key" : "device-token",
				...(apiKey ? { apiKey } : {}),
				deviceTokenSource: "global",
			},
			createdAt: now,
			updatedAt: now,
			isBuiltIn: false,
		}

		await this.saveProfile(migrated)
		await this.setActiveProfileId(MIGRATED_ID)
		return migrated
	}
}

// ─── 全局单例 ──────────────────────────────────────────────────

let _instance: ProfileStorageService | undefined

export function setProfileStorageService(s: ProfileStorageService): void {
	_instance = s
}

export function getProfileStorageService(): ProfileStorageService {
	if (!_instance) {
		throw new Error(
			"ProfileStorageService 尚未初始化。请确保 extension.ts 中先调用 setProfileStorageService()。",
		)
	}
	return _instance
}
