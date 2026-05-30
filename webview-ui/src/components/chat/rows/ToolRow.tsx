import React from "react"
import { useTranslation, Trans } from "react-i18next"
import { VSCodeBadge } from "@vscode/webview-ui-toolkit/react"

import type { ClineMessage, ClineSayTool } from "@njust-ai/types"

import { safeJsonParse } from "@njust-ai/core/browser"

import { vscode } from "@src/utils/vscode"
import { formatPathTooltip } from "@src/utils/formatPathTooltip"

import { ToolUseBlock, ToolUseBlockHeader } from "../../common/ToolUseBlock"
import { TodoChangeDisplay } from "../TodoChangeDisplay"
import CodeAccordion from "../../common/CodeAccordion"
import MarkdownBlock from "../../common/MarkdownBlock"
import { BatchFilePermission } from "../BatchFilePermission"
import { BatchDiffApproval } from "../BatchDiffApproval"
import { PathTooltip } from "../../ui/PathTooltip"

import {
	Eye,
	FileDiff,
	ListTree,
	FileCode2,
	PocketKnife,
	FolderTree,
	Split,
	ArrowRight,
	SquareArrowOutUpRight,
} from "lucide-react"

import { headerStyle } from "./constants"

interface TodoItem {
	id?: string
	content: string
	status?: string
}

function getPreviousTodos(messages: ClineMessage[], currentMessageTs: number): TodoItem[] {
	const previousUpdateIndex = messages
		.slice()
		.reverse()
		.findIndex((msg) => {
			if (msg.ts >= currentMessageTs) return false
			if (msg.type === "ask" && msg.ask === "tool") {
				try {
					const tool = JSON.parse(msg.text || "{}")
					return tool.tool === "updateTodoList"
				} catch {
					return false
				}
			}
			return false
		})

	if (previousUpdateIndex !== -1) {
		const previousMessage = messages.slice().reverse()[previousUpdateIndex]!
		try {
			const tool = JSON.parse(previousMessage.text || "{}")
			return tool.todos || []
		} catch {
			return []
		}
	}

	return []
}

interface ToolRowProps {
	message: ClineMessage
	tool: ClineSayTool
	unifiedDiff?: string
	onJumpToCreatedFile?: () => void
	isExpanded: boolean
	onToggleExpand: () => void
	clineMessages: ClineMessage[]
	currentTaskItem?: {
		id: string
		childIds?: string[]
		completedByChildId?: string
		parentTaskId?: string
	}
	onBatchFileResponse?: (response: { [key: string]: boolean }) => void
}

