import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSize } from "react-use"
import { useTranslation } from "react-i18next"
import deepEqual from "fast-deep-equal"

import type {
	ClineMessage,
	FollowUpData,
	SuggestionItem,
	ClineApiReqInfo,
	ClineAskUseMcpServer,
	ClineSayTool,
} from "@njust-ai-cj/types"

import { Mode } from "@roo/modes"

import { COMMAND_OUTPUT_STRING } from "@roo/combineCommandSequences"
import { safeJsonParse } from "@roo/core"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { appendImages } from "@src/utils/imageUtils"
import { convertToMentionPath } from "@src/utils/path-mentions"

import { MAX_IMAGES_PER_MESSAGE } from "./ChatView"
import { useSelectedModel } from "../ui/hooks/useSelectedModel"
import {
	MessageCircleQuestionMark,
	TerminalSquare,
	MessageCircle,
	Check,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
	CloudAgentDeferredToolCard,
	isCloudAgentAssistantTextMessage,
	parseDeferredExecutingTool,
	parseDeferredToolError,
} from "./cloud-agent/CloudAgentChatBlocks"
import { ProgressIndicator } from "./ProgressIndicator"

import { ToolRow } from "./rows/ToolRow"
import { UserFeedbackRow } from "./rows/UserFeedbackRow"
import { AssistantTextRow } from "./rows/AssistantTextRow"
import { ApiRequestRow } from "./rows/ApiRequestRow"
import { CompletionResultRow } from "./rows/CompletionResultRow"
import { FollowUpRow } from "./rows/FollowUpRow"
import { McpServerRow } from "./rows/McpServerRow"
import { SayToolResultRow } from "./rows/SayToolResultRow"
import { SystemEventRow } from "./rows/SystemEventRow"
import { headerStyle, normalColor, errorColor, successColor, cancelledColor } from "./rows/constants"

interface ChatRowProps {
	message: ClineMessage
	lastModifiedMessage?: ClineMessage
	isExpanded: boolean
	isLast: boolean
	isStreaming: boolean
	onToggleExpand: (ts: number) => void
	onHeightChange: (isTaller: boolean) => void
	onSuggestionClick?: (suggestion: SuggestionItem, event?: React.MouseEvent) => void
	onBatchFileResponse?: (response: { [key: string]: boolean }) => void
	onFollowUpUnmount?: () => void
	isFollowUpAnswered?: boolean
	isFollowUpAutoApprovalPaused?: boolean
	editable?: boolean
	hasCheckpoint?: boolean
}

interface ChatRowContentProps extends Omit<ChatRowProps, "onHeightChange"> {}

const ChatRow = memo(
	(props: ChatRowProps) => {
		const { isLast, onHeightChange, message } = props
		const { mode, clineMessages } = useExtensionState()
		const isCloudAgentThread = mode === "cloud-agent"
		const msgIdx = clineMessages.findIndex((m) => m.ts === message.ts)
		const prevMsgForShell = msgIdx > 0 ? clineMessages[msgIdx - 1] : undefined
		const nextMsgForShell =
			msgIdx >= 0 && msgIdx < clineMessages.length - 1 ? clineMessages[msgIdx + 1] : undefined
		const isTightCloudTop =
			isCloudAgentThread &&
			((message.type === "say" &&
				message.say === "text" &&
				isCloudAgentAssistantTextMessage(message) &&
				isCloudAgentAssistantTextMessage(prevMsgForShell)) ||
				(message.type === "say" &&
					message.say === "completion_result" &&
					isCloudAgentAssistantTextMessage(prevMsgForShell)))
		const isTightCloudBottom =
			isCloudAgentThread &&
			message.type === "say" &&
			message.say === "text" &&
			isCloudAgentAssistantTextMessage(message) &&
			nextMsgForShell &&
			((nextMsgForShell.type === "say" &&
				nextMsgForShell.say === "text" &&
				isCloudAgentAssistantTextMessage(nextMsgForShell)) ||
				(nextMsgForShell.type === "say" && nextMsgForShell.say === "completion_result"))
		const prevHeightRef = useRef(0)

		const [chatrow, { height }] = useSize(
			<div
				className={cn(
					isCloudAgentThread
						? cn(
								"px-4",
								isTightCloudTop ? "pt-0" : "pt-2",
								isTightCloudBottom ? "pb-0" : "pb-2",
							)
						: "px-[15px] py-[10px] pr-[6px]",
					!isCloudAgentThread && "chat-row-shell",
				)}>
				<ChatRowContent {...props} />
			</div>,
		)

		useEffect(() => {
			const isHeightValid = height !== 0 && height !== Infinity
			const isInitialRender = prevHeightRef.current === 0
			if (isLast && isHeightValid && height !== prevHeightRef.current) {
				if (!isInitialRender) {
					onHeightChange(height > prevHeightRef.current)
				}
				prevHeightRef.current = height
			}
		}, [height, isLast, onHeightChange, message])

		return chatrow
	},
	deepEqual,
)

