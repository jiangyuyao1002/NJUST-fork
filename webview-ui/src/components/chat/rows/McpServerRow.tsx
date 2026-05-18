import React from "react"

import type { ClineMessage, ClineAskUseMcpServer } from "@njust-ai-cj/types"
import type { McpServer } from "@njust-ai-cj/types"

import { findMatchingResourceOrTemplate } from "@src/utils/mcp"

import McpResourceRow from "../../mcp/McpResourceRow"
import { McpExecution } from "../McpExecution"
import { safeJsonParse } from "@roo/core"

import { headerStyle } from "./constants"

interface McpServerRowProps {
	message: ClineMessage
	icon: React.ReactNode
	title: React.ReactNode
	mcpServers: McpServer[]
	alwaysAllowMcp: boolean
}

export const McpServerRow = ({
	message,
	icon,
	title,
	mcpServers,
	alwaysAllowMcp,
}: McpServerRowProps) => {
	const messageJson = safeJsonParse<any>(message.text, {})

	const { response, ...mcpServerRequest } = messageJson

	const useMcpServer: ClineAskUseMcpServer = {
		...mcpServerRequest,
		response,
	}

	if (!useMcpServer) {
		return null
	}

	const server = mcpServers.find((server) => server.name === useMcpServer.serverName)

	return (
		<>
			<div style={headerStyle}>
				{icon}
				{title}
			</div>
			<div className="w-full bg-vscode-editor-background border border-vscode-border rounded-xs p-2 mt-2">
				{useMcpServer.type === "access_mcp_resource" && (
					<McpResourceRow
						item={{
							...(findMatchingResourceOrTemplate(
								useMcpServer.uri || "",
								server?.resources,
								server?.resourceTemplates,
							) || {
								name: "",
								mimeType: "",
								description: "",
							}),
							uri: useMcpServer.uri || "",
						}}
					/>
				)}
				{useMcpServer.type === "use_mcp_tool" && (
					<McpExecution
						executionId={message.ts.toString()}
						text={useMcpServer.arguments !== "{}" ? useMcpServer.arguments : undefined}
						serverName={useMcpServer.serverName}
						toolName={useMcpServer.toolName}
						isArguments={true}
						server={server}
						useMcpServer={useMcpServer}
						alwaysAllowMcp={alwaysAllowMcp}
					/>
				)}
			</div>
		</>
	)
}
