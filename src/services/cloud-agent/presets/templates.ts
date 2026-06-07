import type { CloudAgentProfile, AuthConfig } from "../types/profile"
import { t } from "../../../i18n"

function makeId(): string {
	return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function builtIn(
	id: string,
	name: string,
	serverUrl: string,
	auth: AuthConfig,
	overrides?: Partial<CloudAgentProfile>,
): CloudAgentProfile {
	const now = Date.now()
	return {
		id,
		name,
		protocolType: "rest",
		serverUrl,
		auth,
		createdAt: now,
		updatedAt: now,
		isBuiltIn: true,
		...overrides,
	}
}

/**
 * NJUST AI CJ 标准配置。
 * 与当前 CloudAgentClient 的默认行为完全一致。
 */
export const NJUST_STANDARD_PROFILE: CloudAgentProfile = builtIn(
	"njust-ai-standard",
	t("templates.profile.standard_name"),
	"",
	{
		type: "api-key",
		deviceTokenSource: "global",
	},
)

/**
 * 自定义 REST API 空模板。
 * 用户自行填写 serverUrl 和认证方式，
 * 可选覆盖端点路径和字段映射。
 */
export const CUSTOM_REST_PROFILE: Omit<CloudAgentProfile, "id" | "createdAt" | "updatedAt"> = {
	name: t("templates.profile.custom_name"),
	description: t("templates.profile.custom_description"),
	protocolType: "rest",
	serverUrl: "",
	auth: {
		type: "api-key",
		deviceTokenSource: "global",
	},
}

/**
 * 从预设模板创建新的用户 Profile（分配新 ID 和时间戳）。
 */
export function createFromTemplate(
	template: CloudAgentProfile | Omit<CloudAgentProfile, "id" | "createdAt" | "updatedAt">,
	overrides?: Partial<CloudAgentProfile>,
): CloudAgentProfile {
	const now = Date.now()
	return {
		id: makeId(),
		createdAt: now,
		updatedAt: now,
		isBuiltIn: false,
		...template,
		...overrides,
	} as CloudAgentProfile
}

/** 所有内置模板 */
export const BUILT_IN_PROFILES: CloudAgentProfile[] = [NJUST_STANDARD_PROFILE]