export default ChatRow

export const ChatRowContent = ({
	message,
	lastModifiedMessage,
	isExpanded,
	isLast,
	isStreaming,
	onToggleExpand,
	onSuggestionClick,
	onFollowUpUnmount,
	onBatchFileResponse,
	isFollowUpAnswered,
	isFollowUpAutoApprovalPaused,
}: ChatRowContentProps) => {
	const { t } = useTranslation()

	const {
		mcpServers,
		alwaysAllowMcp,
		currentCheckpoint,
		mode,
		apiConfiguration,
		clineMessages,
		currentTaskItem,
		cwd = "",
	} = useExtensionState()
	const isCloudAgentUi = mode === "cloud-agent"
	const { info: model } = useSelectedModel(apiConfiguration)
	const [isEditing, setIsEditing] = useState(false)
	const [editedContent, setEditedContent] = useState("")
	const [editMode, setEditMode] = useState<Mode>(mode || "code")
	const [editImages, setEditImages] = useState<string[]>([])

	const cloudAgentTextMessages = useMemo(
		() => clineMessages.filter((m) => isCloudAgentAssistantTextMessage(m)),
		[clineMessages],
	)

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const msg = event.data
			if (!isEditing || msg.messageTs !== message.ts || msg.context !== "edit") {
				return
			}
			if (msg.type === "selectedImages") {
				setEditImages((prevImages) => appendImages(prevImages, msg.images, MAX_IMAGES_PER_MESSAGE))
			}
			if (msg.type === "selectedContextFiles") {
				if (msg.contextFilePaths?.length) {
					setEditedContent((current) => {
						const mentions = msg.contextFilePaths.map((p: string) => convertToMentionPath(p, cwd)).join(" ")
						if (!mentions) {
							return current
						}
						const needsSep = current.length > 0 && !/\s$/.test(current)
						return `${current}${needsSep ? " " : ""}${mentions} `
					})
				}
				if (msg.images?.length) {
					setEditImages((prevImages) => appendImages(prevImages, msg.images, MAX_IMAGES_PER_MESSAGE))
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [isEditing, message.ts, cwd])

	const handleToggleExpand = useCallback(() => {
		onToggleExpand(message.ts)
	}, [onToggleExpand, message.ts])

	const handleEditClick = useCallback(() => {
		setIsEditing(true)
		setEditedContent(message.text || "")
		setEditImages(message.images || [])
		setEditMode(mode || "code")
	}, [message.text, message.images, mode])

	const handleCancelEdit = useCallback(() => {
		setIsEditing(false)
		setEditedContent(message.text || "")
		setEditImages(message.images || [])
		setEditMode(mode || "code")
	}, [message.text, message.images, mode])

	const handleSaveEdit = useCallback(() => {
		setIsEditing(false)
		vscode.postMessage({
			type: "submitEditedMessage",
			value: message.ts,
			editedMessageContent: editedContent,
			images: editImages,
		})
	}, [message.ts, editedContent, editImages])

	const handleSelectContextFiles = useCallback(() => {
		vscode.postMessage({ type: "selectContextFiles", context: "edit", messageTs: message.ts })
	}, [message.ts])

	const [cost, apiReqCancelReason, apiReqStreamingFailedMessage] = useMemo(() => {
		if (message.text !== null && message.text !== undefined && message.say === "api_req_started") {
			const info = safeJsonParse<ClineApiReqInfo>(message.text)
			return [info?.cost, info?.cancelReason, info?.streamingFailedMessage]
		}

		return [undefined, undefined, undefined]
	}, [message.text, message.say])

	const apiRequestFailedMessage =
		isLast && lastModifiedMessage?.ask === "api_req_failed"
			? lastModifiedMessage?.text
			: undefined

	const isCommandExecuting =
		isLast && lastModifiedMessage?.ask === "command" && lastModifiedMessage?.text?.includes(COMMAND_OUTPUT_STRING)

	const isMcpServerResponding = isLast && lastModifiedMessage?.say === "mcp_server_request_started"

	const type = message.type === "ask" ? message.ask : message.say

	const [icon, title] = useMemo(() => {
		switch (type) {
			case "error":
			case "mistake_limit_reached":
				return [null, null]
			case "command":
				return [
					isCommandExecuting ? (
						<ProgressIndicator />
					) : (
						<TerminalSquare className="size-4" aria-label="Terminal icon" />
					),
					<span style={{ color: normalColor, fontWeight: "bold" }}>
						{t("chat:commandExecution.running")}
					</span>,
				]
			case "use_mcp_server":
				const mcpServerUse = safeJsonParse<ClineAskUseMcpServer>(message.text)
				if (mcpServerUse === undefined) {
					return [null, null]
				}
				return [
					isMcpServerResponding ? (
						<ProgressIndicator />
					) : (
						<span
							className="codicon codicon-server"
							style={{ color: normalColor, marginBottom: "-1.5px" }}></span>
					),
					<span style={{ color: normalColor, fontWeight: "bold" }}>
						{mcpServerUse.type === "use_mcp_tool"
							? t("chat:mcp.wantsToUseTool", { serverName: mcpServerUse.serverName })
							: t("chat:mcp.wantsToAccessResource", { serverName: mcpServerUse.serverName })}
					</span>,
				]
			case "completion_result":
				return [
					<span
						className="codicon codicon-check"
						style={{ color: successColor, marginBottom: "-1.5px" }}></span>,
					<span style={{ color: successColor, fontWeight: "bold" }}>{t("chat:taskCompleted")}</span>,
				]
			case "api_req_rate_limit_wait":
				return []
			case "api_req_retry_delayed":
				return []
			case "api_req_started":
				const getIconSpan = (iconName: string, color: string) => (
					<div
						style={{
							width: 16,
							height: 16,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
						}}>
						<span
							className={`codicon codicon-${iconName}`}
							style={{ color, fontSize: 16, marginBottom: "-1.5px" }}
						/>
					</div>
				)
				return [
					apiReqCancelReason !== null && apiReqCancelReason !== undefined ? (
						apiReqCancelReason === "user_cancelled" ? (
							getIconSpan("error", cancelledColor)
						) : (
							getIconSpan("error", errorColor)
						)
					) : cost !== null && cost !== undefined ? (
						getIconSpan("arrow-swap", normalColor)
					) : apiRequestFailedMessage ? (
						getIconSpan("error", errorColor)
					) : isLast ? (
						<ProgressIndicator />
					) : (
						getIconSpan("arrow-swap", normalColor)
					),
					apiReqCancelReason !== null && apiReqCancelReason !== undefined ? (
						apiReqCancelReason === "user_cancelled" ? (
							<span style={{ color: normalColor, fontWeight: "bold" }}>
								{t("chat:apiRequest.cancelled")}
							</span>
						) : (
							<span style={{ color: errorColor, fontWeight: "bold" }}>
								{t("chat:apiRequest.streamingFailed")}
							</span>
						)
					) : cost !== null && cost !== undefined ? (
						<span style={{ color: normalColor }}>{t("chat:apiRequest.title")}</span>
					) : apiRequestFailedMessage ? (
						<span style={{ color: errorColor }}>{t("chat:apiRequest.failed")}</span>
					) : (
						<span style={{ color: normalColor }}>{t("chat:apiRequest.streaming")}</span>
					),
				]
			case "followup":
				return [
					<MessageCircleQuestionMark className="w-4 shrink-0" aria-label="Question icon" />,
					<span style={{ color: normalColor, fontWeight: "bold" }}>{t("chat:questions.hasQuestion")}</span>,
				]
			default:
				return [null, null]
		}
	}, [
		type,
		isCommandExecuting,
		message,
		isMcpServerResponding,
		apiReqCancelReason,
		cost,
		apiRequestFailedMessage,
		t,
		isLast,
	])

	const tool = useMemo(
		() => (message.ask === "tool" ? safeJsonParse<ClineSayTool>(message.text) : null),
		[message.ask, message.text],
	)

	const unifiedDiff = useMemo(() => {
		if (!tool) return undefined
		return (tool.content ?? tool.diff) as string | undefined
	}, [tool])

	const onJumpToCreatedFile = useMemo(() => {
		if (!tool || tool.tool !== "newFileCreated" || !tool.path) {
			return undefined
		}

		return () => vscode.postMessage({ type: "openFile", text: "./" + tool.path })
	}, [tool])

	const followUpData = useMemo(() => {
		if (message.type === "ask" && message.ask === "followup" && !message.partial) {
			return safeJsonParse<FollowUpData>(message.text)
		}
		return null
	}, [message.type, message.ask, message.partial, message.text])

	// === Route to sub-components ===

	// 1. Tool ask messages (the big if(tool) block)
	if (tool) {
		return (
			<ToolRow
				message={message}
				tool={tool}
				unifiedDiff={unifiedDiff}
				onJumpToCreatedFile={onJumpToCreatedFile}
				isExpanded={isExpanded}
				onToggleExpand={handleToggleExpand}
				clineMessages={clineMessages}
				currentTaskItem={currentTaskItem}
				onBatchFileResponse={onBatchFileResponse}
			/>
		)
	}

	// 2. Route by message type
	switch (message.type) {
		case "say":
			switch (message.say) {
				case "diff_error":
				case "reasoning":
				case "api_req_finished":
				case "error":
				case "shell_integration_warning":
				case "checkpoint_saved":
				case "condense_context":
				case "condense_context_error":
				case "sliding_window_truncation":
				case "user_edit_todos":
				case "image":
				case "too_many_tools_warning":
					return (
						<SystemEventRow
							message={message}
							icon={icon}
							title={title}
							isExpanded={isExpanded}
							onToggleExpand={handleToggleExpand}
							isStreaming={isStreaming}
							isLast={isLast}
							currentCheckpoint={currentCheckpoint}
							clineMessages={clineMessages}
						/>
					)

				case "subtask_result":
				case "codebase_search_result":
					return (
						<SayToolResultRow
							message={message}
							isExpanded={isExpanded}
							onToggleExpand={handleToggleExpand}
							clineMessages={clineMessages}
							currentTaskItem={currentTaskItem}
						/>
					)

				case "api_req_started":
				case "api_req_retry_delayed":
				case "api_req_rate_limit_wait":
					return (
						<ApiRequestRow
							message={message}
							icon={icon}
							title={title}
							cost={cost}
							apiReqCancelReason={apiReqCancelReason}
							apiReqStreamingFailedMessage={apiReqStreamingFailedMessage}
							apiRequestFailedMessage={apiRequestFailedMessage}
							isCloudAgentUi={isCloudAgentUi}
							isLast={isLast}
						/>
					)

				case "text":
					return (
						<AssistantTextRow
							message={message}
							isCloudAgentUi={isCloudAgentUi}
							clineMessages={clineMessages}
							cloudAgentTextMessages={cloudAgentTextMessages}
						/>
					)

				case "user_feedback":
				case "user_feedback_diff":
					return (
						<UserFeedbackRow
							message={message}
							isEditing={isEditing}
							editedContent={editedContent}
							setEditedContent={setEditedContent}
							editMode={editMode}
							setEditMode={setEditMode}
							editImages={editImages}
							setEditImages={setEditImages}
							handleEditClick={handleEditClick}
							handleCancelEdit={handleCancelEdit}
							handleSaveEdit={handleSaveEdit}
							handleSelectContextFiles={handleSelectContextFiles}
							isCloudAgentUi={isCloudAgentUi}
							isStreaming={isStreaming}
							model={model}
							onToggleExpand={handleToggleExpand}
							isExpanded={isExpanded}
						/>
					)

				case "completion_result":
					return (
						<CompletionResultRow
							message={message}
							icon={icon}
							title={title}
							isCloudAgentUi={isCloudAgentUi}
							clineMessages={clineMessages}
						/>
					)

				case "tool" as any:
					return (
						<SayToolResultRow
							message={message}
							isExpanded={isExpanded}
							onToggleExpand={handleToggleExpand}
							clineMessages={clineMessages}
							currentTaskItem={currentTaskItem}
						/>
					)

				default:
					return (
						<SystemEventRow
							message={message}
							icon={icon}
							title={title}
							isExpanded={isExpanded}
							onToggleExpand={handleToggleExpand}
							isStreaming={isStreaming}
							isLast={isLast}
							currentCheckpoint={currentCheckpoint}
							clineMessages={clineMessages}
						/>
					)
			}

		case "ask":
			switch (message.ask) {
				case "mistake_limit_reached":
				case "command":
				case "auto_approval_max_req_reached":
					return (
						<SystemEventRow
							message={message}
							icon={icon}
							title={title}
							isExpanded={isExpanded}
							onToggleExpand={handleToggleExpand}
							isStreaming={isStreaming}
							isLast={isLast}
							currentCheckpoint={currentCheckpoint}
							clineMessages={clineMessages}
						/>
					)

				case "use_mcp_server":
					return (
						<McpServerRow
							message={message}
							icon={icon}
							title={title}
							mcpServers={mcpServers}
							alwaysAllowMcp={alwaysAllowMcp ?? false}
						/>
					)

				case "completion_result":
					return (
						<CompletionResultRow
							message={message}
							icon={icon}
							title={title}
							isCloudAgentUi={isCloudAgentUi}
							clineMessages={clineMessages}
						/>
					)

				case "followup":
					return (
						<FollowUpRow
							message={message}
							icon={icon}
							title={title}
							followUpData={followUpData ?? null}
							onSuggestionClick={onSuggestionClick}
							onFollowUpUnmount={onFollowUpUnmount}
							isFollowUpAnswered={isFollowUpAnswered}
							isFollowUpAutoApprovalPaused={isFollowUpAutoApprovalPaused}
						/>
					)

				default:
					return null
			}
	}
}