export const ToolRow = ({
	message,
	tool,
	unifiedDiff,
	onJumpToCreatedFile,
	isExpanded,
	onToggleExpand,
	clineMessages,
	currentTaskItem,
	onBatchFileResponse,
}: ToolRowProps) => {
	const { t } = useTranslation()

	const toolIcon = (name: string) => (
		<span
			className={`codicon codicon-${name}`}
			style={{ color: "var(--vscode-foreground)", marginBottom: "-1.5px" }}></span>
	)

	switch (tool.tool as string) {
		case "editedExistingFile":
		case "appliedDiff":
		case "newFileCreated":
		case "searchAndReplace":
		case "search_and_replace":
		case "search_replace":
		case "edit":
		case "edit_file":
		case "apply_patch":
		case "apply_diff":
			if (message.type === "ask" && tool.batchDiffs && Array.isArray(tool.batchDiffs)) {
				return (
					<>
						<div style={headerStyle}>
							<FileDiff className="w-4 shrink-0" aria-label="Batch diff icon" />
							<span style={{ fontWeight: "bold" }}>
								{t("chat:fileOperations.wantsToApplyBatchChanges")}
							</span>
						</div>
						<BatchDiffApproval files={tool.batchDiffs} ts={message.ts} />
					</>
				)
			}

			return (
				<>
					<div style={headerStyle}>
						{tool.isProtected ? (
							<span
								className="codicon codicon-lock"
								style={{ color: "var(--vscode-editorWarning-foreground)", marginBottom: "-1.5px" }}
							/>
						) : (
							toolIcon("diff")
						)}
						<span style={{ fontWeight: "bold" }}>
							{tool.isProtected
								? t("chat:fileOperations.wantsToEditProtected")
								: tool.isOutsideWorkspace
									? t("chat:fileOperations.wantsToEditOutsideWorkspace")
									: t("chat:fileOperations.wantsToEdit")}
						</span>
					</div>
					<div className="pl-6">
						<CodeAccordion
							path={tool.path}
							code={unifiedDiff ?? tool.content ?? tool.diff ?? ""}
							language="diff"
							progressStatus={message.progressStatus}
							isLoading={message.partial}
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
							onJumpToFile={onJumpToCreatedFile}
							diffStats={tool.diffStats}
						/>
					</div>
				</>
			)
		case "insertContent":
			return (
				<>
					<div style={headerStyle}>
						{tool.isProtected ? (
							<span
								className="codicon codicon-lock"
								style={{ color: "var(--vscode-editorWarning-foreground)", marginBottom: "-1.5px" }}
							/>
						) : (
							toolIcon("insert")
						)}
						<span style={{ fontWeight: "bold" }}>
							{tool.isProtected
								? t("chat:fileOperations.wantsToEditProtected")
								: tool.isOutsideWorkspace
									? t("chat:fileOperations.wantsToEditOutsideWorkspace")
									: tool.lineNumber === 0
										? t("chat:fileOperations.wantsToInsertAtEnd")
										: t("chat:fileOperations.wantsToInsertWithLineNumber", {
												lineNumber: tool.lineNumber,
											})}
						</span>
					</div>
					<div className="pl-6">
						<CodeAccordion
							path={tool.path}
							code={unifiedDiff ?? tool.diff}
							language="diff"
							progressStatus={message.progressStatus}
							isLoading={message.partial}
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
							diffStats={tool.diffStats}
						/>
					</div>
				</>
			)
		case "codebaseSearch": {
			return (
				<div style={headerStyle}>
					{toolIcon("search")}
					<span style={{ fontWeight: "bold" }}>
						{tool.path ? (
							<Trans
								i18nKey="chat:codebaseSearch.wantsToSearchWithPath"
								components={{ code: <code></code> }}
								values={{ query: tool.query, path: tool.path }}
							/>
						) : (
							<Trans
								i18nKey="chat:codebaseSearch.wantsToSearch"
								components={{ code: <code></code> }}
								values={{ query: tool.query }}
							/>
						)}
					</span>
				</div>
			)
		}
		case "updateTodoList": {
			const todos = tool.todos || []
			const previousTodos = getPreviousTodos(clineMessages, message.ts)
			return <TodoChangeDisplay previousTodos={previousTodos} newTodos={todos} />
		}
		case "readFile": {
			const isBatchRequest = message.type === "ask" && tool.batchFiles && Array.isArray(tool.batchFiles)

			if (isBatchRequest) {
				return (
					<>
						<div style={headerStyle}>
							<Eye className="w-4 shrink-0" aria-label="View files icon" />
							<span style={{ fontWeight: "bold" }}>
								{t("chat:fileOperations.wantsToReadMultiple")}
							</span>
						</div>
						<BatchFilePermission
							files={tool.batchFiles || []}
							onPermissionResponse={(response: { [key: string]: boolean }) => {
								onBatchFileResponse?.(response)
							}}
							ts={message?.ts}
						/>
					</>
				)
			}

			return (
				<>
					<div style={headerStyle}>
						<FileCode2 className="w-4 shrink-0" aria-label="Read file icon" />
						<span style={{ fontWeight: "bold" }}>
							{message.type === "ask"
								? tool.isOutsideWorkspace
									? t("chat:fileOperations.wantsToReadOutsideWorkspace")
									: tool.additionalFileCount && tool.additionalFileCount > 0
										? t("chat:fileOperations.wantsToReadAndXMore", {
												count: tool.additionalFileCount,
											})
										: t("chat:fileOperations.wantsToRead")
								: t("chat:fileOperations.didRead")}
						</span>
					</div>
					<div className="pl-6">
						<ToolUseBlock>
							<ToolUseBlockHeader
								className="group"
								onClick={() =>
									vscode.postMessage({
										type: "openFile",
										text: tool.content,
										values: tool.startLine ? { line: tool.startLine } : undefined,
									})
								}>
								{tool.path?.startsWith(".") && <span>.</span>}
								<PathTooltip content={formatPathTooltip(tool.path, tool.reason)}>
									<span className="whitespace-nowrap overflow-hidden text-ellipsis text-left mr-2 rtl">
										{formatPathTooltip(tool.path, tool.reason)}
									</span>
								</PathTooltip>
								<div style={{ flexGrow: 1 }}></div>
								<SquareArrowOutUpRight
									className="w-4 shrink-0 codicon codicon-link-external opacity-0 group-hover:opacity-100 transition-opacity"
									style={{ fontSize: 13.5, margin: "1px 0" }}
								/>
							</ToolUseBlockHeader>
						</ToolUseBlock>
					</div>
				</>
			)
		}
		case "skill": {
			const skillInfo = tool
			return (
				<>
					<div style={headerStyle}>
						{toolIcon("book")}
						<span style={{ fontWeight: "bold" }}>
							{message.type === "ask" ? t("chat:skill.wantsToLoad") : t("chat:skill.didLoad")}
						</span>
					</div>
					<div
						style={{
							marginTop: "4px",
							backgroundColor: "var(--vscode-editor-background)",
							border: "1px solid var(--vscode-editorGroup-border)",
							borderRadius: "4px",
							overflow: "hidden",
							cursor: "pointer",
						}}
						onClick={onToggleExpand}>
						<ToolUseBlockHeader
							className="group"
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								padding: "10px 12px",
							}}>
							<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
								<span style={{ fontWeight: "500", fontSize: "var(--vscode-font-size)" }}>
									{skillInfo.skill}
								</span>
								{skillInfo.source && (
									<VSCodeBadge style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
										{skillInfo.source}
									</VSCodeBadge>
								)}
							</div>
							<span
								className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} opacity-0 group-hover:opacity-100 transition-opacity duration-200`}></span>
						</ToolUseBlockHeader>
						{isExpanded && (skillInfo.args || skillInfo.description) && (
							<div
								style={{
									padding: "12px 16px",
									borderTop: "1px solid var(--vscode-editorGroup-border)",
									display: "flex",
									flexDirection: "column",
									gap: "8px",
								}}>
								{skillInfo.description && (
									<div style={{ color: "var(--vscode-descriptionForeground)" }}>
										{skillInfo.description}
									</div>
								)}
								{skillInfo.args && (
									<div>
										<span style={{ fontWeight: "500" }}>Arguments: </span>
										<span style={{ color: "var(--vscode-descriptionForeground)" }}>
											{skillInfo.args}
										</span>
									</div>
								)}
							</div>
						)}
					</div>
				</>
			)
		}
		case "listFilesTopLevel":
			return (
				<>
					<div style={headerStyle}>
						<ListTree className="w-4 shrink-0" aria-label="List files icon" />
						<span style={{ fontWeight: "bold" }}>
							{message.type === "ask"
								? tool.isOutsideWorkspace
									? t("chat:directoryOperations.wantsToViewTopLevelOutsideWorkspace")
									: t("chat:directoryOperations.wantsToViewTopLevel")
								: tool.isOutsideWorkspace
									? t("chat:directoryOperations.didViewTopLevelOutsideWorkspace")
									: t("chat:directoryOperations.didViewTopLevel")}
						</span>
					</div>
					<div className="pl-6">
						<CodeAccordion
							path={tool.path}
							code={tool.content}
							language="shell-session"
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
						/>
					</div>
				</>
			)
		case "listFilesRecursive":
			return (
				<>
					<div style={headerStyle}>
						<FolderTree className="w-4 shrink-0" aria-label="Folder tree icon" />
						<span style={{ fontWeight: "bold" }}>
							{message.type === "ask"
								? tool.isOutsideWorkspace
									? t("chat:directoryOperations.wantsToViewRecursiveOutsideWorkspace")
									: t("chat:directoryOperations.wantsToViewRecursive")
								: tool.isOutsideWorkspace
									? t("chat:directoryOperations.didViewRecursiveOutsideWorkspace")
									: t("chat:directoryOperations.didViewRecursive")}
						</span>
					</div>
					<div className="pl-6">
						<CodeAccordion
							path={tool.path}
							code={tool.content}
							language="shellsession"
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
						/>
					</div>
				</>
			)
		case "searchFiles":
			return (
				<>
					<div style={headerStyle}>
						{toolIcon("search")}
						<span style={{ fontWeight: "bold" }}>
							{message.type === "ask" ? (
								<Trans
									i18nKey={
										tool.isOutsideWorkspace
											? "chat:directoryOperations.wantsToSearchOutsideWorkspace"
											: "chat:directoryOperations.wantsToSearch"
									}
									components={{ code: <code className="font-medium">{tool.regex}</code> }}
									values={{ regex: tool.regex }}
								/>
							) : (
								<Trans
									i18nKey={
										tool.isOutsideWorkspace
											? "chat:directoryOperations.didSearchOutsideWorkspace"
											: "chat:directoryOperations.didSearch"
									}
									components={{ code: <code className="font-medium">{tool.regex}</code> }}
									values={{ regex: tool.regex }}
								/>
							)}
						</span>
					</div>
					<div className="pl-6">
						<CodeAccordion
							path={tool.path! + (tool.filePattern ? `/(${tool.filePattern})` : "")}
							code={tool.content}
							language="shellsession"
							isExpanded={isExpanded}
							onToggleExpand={onToggleExpand}
						/>
					</div>
				</>
			)
		case "switchMode":
			return (
				<>
					<div style={headerStyle}>
						<PocketKnife className="w-4 shrink-0" aria-label="Switch mode icon" />
						<span style={{ fontWeight: "bold" }}>
							{message.type === "ask" ? (
								<>
									{tool.reason ? (
										<Trans
											i18nKey="chat:modes.wantsToSwitchWithReason"
											components={{ code: <code className="font-medium">{tool.mode}</code> }}
											values={{ mode: tool.mode, reason: tool.reason }}
										/>
									) : (
										<Trans
											i18nKey="chat:modes.wantsToSwitch"
											components={{ code: <code className="font-medium">{tool.mode}</code> }}
											values={{ mode: tool.mode }}
										/>
									)}
								</>
							) : (
								<>
									{tool.reason ? (
										<Trans
											i18nKey="chat:modes.didSwitchWithReason"
											components={{ code: <code className="font-medium">{tool.mode}</code> }}
											values={{ mode: tool.mode, reason: tool.reason }}
										/>
									) : (
										<Trans
											i18nKey="chat:modes.didSwitch"
											components={{ code: <code className="font-medium">{tool.mode}</code> }}
											values={{ mode: tool.mode }}
										/>
									)}
								</>
							)}
						</span>
					</div>
				</>
			)
		case "newTask": {
			const newTaskMessages = clineMessages.filter((msg) => {
				if (msg.type === "ask" && msg.ask === "tool") {
					const t = safeJsonParse<ClineSayTool>(msg.text)
					return t?.tool === "newTask"
				}
				return false
			})
			const thisNewTaskIndex = newTaskMessages.findIndex((msg) => msg.ts === message.ts)
			const childIds = currentTaskItem?.childIds || []

			const childTaskId =
				thisNewTaskIndex >= 0 && thisNewTaskIndex < childIds.length ? childIds[thisNewTaskIndex] : undefined

			const currentMessageIndex = clineMessages.findIndex((msg) => msg.ts === message.ts)
			const nextMessage = currentMessageIndex >= 0 ? clineMessages[currentMessageIndex + 1] : undefined
			const isFollowedBySubtaskResult = nextMessage?.type === "say" && nextMessage?.say === "subtask_result"

			return (
				<>
					<div style={headerStyle}>
						<Split className="size-4" />
						<span style={{ fontWeight: "bold" }}>
							<Trans
								i18nKey="chat:subtasks.wantsToCreate"
								components={{ code: <code>{tool.mode}</code> }}
								values={{ mode: tool.mode }}
							/>
						</span>
					</div>
					<div className="border-l border-muted-foreground/80 ml-2 pl-4 pb-1">
						<MarkdownBlock markdown={tool.content} />
						<div>
							{childTaskId && !isFollowedBySubtaskResult && (
								<button
									className="cursor-pointer flex gap-1 items-center mt-2 text-vscode-descriptionForeground hover:text-vscode-descriptionForeground hover:underline font-normal"
									onClick={() =>
										vscode.postMessage({ type: "showTaskWithId", text: childTaskId })
									}>
									{t("chat:subtasks.goToSubtask")}
									<ArrowRight className="size-3" />
								</button>
							)}
						</div>
					</div>
				</>
			)
		}
		case "finishTask":
			return (
				<>
					<div style={headerStyle}>
						{toolIcon("check-all")}
						<span style={{ fontWeight: "bold" }}>{t("chat:subtasks.wantsToFinish")}</span>
					</div>
					<div className="text-muted-foreground pl-6">
						<MarkdownBlock markdown={t("chat:subtasks.completionInstructions")} />
					</div>
				</>
			)
		case "runSlashCommand": {
			const slashCommandInfo = tool
			return (
				<>
					<div style={headerStyle}>
						{toolIcon("play")}
						<span style={{ fontWeight: "bold" }}>
							{message.type === "ask"
								? t("chat:slashCommand.wantsToRun")
								: t("chat:slashCommand.didRun")}
						</span>
					</div>
					<div
						style={{
							marginTop: "4px",
							backgroundColor: "var(--vscode-editor-background)",
							border: "1px solid var(--vscode-editorGroup-border)",
							borderRadius: "4px",
							overflow: "hidden",
							cursor: "pointer",
						}}
						onClick={onToggleExpand}>
						<ToolUseBlockHeader
							className="group"
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								padding: "10px 12px",
							}}>
							<div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
								<span style={{ fontWeight: "500", fontSize: "var(--vscode-font-size)" }}>
									/{slashCommandInfo.command}
								</span>
								{slashCommandInfo.source && (
									<VSCodeBadge style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
										{slashCommandInfo.source}
									</VSCodeBadge>
								)}
							</div>
							<span
								className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} opacity-0 group-hover:opacity-100 transition-opacity duration-200`}></span>
						</ToolUseBlockHeader>
						{isExpanded && (slashCommandInfo.args || slashCommandInfo.description) && (
							<div
								style={{
									padding: "12px 16px",
									borderTop: "1px solid var(--vscode-editorGroup-border)",
									display: "flex",
									flexDirection: "column",
									gap: "8px",
								}}>
								{slashCommandInfo.args && (
									<div>
										<span style={{ fontWeight: "500" }}>Arguments: </span>
										<span style={{ color: "var(--vscode-descriptionForeground)" }}>
											{slashCommandInfo.args}
										</span>
									</div>
								)}
								{slashCommandInfo.description && (
									<div style={{ color: "var(--vscode-descriptionForeground)" }}>
										{slashCommandInfo.description}
									</div>
								)}
							</div>
						)}
					</div>
				</>
			)
		}
		case "generateImage":
			return (
				<>
					<div style={headerStyle}>
						{tool.isProtected ? (
							<span
								className="codicon codicon-lock"
								style={{ color: "var(--vscode-editorWarning-foreground)", marginBottom: "-1.5px" }}
							/>
						) : (
							toolIcon("file-media")
						)}
						<span style={{ fontWeight: "bold" }}>
							{message.type === "ask"
								? tool.isProtected
									? t("chat:fileOperations.wantsToGenerateImageProtected")
									: tool.isOutsideWorkspace
										? t("chat:fileOperations.wantsToGenerateImageOutsideWorkspace")
										: t("chat:fileOperations.wantsToGenerateImage")
								: t("chat:fileOperations.didGenerateImage")}
						</span>
					</div>
					{message.type === "ask" && (
						<div className="pl-6">
							<ToolUseBlock>
								<div className="p-2">
									<div className="mb-2 break-words">{tool.content}</div>
									<div className="flex items-center gap-1 text-xs text-vscode-descriptionForeground">
										{tool.path}
									</div>
								</div>
							</ToolUseBlock>
						</div>
					)}
				</>
			)
		default:
			return null
	}
}
