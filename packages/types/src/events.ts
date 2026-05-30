import { z } from "zod"

import { clineMessageSchema, queuedMessageSchema, tokenUsageSchema } from "./message.js"
import { modelInfoSchema } from "./model.js"
import { toolNamesSchema, toolUsageSchema } from "./tool.js"

/**
 * NJUST_AIEventName
 */

export enum NJUST_AIEventName {
	// Task Provider Lifecycle
	TaskCreated = "taskCreated",

	// Task Lifecycle
	TaskStarted = "taskStarted",
	TaskCompleted = "taskCompleted",
	TaskAborted = "taskAborted",
	TaskFocused = "taskFocused",
	TaskUnfocused = "taskUnfocused",
	TaskActive = "taskActive",
	TaskInteractive = "taskInteractive",
	TaskResumable = "taskResumable",
	TaskIdle = "taskIdle",

	// Subtask Lifecycle
	TaskPaused = "taskPaused",
	TaskUnpaused = "taskUnpaused",
	TaskSpawned = "taskSpawned",
	TaskDelegated = "taskDelegated",
	TaskDelegationCompleted = "taskDelegationCompleted",
	TaskDelegationResumed = "taskDelegationResumed",

	// Task Execution
	Message = "message",
	TaskModeSwitched = "taskModeSwitched",
	TaskAskResponded = "taskAskResponded",
	TaskUserMessage = "taskUserMessage",
	QueuedMessagesUpdated = "queuedMessagesUpdated",

	// Task Analytics
	TaskTokenUsageUpdated = "taskTokenUsageUpdated",
	TaskToolFailed = "taskToolFailed",

	// Configuration Changes
	ModeChanged = "modeChanged",
	ProviderProfileChanged = "providerProfileChanged",

	// Query Responses
	CommandsResponse = "commandsResponse",
	ModesResponse = "modesResponse",
	ModelsResponse = "modelsResponse",

	// Evals
	EvalPass = "evalPass",
	EvalFail = "evalFail",
}

/**
 * NJUST_AIEvents
 */

export const NjustAiEventsSchema = z.object({
	[NJUST_AIEventName.TaskCreated]: z.tuple([z.string()]),

	[NJUST_AIEventName.TaskStarted]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskCompleted]: z.tuple([
		z.string(),
		tokenUsageSchema,
		toolUsageSchema,
		z.object({
			isSubtask: z.boolean(),
		}),
	]),
	[NJUST_AIEventName.TaskAborted]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskFocused]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskUnfocused]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskActive]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskInteractive]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskResumable]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskIdle]: z.tuple([z.string()]),

	[NJUST_AIEventName.TaskPaused]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskUnpaused]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskSpawned]: z.tuple([z.string(), z.string()]),
	[NJUST_AIEventName.TaskDelegated]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
	]),
	[NJUST_AIEventName.TaskDelegationCompleted]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
		z.string(), // completionResultSummary
	]),
	[NJUST_AIEventName.TaskDelegationResumed]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
	]),

	[NJUST_AIEventName.Message]: z.tuple([
		z.object({
			taskId: z.string(),
			action: z.union([z.literal("created"), z.literal("updated")]),
			message: clineMessageSchema,
		}),
	]),
	[NJUST_AIEventName.TaskModeSwitched]: z.tuple([z.string(), z.string()]),
	[NJUST_AIEventName.TaskAskResponded]: z.tuple([z.string()]),
	[NJUST_AIEventName.TaskUserMessage]: z.tuple([z.string()]),
	[NJUST_AIEventName.QueuedMessagesUpdated]: z.tuple([z.string(), z.array(queuedMessageSchema)]),

	[NJUST_AIEventName.TaskToolFailed]: z.tuple([z.string(), toolNamesSchema, z.string()]),
	[NJUST_AIEventName.TaskTokenUsageUpdated]: z.tuple([z.string(), tokenUsageSchema, toolUsageSchema]),

	[NJUST_AIEventName.ModeChanged]: z.tuple([z.string()]),
	[NJUST_AIEventName.ProviderProfileChanged]: z.tuple([z.object({ name: z.string(), provider: z.string() })]),

	[NJUST_AIEventName.CommandsResponse]: z.tuple([
		z.array(
			z.object({
				name: z.string(),
				source: z.enum(["global", "project", "built-in"]),
				filePath: z.string().optional(),
				description: z.string().optional(),
				argumentHint: z.string().optional(),
			}),
		),
	]),
	[NJUST_AIEventName.ModesResponse]: z.tuple([z.array(z.object({ slug: z.string(), name: z.string() }))]),
	[NJUST_AIEventName.ModelsResponse]: z.tuple([z.record(z.string(), modelInfoSchema)]),
})

export type NJUST_AIEvents = z.infer<typeof NjustAiEventsSchema>

/**
 * TaskEvent
 */

export const taskEventSchema = z.discriminatedUnion("eventName", [
	// Task Provider Lifecycle
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskCreated),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskCreated],
		taskId: z.number().optional(),
	}),

	// Task Lifecycle
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskStarted),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskStarted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskCompleted),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskCompleted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskAborted),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskAborted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskFocused),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskFocused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskUnfocused),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskUnfocused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskActive),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskActive],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskInteractive),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskInteractive],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskResumable),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskResumable],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskIdle),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskIdle],
		taskId: z.number().optional(),
	}),

	// Subtask Lifecycle
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskPaused),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskPaused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskUnpaused),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskUnpaused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskSpawned),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskSpawned],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskDelegated),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskDelegated],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskDelegationCompleted),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskDelegationCompleted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskDelegationResumed),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskDelegationResumed],
		taskId: z.number().optional(),
	}),

	// Task Execution
	z.object({
		eventName: z.literal(NJUST_AIEventName.Message),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.Message],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskModeSwitched),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskModeSwitched],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskAskResponded),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskAskResponded],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.QueuedMessagesUpdated),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.QueuedMessagesUpdated],
		taskId: z.number().optional(),
	}),

	// Task Analytics
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskToolFailed),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskToolFailed],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.TaskTokenUsageUpdated),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.TaskTokenUsageUpdated],
		taskId: z.number().optional(),
	}),

	// Query Responses
	z.object({
		eventName: z.literal(NJUST_AIEventName.CommandsResponse),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.CommandsResponse],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.ModesResponse),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.ModesResponse],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.ModelsResponse),
		payload: NjustAiEventsSchema.shape[NJUST_AIEventName.ModelsResponse],
		taskId: z.number().optional(),
	}),

	// Evals
	z.object({
		eventName: z.literal(NJUST_AIEventName.EvalPass),
		payload: z.undefined(),
		taskId: z.number(),
	}),
	z.object({
		eventName: z.literal(NJUST_AIEventName.EvalFail),
		payload: z.undefined(),
		taskId: z.number(),
	}),
])

export type TaskEvent = z.infer<typeof taskEventSchema>
