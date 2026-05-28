import { z } from "zod"

import { globalSettingsSchema } from "./global-settings.js"
import { providerSettingsWithIdSchema } from "./provider-settings.js"

/**
 * CloudUserInfo
 */

export interface CloudUserInfo {
	id?: string
	name?: string
	email?: string
	picture?: string
	organizationId?: string
	organizationName?: string
	organizationRole?: string
	organizationImageUrl?: string
}

/**
 * CloudOrganization
 */

export interface CloudOrganization {
	id: string
	name: string
	slug?: string
	image_url?: string
	has_image?: boolean
	created_at?: number
	updated_at?: number
}

/**
 * CloudOrganizationMembership
 */

export interface CloudOrganizationMembership {
	id: string
	organization: CloudOrganization
	role: string
	permissions?: string[]
	created_at?: number
	updated_at?: number
}

/**
 * OrganizationAllowList
 */

export const organizationAllowListSchema = z.object({
	allowAll: z.boolean(),
	providers: z.record(
		z.object({
			allowAll: z.boolean(),
			models: z.array(z.string()).optional(),
		}),
	),
})

export type OrganizationAllowList = z.infer<typeof organizationAllowListSchema>

/**
 * OrganizationDefaultSettings
 */

export const organizationDefaultSettingsSchema = globalSettingsSchema
	.pick({
		enableCheckpoints: true,
		maxOpenTabsContext: true,
		maxWorkspaceFiles: true,
		showRooIgnoredFiles: true,
		terminalCommandDelay: true,
		terminalShellIntegrationDisabled: true,
		terminalShellIntegrationTimeout: true,
		terminalZshClearEolMark: true,
		disabledTools: true,
	})
	// Add stronger validations for some fields.
	.merge(
		z.object({
			maxOpenTabsContext: z.number().int().nonnegative().optional(),
			maxWorkspaceFiles: z.number().int().nonnegative().optional(),
			terminalCommandDelay: z.number().int().nonnegative().optional(),
			terminalShellIntegrationTimeout: z.number().int().nonnegative().optional(),
		}),
	)

export type OrganizationDefaultSettings = z.infer<typeof organizationDefaultSettingsSchema>

/**
 * WorkspaceTaskVisibility
 */

const workspaceTaskVisibilitySchema = z.enum(["all", "list-only", "admins-and-creator", "creator", "full-lockdown"])

export type WorkspaceTaskVisibility = z.infer<typeof workspaceTaskVisibilitySchema>

/**
 * OrganizationCloudSettings
 */

export const organizationCloudSettingsSchema = z.object({
	recordTaskMessages: z.boolean().optional(),
	enableTaskSharing: z.boolean().optional(),
	allowPublicTaskSharing: z.boolean().optional(),
	taskShareExpirationDays: z.number().int().positive().optional(),
	allowMembersViewAllTasks: z.boolean().optional(),
	workspaceTaskVisibility: workspaceTaskVisibilitySchema.optional(),
	llmEnhancedFeaturesEnabled: z.boolean().optional(),
})

export type OrganizationCloudSettings = z.infer<typeof organizationCloudSettingsSchema>

/**
 * OrganizationFeatures
 */

export const organizationFeaturesSchema = z.object({})

export type OrganizationFeatures = z.infer<typeof organizationFeaturesSchema>

/**
 * OrganizationSettings
 */

export const organizationSettingsSchema = z.object({
	version: z.number(),
	cloudSettings: organizationCloudSettingsSchema.optional(),
	defaultSettings: organizationDefaultSettingsSchema,
	allowList: organizationAllowListSchema,
	features: organizationFeaturesSchema.optional(),
	hiddenMcps: z.array(z.string()).optional(),
	providerProfiles: z.record(z.string(), providerSettingsWithIdSchema).optional(),
})

export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>

/**
 * User Settings Schemas
 */

export const userSettingsConfigSchema = z.object({
	taskSyncEnabled: z.boolean().optional(),
	llmEnhancedFeaturesEnabled: z.boolean().optional(),
})

export type UserSettingsConfig = z.infer<typeof userSettingsConfigSchema>

/**
 * Constants
 */

export const ORGANIZATION_ALLOW_ALL: OrganizationAllowList = {
	allowAll: true,
	providers: {},
} as const

export const ORGANIZATION_DEFAULT: OrganizationSettings = {
	version: 0,
	cloudSettings: {
		recordTaskMessages: true,
		enableTaskSharing: true,
		allowPublicTaskSharing: true,
		taskShareExpirationDays: 30,
		allowMembersViewAllTasks: true,
		llmEnhancedFeaturesEnabled: false,
	},
	defaultSettings: {},
	allowList: ORGANIZATION_ALLOW_ALL,
} as const

/**
 * ShareVisibility
 */

export type ShareVisibility = "organization" | "public"

/**
 * CloudAgentProfile
 */

export type CloudAgentProtocolType = "rest" | "mcp"

export interface CloudAgentEndpointConfig {
	health?: string
	run: string
	deferredStart?: string
	deferredResume?: string
	deferredAbort?: string
	compile?: string
}

export interface CloudAgentRestFieldMapping {
	request?: Partial<{
		goal: string
		sessionId: string
		workspacePath: string
		images: string
		runId: string
		toolResults: string
	}>
	response?: Partial<{
		runId: string
		status: string
		pendingTools: string
		toolCalls: string
		workspaceOps: string
		text: string
		reasoning: string
		logs: string
		ok: string
		memorySummary: string
		tokensIn: string
		tokensOut: string
		cost: string
	}>
	statusValues?: Partial<{
		pending: string
		done: string
	}>
}

export interface CloudAgentAuthConfig {
	type: "api-key" | "bearer" | "basic" | "device-token" | "custom"
	apiKeyHeader?: string
	apiKey?: string
	bearerToken?: string
	basicUsername?: string
	basicPassword?: string
	deviceTokenSource?: "global" | "profile"
	deviceToken?: string
	customHeaders?: Record<string, string>
}

export interface CloudAgentProfile {
	id: string
	name: string
	description?: string
	icon?: string
	protocolType: CloudAgentProtocolType
	serverUrl: string
	endpoints?: CloudAgentEndpointConfig
	fieldMapping?: CloudAgentRestFieldMapping
	auth: CloudAgentAuthConfig
	createdAt: number
	updatedAt: number
	isBuiltIn?: boolean
}

/**
 * AuthState
 */

export type AuthState = "initializing" | "logged-out" | "active-session" | "attempting-session" | "inactive-session"
