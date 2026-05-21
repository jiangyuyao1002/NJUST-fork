import { z } from "zod"
import type { ClineAskUseMcpServer } from "@njust-ai-cj/types"

import type { ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { ignoreAbortError } from "../../utils/errorHandling"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface AccessMcpResourceParams {
	server_name: string
	uri: string
}

export class AccessMcpResourceTool extends BaseTool<"access_mcp_resource"> {
	readonly name = "access_mcp_resource" as const

	protected override get inputSchema() {
		return z.object({
			server_name: z.string().min(1, "server_name is required"),
			uri: z.string().min(1, "uri is required"),
		})
	}

	async execute(params: AccessMcpResourceParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { server_name, uri } = params

		try {
			task.consecutiveMistakeCount = 0

			const completeMessage = JSON.stringify({
				type: "access_mcp_resource",
				serverName: server_name,
				uri,
			} satisfies ClineAskUseMcpServer)

			const didApprove = await askApproval("use_mcp_server", completeMessage)

			if (!didApprove) {
				pushToolResult(formatResponse.toolDenied())
				return
			}

			// Now execute the tool
			await task.say("mcp_server_request_started")
			const resourceResult = await task.providerRef.deref()?.getMcpHub()?.readResource(server_name, uri)

			const resourceResultPretty =
				resourceResult?.contents
					.map((item) => {
						if (item.text) {
							return item.text
						}
						return ""
					})
					.filter(Boolean)
					.join("\n\n") || "(Empty response)"

			// Handle images (image must contain mimetype and blob)
			const images: string[] = []

			resourceResult?.contents.forEach((item) => {
				if (item.mimeType?.startsWith("image") && item.blob) {
					if (item.blob.startsWith("data:")) {
						images.push(item.blob)
					} else {
						images.push(`data:${item.mimeType};base64,` + item.blob)
					}
				}
			})

			await task.say("mcp_server_response", resourceResultPretty, images)
			pushToolResult(formatResponse.toolResult(resourceResultPretty, images))
		} catch (error) {
			await handleError("accessing MCP resource", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"access_mcp_resource">): Promise<void> {
		const server_name = block.params.server_name ?? ""
		const uri = block.params.uri ?? ""

		const partialMessage = JSON.stringify({
			type: "access_mcp_resource",
			serverName: server_name,
			uri: uri,
		} satisfies ClineAskUseMcpServer)

		await task.ask("use_mcp_server", partialMessage, block.partial).catch(ignoreAbortError)
	}
}

export const accessMcpResourceTool = new AccessMcpResourceTool()
