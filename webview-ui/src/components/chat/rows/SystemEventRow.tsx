import React from "react"
import { useTranslation } from "react-i18next"

import type { ClineMessage } from "@njust-ai-cj/types"
import { safeJsonParse } from "@roo/core"

import ErrorRow from "../ErrorRow"
import WarningRow from "../WarningRow"
import { ReasoningBlock } from "../ReasoningBlock"
import { CheckpointSaved } from "../checkpoints/CheckpointSaved"
import { CommandExecutionError } from "../CommandExecutionError"
import UpdateTodoListToolBlock from "../UpdateTodoListToolBlock"
import ImageBlock from "../../common/ImageBlock"
import { AutoApprovedRequestLimitWarning } from "../AutoApprovedRequestLimitWarning"
import { InProgressRow, CondensationResultRow, CondensationErrorRow, TruncationResultRow } from "../context-management"
import { CommandExecution } from "../CommandExecution"
import { Markdown } from "../Markdown"

import { headerStyle } from "./constants"

interface SystemEventRowProps {
	message: ClineMessage
	icon: React.ReactNode
	title: React.ReactNode
	isExpanded: boolean
	onToggleExpand: () => void
	isStreaming: boolean
	isLast: boolean
	currentCheckpoint?: string
	clineMessages: ClineMessage[]
}

export const SystemEventRow = ({
	message,
	icon,
	title,
	isExpanded,
	onToggleExpand,
	isStreaming,
	isLast,
	currentCheckpoint,
	clineMessages,
}: SystemEventRowProps) => {
	const { t } = useTranslation()

	const type = message.type === "ask" ? message.ask : message.say

	// Say cases
	if (message.type === "say") {
		switch (message.say) {
			case "diff_error":
				return (
					<ErrorRow
						type="diff_error"
						message={message.text || ""}
						expandable={true}
						showCopyButton={true}
					/>
				)
			case "reasoning":
				return (
					<ReasoningBlock
						content={message.text || ""}
						ts={message.ts}
						isStreaming={isStreaming}
						isLast={isLast}
					/>
				)
			case "api_req_finished":
				return null
			case "error": {
				const isNoToolsUsedError = message.text === "MODEL_NO_TOOLS_USED"
				const isNoAssistantMessagesError = message.text === "MODEL_NO_ASSISTANT_MESSAGES"

				if (isNoToolsUsedError) {
					return (
						<ErrorRow
							type="error"
							title={t("chat:modelResponseIncomplete")}
							message={t("chat:modelResponseErrors.noToolsUsed")}
							errorDetails={t("chat:modelResponseErrors.noToolsUsedDetails")}
						/>
					)
				}

				if (isNoAssistantMessagesError) {
					return (
						<ErrorRow
							type="error"
							title={t("chat:modelResponseIncomplete")}
							message={t("chat:modelResponseErrors.noAssistantMessages")}
							errorDetails={t("chat:modelResponseErrors.noAssistantMessagesDetails")}
						/>
					)
				}

				return (
					<ErrorRow type="error" message={message.text || t("chat:error")} errorDetails={message.text} />
				)
			}
			case "shell_integration_warning":
				return <CommandExecutionError />
			case "checkpoint_saved":
				return (
					<CheckpointSaved
						ts={message.ts!}
						commitHash={message.text!}
						currentHash={currentCheckpoint}
						checkpoint={message.checkpoint}
					/>
				)
			case "condense_context":
				if (message.partial) {
					return <InProgressRow eventType="condense_context" />
				}
				if (message.contextCondense) {
					return <CondensationResultRow data={message.contextCondense} />
				}
				return null
			case "condense_context_error":
				return <CondensationErrorRow errorText={message.text} />
			case "sliding_window_truncation":
				if (message.partial) {
					return <InProgressRow eventType="sliding_window_truncation" />
				}
				if (message.contextTruncation) {
					return <TruncationResultRow data={message.contextTruncation} />
				}
				return null
			case "user_edit_todos":
				return <UpdateTodoListToolBlock userEdited onChange={() => {}} />
			case "image": {
				const imageInfo = safeJsonParse<{ imageUri: string; imagePath: string }>(message.text || "{}")
				if (!imageInfo) {
					return null
				}
				return (
					<div style={{ marginTop: "10px" }}>
						<ImageBlock imageUri={imageInfo.imageUri} imagePath={imageInfo.imagePath} />
					</div>
				)
			}
			case "too_many_tools_warning": {
				const warningData = safeJsonParse<{
					toolCount: number
					serverCount: number
					threshold: number
				}>(message.text || "{}")
				if (!warningData) return null
				const toolsPart = t("chat:tooManyTools.toolsPart", { count: warningData.toolCount })
				const serversPart = t("chat:tooManyTools.serversPart", { count: warningData.serverCount })
				return (
					<WarningRow
						title={t("chat:tooManyTools.title")}
						message={t("chat:tooManyTools.messageTemplate", {
							tools: toolsPart,
							servers: serversPart,
							threshold: warningData.threshold,
						})}
						actionText={t("chat:tooManyTools.openMcpSettings")}
						onAction={() =>
							window.postMessage(
								{ type: "action", action: "settingsButtonClicked", values: { section: "mcp" } },
								"*",
							)
						}
					/>
				)
			}
			default:
				return (
					<>
						{title && (
							<div style={headerStyle}>
								{icon}
								{title}
							</div>
						)}
						<div style={{ paddingTop: 10 }}>
							<Markdown markdown={message.text} partial={message.partial} />
						</div>
					</>
				)
		}
	}

	// Ask cases
	if (message.type === "ask") {
		switch (message.ask) {
			case "mistake_limit_reached":
				return <ErrorRow type="mistake_limit" message={message.text || ""} errorDetails={message.text} />
			case "command":
				return (
					<CommandExecution
						executionId={message.ts.toString()}
						text={message.text}
						icon={icon as React.ReactElement | null}
						title={title as React.ReactElement | null}
					/>
				)
			case "auto_approval_max_req_reached": {
				return <AutoApprovedRequestLimitWarning message={message} />
			}
			default:
				return null
		}
	}

	return null
}
