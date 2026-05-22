import React from "react"
import { useTranslation } from "react-i18next"
import { VSCodeBadge } from "@vscode/webview-ui-toolkit/react"

import type { ClineMessage, ClineSayTool } from "@njust-ai-cj/types"

import { vscode } from "@src/utils/vscode"

import { ToolUseBlock, ToolUseBlockHeader } from "../../common/ToolUseBlock"
import MarkdownBlock from "../../common/MarkdownBlock"
import CodebaseSearchResultsDisplay from "../CodebaseSearchResultsDisplay"

import { Check, ArrowRight, FileCode2 } from "lucide-react"

import { headerStyle } from "./constants"

interface SayToolResultRowProps {
	message: ClineMessage
	isExpanded: boolean
	onToggleExpand: () => void
	clineMessages: ClineMessage[]
	currentTaskItem?: {
		id: string
		childIds?: string[]
		completedByChildId?: string
		parentTaskId?: string
	}
}

export const SayToolResultRow = ({
	message,
	isExpanded: _isExpanded,
	onToggleExpand: _onToggleExpand,
	clineMessages: _clineMessages,
	currentTaskItem,
}: SayToolResultRowProps) => {
	const { t } = useTranslation()

	if (message.say === "subtask_result") {
		const completedChildTaskId = currentTaskItem?.completedByChildId
		return (
			<div className="border-l border-muted-foreground/80 ml-2 pl-4 pt-2 pb-1 -mt-5">
				<div style={headerStyle}>
					<span style={{ fontWeight: "bold" }}>{t("chat:subtasks.resultContent")}</span>
					<Check className="size-3" />
				</div>
				<MarkdownBlock markdown={message.text} />
				{completedChildTaskId && (
					<button
						className="cursor-pointer flex gap-1 items-center mt-2 text-vscode-descriptionForeground hover:text-vscode-descriptionForeground hover:underline font-normal"
						onClick={() =>
							vscode.postMessage({ type: "showTaskWithId", text: completedChildTaskId })
						}>
						{t("chat:subtasks.goToSubtask")}
						<ArrowRight className="size-3" />
					</button>
				)}
			</div>
		)
	}

	if (message.say === "codebase_search_result") {
		let parsed: {
			content: {
				query: string
				results: Array<{
					filePath: string
					score: number
					startLine: number
					endLine: number
					codeChunk: string
				}>
			}
		} | null = null

		try {
			if (message.text) {
				parsed = JSON.parse(message.text)
			}
		} catch (error) {
			console.error("Failed to parse codebaseSearch content:", error)
		}

		if (parsed && !parsed?.content) {
			console.error("Invalid codebaseSearch content structure:", parsed.content)
			return <div>Error displaying search results.</div>
		}

		const { results = [] } = parsed?.content || {}

		return <CodebaseSearchResultsDisplay results={results} />
	}

	if (message.say === "tool" as any) {
		const sayTool = JSON.parse(message.text || "{}") as ClineSayTool
		if (!sayTool) return null

		switch (sayTool.tool) {
			case "runSlashCommand": {
				const slashCommandInfo = sayTool
				return (
					<>
						<div style={headerStyle}>
							<span
								className="codicon codicon-terminal-cmd"
								style={{
									color: "var(--vscode-foreground)",
									marginBottom: "-1.5px",
								}}></span>
							<span style={{ fontWeight: "bold" }}>{t("chat:slashCommand.didRun")}</span>
						</div>
						<div className="pl-6">
							<ToolUseBlock>
								<ToolUseBlockHeader
									style={{
										display: "flex",
										flexDirection: "column",
										alignItems: "flex-start",
										gap: "4px",
										padding: "10px 12px",
									}}>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: "8px",
											width: "100%",
										}}>
										<span
											style={{
												fontWeight: "500",
												fontSize: "var(--vscode-font-size)",
											}}>
											/{slashCommandInfo.command}
										</span>
										{slashCommandInfo.args && (
											<span
												style={{
													color: "var(--vscode-descriptionForeground)",
													fontSize: "var(--vscode-font-size)",
												}}>
												{slashCommandInfo.args}
											</span>
										)}
									</div>
									{slashCommandInfo.description && (
										<div
											style={{
												color: "var(--vscode-descriptionForeground)",
												fontSize: "calc(var(--vscode-font-size) - 1px)",
											}}>
											{slashCommandInfo.description}
										</div>
									)}
									{slashCommandInfo.source && (
										<div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
											<VSCodeBadge
												style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
												{slashCommandInfo.source}
											</VSCodeBadge>
										</div>
									)}
								</ToolUseBlockHeader>
							</ToolUseBlock>
						</div>
					</>
				)
			}
			case "readCommandOutput": {
				const formatBytes = (bytes: number) => {
					if (bytes < 1024) return `${bytes} B`
					if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
					return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
				}

				const isSearch = sayTool.searchPattern !== undefined

				let infoText = ""
				if (isSearch) {
					const matchText =
						sayTool.matchCount !== undefined
							? sayTool.matchCount === 1
								? "1 match"
								: `${sayTool.matchCount} matches`
							: ""
					infoText = `search: "${sayTool.searchPattern}"${matchText ? ` • ${matchText}` : ""}`
				} else if (
					sayTool.readStart !== undefined &&
					sayTool.readEnd !== undefined &&
					sayTool.totalBytes !== undefined
				) {
					infoText = `${formatBytes(sayTool.readStart)} - ${formatBytes(sayTool.readEnd)} of ${formatBytes(sayTool.totalBytes)}`
				} else if (sayTool.totalBytes !== undefined) {
					infoText = formatBytes(sayTool.totalBytes)
				}

				return (
					<div style={headerStyle}>
						<FileCode2 className="w-4 shrink-0" aria-label="Read command output icon" />
						<span style={{ fontWeight: "bold" }}>{t("chat:readCommandOutput.title")}</span>
						{infoText && (
							<span
								className="text-xs ml-1"
								style={{ color: "var(--vscode-descriptionForeground)" }}>
								({infoText})
							</span>
						)}
					</div>
				)
			}
			default:
				return null
		}
	}

	return null
}
