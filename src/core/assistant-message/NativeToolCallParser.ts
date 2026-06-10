import { parseJSON } from "partial-json"

import { type ToolName } from "@njust-ai/types"

import { type ToolUse, type McpToolUse } from "../../shared/tools"
import { resolveToolAlias } from "../prompts/tools/filter-tools-for-mode"
import type {
	ApiStreamToolCallStartChunk,
	ApiStreamToolCallDeltaChunk,
	ApiStreamToolCallEndChunk,
} from "../../api/transform/stream"
import { MCP_TOOL_PREFIX, MCP_TOOL_SEPARATOR } from "../../utils/mcp-name"
import { NativeToolCallFormatter } from "./NativeToolCallFormatter"

export type ToolCallStreamEvent = ApiStreamToolCallStartChunk | ApiStreamToolCallDeltaChunk | ApiStreamToolCallEndChunk

export class NativeToolCallParser {
	private streamingToolCalls = new Map<
		string,
		{
			id: string
			name: string
			argumentsAccumulator: string
		}
	>()

	private rawChunkTracker = new Map<
		number,
		{
			id: string
			name: string
			hasStarted: boolean
			deltaBuffer: string[]
		}
	>()

	public processRawChunk(chunk: {
		index: number
		id?: string
		name?: string
		arguments?: string
	}): ToolCallStreamEvent[] {
		const events: ToolCallStreamEvent[] = []
		const { index, id, name, arguments: args } = chunk

		let tracked = this.rawChunkTracker.get(index)

		if (id && !tracked) {
			tracked = {
				id,
				name: name || "",
				hasStarted: false,
				deltaBuffer: [],
			}
			this.rawChunkTracker.set(index, tracked)
		}

		if (!tracked) {
			return events
		}

		if (name) {
			tracked.name = name
		}

		if (!tracked.hasStarted && tracked.name) {
			events.push({
				type: "tool_call_start",
				id: tracked.id,
				name: tracked.name,
			})
			tracked.hasStarted = true

			for (const bufferedDelta of tracked.deltaBuffer) {
				events.push({
					type: "tool_call_delta",
					id: tracked.id,
					delta: bufferedDelta,
				})
			}
			tracked.deltaBuffer = []
		}

		if (args) {
			if (tracked.hasStarted) {
				events.push({
					type: "tool_call_delta",
					id: tracked.id,
					delta: args,
				})
			} else {
				tracked.deltaBuffer.push(args)
			}
		}

		return events
	}

	public processFinishReason(finishReason: string | null | undefined): ToolCallStreamEvent[] {
		const events: ToolCallStreamEvent[] = []

		if (finishReason === "tool_calls" && this.rawChunkTracker.size > 0) {
			for (const [, tracked] of this.rawChunkTracker.entries()) {
				events.push({
					type: "tool_call_end",
					id: tracked.id,
				})
			}
		}

		return events
	}

	public finalizeRawChunks(): ToolCallStreamEvent[] {
		const events: ToolCallStreamEvent[] = []

		if (this.rawChunkTracker.size > 0) {
			for (const [, tracked] of this.rawChunkTracker.entries()) {
				if (tracked.hasStarted) {
					events.push({
						type: "tool_call_end",
						id: tracked.id,
					})
				}
			}
			this.rawChunkTracker.clear()
		}

		return events
	}

	public clearRawChunkState(): void {
		this.rawChunkTracker.clear()
	}

	public startStreamingToolCall(id: string, name: string): void {
		this.streamingToolCalls.set(id, {
			id,
			name,
			argumentsAccumulator: "",
		})
	}

	public clearAllStreamingToolCalls(): void {
		this.streamingToolCalls.clear()
	}

	public hasActiveStreamingToolCalls(): boolean {
		return this.streamingToolCalls.size > 0
	}

