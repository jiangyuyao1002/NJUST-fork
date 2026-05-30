import React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

import type { ClineMessage } from "@njust-ai/types"

import { Markdown } from "../Markdown"
import { OpenMarkdownPreviewButton } from "../OpenMarkdownPreviewButton"
import { isCloudAgentAssistantTextMessage } from "../cloud-agent/CloudAgentChatBlocks"

import { CheckCircle2 } from "lucide-react"

import { headerStyle, successColor } from "./constants"

interface CompletionResultRowProps {
	message: ClineMessage
	icon: React.ReactNode
	title: React.ReactNode
	isCloudAgentUi: boolean
	clineMessages: ClineMessage[]
}

export const CompletionResultRow = ({
	message,
	icon,
	title,
	isCloudAgentUi,
	clineMessages,
}: CompletionResultRowProps) => {
	const { t } = useTranslation()

	if (message.type === "ask") {
		if (message.text) {
			return (
				<div className="group">
					<div style={headerStyle}>
						{icon}
						{title}
						<div style={{ flexGrow: 1 }} />
						<OpenMarkdownPreviewButton markdown={message.text} />
					</div>
					<div style={{ color: successColor, paddingTop: 10 }}>
						<Markdown markdown={message.text} partial={message.partial} />
					</div>
				</div>
			)
		} else {
			return null
		}
	}

	const crIdx = clineMessages.findIndex((m) => m.ts === message.ts)
	const crPrev = crIdx > 0 ? clineMessages[crIdx - 1] : undefined
	const completionAttached = isCloudAgentAssistantTextMessage(crPrev)
	return isCloudAgentUi ? (
		<div
			className={cn(
				"ca-final-output",
				completionAttached && "ca-final-output--run-completion",
			)}>
			<div className="ca-final-output-done">
				<div className="ca-final-output-done__mark" aria-hidden>
					<CheckCircle2 className="ca-final-output-done__check" strokeWidth={2} />
				</div>
				<span className="ca-final-output-done__label">{t("chat:taskCompleted")}</span>
				<div className="flex-grow min-w-0" />
				<OpenMarkdownPreviewButton markdown={message.text} />
			</div>
			{message.text?.trim() ? (
				<div className="ca-final-output-done__body">
					<Markdown markdown={message.text} />
				</div>
			) : null}
		</div>
	) : (
		<div className="group">
			<div style={headerStyle}>
				{icon}
				{title}
				<div style={{ flexGrow: 1 }} />
				<OpenMarkdownPreviewButton markdown={message.text} />
			</div>
			<div className="border-l border-green-600/30 ml-2 pl-4 pb-1">
				<Markdown markdown={message.text} />
			</div>
		</div>
	)
}
