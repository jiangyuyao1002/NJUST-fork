import { z } from "zod"
import { clineMessageSchema } from "@njust-ai/types"

const unknownObjectSchema = z.record(z.string(), z.unknown())
const optionalStringArraySchema = z.array(z.string()).optional()

const openedTabSchema = z.object({
	label: z.string(),
	isActive: z.boolean(),
	path: z.string().optional(),
})

const actionMessageSchema = z.object({
	type: z.literal("action"),
	action: z.enum([
		"chatButtonClicked",
		"settingsButtonClicked",
		"historyButtonClicked",
		"didBecomeVisible",
		"focusInput",
		"switchTab",
		"toggleAutoApprove",
		"resetLogin",
	]),
})

const handledExtensionMessageSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("state"),
		state: unknownObjectSchema.optional(),
	}),
	actionMessageSchema,
	z.object({
		type: z.literal("theme"),
		text: z.string().optional(),
	}),
	z.object({
		type: z.literal("workspaceUpdated"),
		filePaths: optionalStringArraySchema,
		openedTabs: z.array(openedTabSchema).optional(),
	}),
	z.object({
		type: z.literal("commands"),
		commands: z.array(unknownObjectSchema).optional(),
	}),
	z.object({
		type: z.literal("messageUpdated"),
		clineMessage: clineMessageSchema.optional(),
	}),
	z.object({
		type: z.literal("skills"),
		skills: z.array(unknownObjectSchema).optional(),
	}),
	z.object({
		type: z.literal("mcpServers"),
		mcpServers: z.array(unknownObjectSchema).optional(),
	}),
	z.object({
		type: z.literal("currentCheckpointUpdated"),
		text: z.string().optional(),
	}),
	z.object({
		type: z.literal("listApiConfig"),
		listApiConfig: z.array(unknownObjectSchema).optional(),
	}),
	z.object({
		type: z.literal("routerModels"),
		routerModels: unknownObjectSchema.optional(),
	}),
	z.object({
		type: z.literal("taskHistoryUpdated"),
		taskHistory: z.array(unknownObjectSchema).optional(),
	}),
	z.object({
		type: z.literal("taskHistoryItemUpdated"),
		taskHistoryItem: unknownObjectSchema.optional(),
	}),
	z.object({
		type: z.literal("taskMetrics"),
		taskMetrics: unknownObjectSchema.optional(),
	}),
])

export type ParsedExtensionStateMessage = z.infer<typeof handledExtensionMessageSchema>

const handledMessageTypes: Set<string> = new Set([
	"state",
	"action",
	"theme",
	"workspaceUpdated",
	"commands",
	"messageUpdated",
	"skills",
	"mcpServers",
	"currentCheckpointUpdated",
	"listApiConfig",
	"routerModels",
	"taskHistoryUpdated",
	"taskHistoryItemUpdated",
	"taskMetrics",
])

export function parseExtensionStateMessage(data: unknown): ParsedExtensionStateMessage | undefined {
	if (!data || typeof data !== "object") {
		return undefined
	}

	const type = (data as { type?: unknown }).type
	if (typeof type !== "string" || !handledMessageTypes.has(type)) {
		return undefined
	}

	const result = handledExtensionMessageSchema.safeParse(data)
	if (!result.success) {
		console.warn("[ExtensionStateContext] Ignoring invalid extension message", {
			type,
			error: result.error.flatten(),
		})
		return undefined
	}

	return result.data
}
