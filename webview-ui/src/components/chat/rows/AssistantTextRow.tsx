import React from "react"
import { useTranslation } from "react-i18next"

import type { ClineMessage } from "@njust-ai/types"

import { Markdown } from "../Markdown"
import ImageBlock from "../../common/ImageBlock"
import { OpenMarkdownPreviewButton } from "../OpenMarkdownPreviewButton"
import {
	CloudAgentAssistantMessage,
	CloudAgentDeferredToolCard,
	getCloudAgentAssistantRunSlot,
	isCloudAgentAssistantTextMessage,
	parseDeferredExecutingTool,
	parseDeferredToolError,
} from "../cloud-agent/CloudAgentChatBlocks"

import { MessageCircle } from "lucide-react"

import { headerStyle } from "./constants"

interface AssistantTextRowProps {
	message: ClineMessage
	isCloudAgentUi: boolean
	clineMessages: ClineMessage[]
	cloudAgentTextMessages: ClineMessage[]
}

export const AssistantTextRow = ({
	message,
	isCloudAgentUi,
	clineMessages,
	cloudAgentTextMessages,
}: AssistantTextRowProps) => {
	const { t } = useTranslation()

	const deferredTool = parseDeferredExecutingTool(message.text)
	const deferredErr = deferredTool ? null : parseDeferredToolError(message.text)

	if (isCloudAgentUi && deferredTool) {
		return <CloudAgentDeferredToolCard tool={deferredTool.tool} callId={deferredTool.callId} />
	}
	if (isCloudAgentUi && deferredErr) {
		return (
			<CloudAgentDeferredToolCard
				variant="error"
				tool={deferredErr.tool}
				errorBody={deferredErr.message}
			/>
		)
	}
	if (isCloudAgentUi) {
		const msgIdx = clineMessages.findIndex((m) => m.ts === message.ts)
		const prevMsg = msgIdx > 0 ? clineMessages[msgIdx - 1] : undefined
		const caShowRunHeader = !isCloudAgentAssistantTextMessage(prevMsg)
		const runSlot = getCloudAgentAssistantRunSlot(clineMessages, message.ts)
		return (
			<CloudAgentAssistantMessage
				markdown={message.text}
				partial={message.partial}
				images={message.images}
				showRunHeader={caShowRunHeader}
				totalSteps={cloudAgentTextMessages.length}
				runSlot={runSlot}
			/>
		)
	}

	return (
		<div className="group">
			<div style={headerStyle}>
				<MessageCircle className="w-4 shrink-0" aria-label="Speech bubble icon" />
				<span style={{ fontWeight: "bold" }}>{t("chat:text.rooSaid")}</span>
				<div style={{ flexGrow: 1 }} />
				<OpenMarkdownPreviewButton markdown={message.text} />
			</div>
			<div className="pl-6">
				<Markdown markdown={message.text} partial={message.partial} />
				{message.images && message.images.length > 0 && (
					<div style={{ marginTop: "10px" }}>
						{message.images.map((image, index) => (
							<ImageBlock key={index} imageData={image} />
						))}
					</div>
				)}
			</div>
		</div>
	)
}
