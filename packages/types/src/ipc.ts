import { z } from "zod"

import { type TaskEvent, taskEventSchema } from "./events.js"
import { NjustAiSettingsSchema } from "./global-settings.js"

/**
 * IpcMessageType
 */

export enum IpcMessageType {
	Connect = "Connect",
	Disconnect = "Disconnect",
	Ack = "Ack",
	TaskCommand = "TaskCommand",
	TaskEvent = "TaskEvent",
	/** Structured error from server (optional IPC v2). */
	ServerError = "ServerError",
}

/** Bump when adding breaking IPC payload shapes; sent on Ack optionally. */
export const IPC_PROTOCOL_VERSION = 1 as const

/**
 * IpcOrigin
 */

export enum IpcOrigin {
	Client = "client",
	Server = "server",
}

/**
 * Ack
 */

export const ackSchema = z.object({
	clientId: z.string(),
	protocolVersion: z.number().int().optional(),
})

export type Ack = z.infer<typeof ackSchema>

/**
 * TaskCommandName
 */

export enum TaskCommandName {
	StartNewTask = "StartNewTask",
	CancelTask = "CancelTask",
	CloseTask = "CloseTask",
	ResumeTask = "ResumeTask",
	SendMessage = "SendMessage",
	GetCommands = "GetCommands",
	GetModes = "GetModes",
	GetModels = "GetModels",
	DeleteQueuedMessage = "DeleteQueuedMessage",
}

/**
 * TaskCommand
 */

export const taskCommandSchema = z.discriminatedUnion("commandName", [
	z.object({
		commandName: z.literal(TaskCommandName.StartNewTask),
		data: z.object({
			configuration: NjustAiSettingsSchema,
			text: z.string(),
			images: z.array(z.string()).optional(),
			newTab: z.boolean().optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.CancelTask),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.CloseTask),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.ResumeTask),
		data: z.string(),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.SendMessage),
		data: z.object({
			text: z.string().optional(),
			images: z.array(z.string()).optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetCommands),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetModes),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetModels),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.DeleteQueuedMessage),
		data: z.string(), // messageId
	}),
])

export type TaskCommand = z.infer<typeof taskCommandSchema>

/**
 * IpcMessage
 */

export const ipcMessageSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal(IpcMessageType.Ack),
		origin: z.literal(IpcOrigin.Server),
		data: ackSchema,
	}),
	z.object({
		type: z.literal(IpcMessageType.TaskCommand),
		origin: z.literal(IpcOrigin.Client),
		clientId: z.string(),
		data: taskCommandSchema,
	}),
	z.object({
		type: z.literal(IpcMessageType.TaskEvent),
		origin: z.literal(IpcOrigin.Server),
		relayClientId: z.string().optional(),
		data: taskEventSchema,
	}),
	z.object({
		type: z.literal(IpcMessageType.ServerError),
		origin: z.literal(IpcOrigin.Server),
		protocolVersion: z.number().int().optional(),
		data: z.object({
			message: z.string(),
			code: z.string().optional(),
		}),
	}),
])

export type IpcMessage = z.infer<typeof ipcMessageSchema>

/**
 * IpcClientEvents
 */

export type IpcServerErrorPayload = {
	message: string
	code?: string
}

export type IpcClientEvents = {
	[IpcMessageType.Connect]: []
	[IpcMessageType.Disconnect]: []
	[IpcMessageType.Ack]: [data: Ack]
	[IpcMessageType.TaskCommand]: [data: TaskCommand]
	[IpcMessageType.TaskEvent]: [data: TaskEvent]
	[IpcMessageType.ServerError]: [data: IpcServerErrorPayload]
}

/**
 * IpcServerEvents
 */

export type IpcServerEvents = {
	[IpcMessageType.Connect]: [clientId: string]
	[IpcMessageType.Disconnect]: [clientId: string]
	[IpcMessageType.TaskCommand]: [clientId: string, data: TaskCommand]
	[IpcMessageType.TaskEvent]: [relayClientId: string | undefined, data: TaskEvent]
}
