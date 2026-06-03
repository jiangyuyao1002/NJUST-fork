import * as vscode from "vscode"
import { Package } from "../../shared/package"
import type { CloudAgentProfile } from "./types/profile"
import type { CloudAgentAuthConfig } from "@njust-ai/types"
import { BUILT_IN_PROFILES, createFromTemplate, CUSTOM_REST_PROFILE } from "./presets/templates"
import { logger } from "../../shared/logger"

const GLOBAL_STATE_PROFILES_KEY = "cloudAgent.profiles"
const GLOBAL_STATE_ACTIVE_KEY = "cloudAgent.activeProfileId"
const WORKSPACE_STATE_ACTIVE_KEY = "cloudAgent.activeProfileId"
const SECRET_KEY_PREFIX = "cloudAgent.profile.auth."

/**
 * Profile 存储服务。
 *
 * 存储：
 * - globalState["cloudAgent.profiles"] — 用户自定义 Profile 列表（不含凭证）
 * - globalState["cloudAgent.activeProfileId"] — 全局活跃 Profile ID
 * - workspaceState["cloudAgent.activeProfileId"] — 工作区级覆盖（可选）
 * - secrets["cloudAgent.profile.auth.{id}"] — 凭证（apiKey/token/password）
 *
 * 凭证分离策略：
 * - 当提供 SecretStorage 时，auth 字段从 profile 中剥离并加密存储
 * - 内存缓存保证同步读取不阻塞
 * - 未提供 SecretStorage 时降级为旧行为（向后兼容）
 *
 * 内置 Profile 每次从模板常量重建，不持久化。
 */
export class ProfileStorageService {
	private authCache = new Map<string, CloudAgentAuthConfig>()

	constructor(
		private readonly globalState: vscode.Memento,
		private readonly workspaceState?: vscode.Memento,
		private readonly secrets?: vscode.SecretStorage,
	) {}

	/**
	 * 异步初始化：从 SecretStorage 加载凭证缓存 + 迁移遗留数据。
	 * 应在 extension 激活时、setProfileStorageService() 之前调用。
	 */
	async initialize(): Promise<void> {
		if (!this.secrets) {
			return
		}

		const userProfiles = this.globalState.get<CloudAgentProfile[]>(GLOBAL_STATE_PROFILES_KEY, [])
		let needsMigration = false

		for (const profile of userProfiles) {
			// Load auth from SecretStorage
			const secretKey = SECRET_KEY_PREFIX + profile.id
			const stored = await this.secrets.get(secretKey)
			if (stored) {
				try {
					this.authCache.set(profile.id, JSON.parse(stored))
				} catch {
					logger.warn("ProfileStorageService", `Failed to parse cached auth for profile ${profile.id}`)
				}
			}

			// If profile still has auth credentials in globalState, migrate them
			if (profile.auth && hasSensitiveFields(profile.auth) && !stored) {
				await this.secrets.store(secretKey, JSON.stringify(profile.auth))
				this.authCache.set(profile.id, profile.auth)
				needsMigration = true
			}
		}

		// Strip auth from globalState profiles if migration happened
		if (needsMigration) {
			const stripped = userProfiles.map(stripAuth)
			await this.globalState.update(GLOBAL_STATE_PROFILES_KEY, stripped)
			logger.info("ProfileStorageService", "Migrated profile credentials from globalState to SecretStorage")
		}
	}

	// ─── 读取 ─────────────────────────────────────────────────────

	/** 获取所有 Profile（内置 + 用户自定义） */
	getProfiles(): CloudAgentProfile[] {
		const userProfiles = this.globalState.get<CloudAgentProfile[]>(GLOBAL_STATE_PROFILES_KEY, [])
		const rehydrated = userProfiles.map((p) => this.rehydrateProfile(p))
		return [...BUILT_IN_PROFILES, ...rehydrated]
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

		// Store auth in SecretStorage if available
		if (this.secrets && profile.auth && hasSensitiveFields(profile.auth)) {
			const secretKey = SECRET_KEY_PREFIX + profile.id
			await this.secrets.store(secretKey, JSON.stringify(profile.auth))
			this.authCache.set(profile.id, profile.auth)
		}

		// Strip auth before saving to globalState (when SecretStorage is available)
		const profileToStore = this.secrets ? stripAuth(profile) : { ...profile, updatedAt: Date.now() }

		const profiles = this.globalState.get<CloudAgentProfile[]>(GLOBAL_STATE_PROFILES_KEY, [])
		const idx = profiles.findIndex((p) => p.id === profile.id)
		const updated = { ...profileToStore, updatedAt: Date.now() }
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

		// Clean up auth from SecretStorage
		if (this.secrets) {
			await this.secrets.delete(SECRET_KEY_PREFIX + id)
			this.authCache.delete(id)
		}

		// 如果删除的是活跃 Profile，回退到默认
		const activeId = this.globalState.get<string>(GLOBAL_STATE_ACTIVE_KEY)
		if (activeId === id) {
			await this.globalState.update(GLOBAL_STATE_ACTIVE_KEY, undefined)
		}
	}

	/** 设置活跃 Profile ID */
	async setActiveProfileId(id: string, scope: "global" | "workspace" = "global"): Promise<void> {
		if (scope === "workspace" && this.workspaceState) {
			await this.workspaceState.update(WORKSPACE_STATE_ACTIVE_KEY, id)
		} else {
			await this.globalState.update(GLOBAL_STATE_ACTIVE_KEY, id)
		}
	}

	/** 创建自定义 REST Profile */
	async createCustomProfile(overrides?: Partial<CloudAgentProfile>): Promise<CloudAgentProfile> {
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

		// 仅迁移用：读取旧版明文 apiKey 配置。新代码不应读此 key，
		// 所有 API Key 存取应通过 SecretStorage（见 ProfileStorageService.storeApiKey）。
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

	// ─── 内部方法 ─────────────────────────────────────────────────

	/** 从缓存恢复 profile 的 auth 字段 */
	private rehydrateProfile(profile: CloudAgentProfile): CloudAgentProfile {
		const cachedAuth = this.authCache.get(profile.id)
		if (cachedAuth) {
			return { ...profile, auth: cachedAuth }
		}
		return profile
	}
}

// ─── 辅助函数 ──────────────────────────────────────────────────

/** 检查 auth config 是否包含敏感字段 */
function hasSensitiveFields(auth: CloudAgentAuthConfig): boolean {
	return !!(auth.apiKey || auth.bearerToken || auth.basicPassword || auth.deviceToken)
}

/** 创建 profile 的浅拷贝，将 auth 替换为空占位 */
function stripAuth(profile: CloudAgentProfile): CloudAgentProfile {
	if (!profile.auth) return profile
	const { apiKey: _1, bearerToken: _2, basicPassword: _3, deviceToken: _4, ...rest } = profile.auth
	return { ...profile, auth: rest as CloudAgentAuthConfig }
}

// ─── 全局单例 ──────────────────────────────────────────────────

let _instance: ProfileStorageService | undefined

export function setProfileStorageService(s: ProfileStorageService): void {
	_instance = s
}

export function getProfileStorageService(): ProfileStorageService {
	if (!_instance) {
		throw new Error("ProfileStorageService 尚未初始化。请确保 extension.ts 中先调用 setProfileStorageService()。")
	}
	return _instance
}