	public processStreamingChunk(id: string, chunk: string): ToolUse | null {
		const toolCall = this.streamingToolCalls.get(id)
		if (!toolCall) {
			return null
		}

		toolCall.argumentsAccumulator += chunk

		const mcpPrefix = MCP_TOOL_PREFIX + MCP_TOOL_SEPARATOR
		if (toolCall.name.startsWith(mcpPrefix)) {
			return null
		}

		try {
			const partialArgs = parseJSON(toolCall.argumentsAccumulator)

			const resolvedName = resolveToolAlias(toolCall.name) as ToolName
			const originalName = toolCall.name !== resolvedName ? toolCall.name : undefined

			return NativeToolCallFormatter.createPartialToolUse(
				toolCall.id,
				resolvedName,
				partialArgs || {},
				true,
				originalName,
			)
		} catch {
			return null
		}
	}

	public finalizeStreamingToolCall(id: string): ToolUse | McpToolUse | null {
		const toolCall = this.streamingToolCalls.get(id)
		if (!toolCall) {
			return null
		}

		const finalToolUse = NativeToolCallFormatter.parseToolCall({
			id: toolCall.id,
			name: toolCall.name as ToolName,
			arguments: toolCall.argumentsAccumulator,
		})

		this.streamingToolCalls.delete(id)

		return finalToolUse
	}

	// ── Backward-compatible static wrappers ──
	// Delegate formatting/serialization to NativeToolCallFormatter.
	// Prefer per-task instances for state isolation.

	public static parseToolCall: typeof NativeToolCallFormatter.parseToolCall = NativeToolCallFormatter.parseToolCall
	public static parseDynamicMcpTool: typeof NativeToolCallFormatter.parseDynamicMcpTool =
		NativeToolCallFormatter.parseDynamicMcpTool
	public static createPartialToolUse: typeof NativeToolCallFormatter.createPartialToolUse =
		NativeToolCallFormatter.createPartialToolUse

	/** @deprecated Use per-task instance via `new NativeToolCallParser()` */
	public static clearAllStreamingToolCalls(): void {
		sharedInstance.clearAllStreamingToolCalls()
	}

	/** @deprecated Use per-task instance via `new NativeToolCallParser()` */
	public static clearRawChunkState(): void {
		sharedInstance.clearRawChunkState()
	}

	/** @deprecated Use per-task instance via `new NativeToolCallParser()` */
	public static startStreamingToolCall(id: string, name: string): void {
		sharedInstance.startStreamingToolCall(id, name)
	}

	/** @deprecated Use per-task instance via `new NativeToolCallParser()` */
	public static processRawChunk(chunk: {
		index: number
		id: string
		name: string
		arguments: string
	}): ToolCallStreamEvent[] {
		return sharedInstance.processRawChunk(chunk)
	}

	/** @deprecated Use per-task instance via `new NativeToolCallParser()` */
	public static finalizeRawChunks(): ToolCallStreamEvent[] {
		return sharedInstance.finalizeRawChunks()
	}
	/** @deprecated Use per-task instance via `new NativeToolCallParser()` */
	public static processStreamingChunk(id: string, chunk: string): ToolUse | null {
		return sharedInstance.processStreamingChunk(id, chunk)
	}

	/** @deprecated Use per-task instance via `new NativeToolCallParser()` */
	public static finalizeStreamingToolCall(id: string): ToolUse | McpToolUse | null {
		return sharedInstance.finalizeStreamingToolCall(id)
	}

	/** @deprecated Use per-task instance via `new NativeToolCallParser()` */
	public static hasActiveStreamingToolCalls(): boolean {
		return sharedInstance.hasActiveStreamingToolCalls()
	}

	/** @deprecated Use per-task instance via `new NativeToolCallParser()` */
	public static processFinishReason(finishReason: string | null | undefined): ToolCallStreamEvent[] {
		return sharedInstance.processFinishReason(finishReason)
	}
}

const sharedInstance = new NativeToolCallParser()
