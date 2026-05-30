import React from "react"

import type { ClineMessage, FollowUpData, SuggestionItem } from "@njust-ai/types"

import { Markdown } from "../Markdown"
import { FollowUpSuggest } from "../FollowUpSuggest"

import { headerStyle } from "./constants"

interface FollowUpRowProps {
	message: ClineMessage
	icon: React.ReactNode
	title: React.ReactNode
	followUpData: FollowUpData | null
	onSuggestionClick?: (suggestion: SuggestionItem, event?: React.MouseEvent) => void
	onFollowUpUnmount?: () => void
	isFollowUpAnswered?: boolean
	isFollowUpAutoApprovalPaused?: boolean
}

export const FollowUpRow = ({
	message,
	icon,
	title,
	followUpData,
	onSuggestionClick,
	onFollowUpUnmount,
	isFollowUpAnswered,
	isFollowUpAutoApprovalPaused,
}: FollowUpRowProps) => {
	return (
		<>
			{title && (
				<div style={headerStyle}>
					{icon}
					{title}
				</div>
			)}
			<div className="flex flex-col gap-2 ml-6">
				<Markdown
					markdown={message.partial === true ? message?.text : followUpData?.question}
				/>
				<FollowUpSuggest
					suggestions={followUpData?.suggest}
					onSuggestionClick={onSuggestionClick}
					ts={message?.ts}
					onCancelAutoApproval={onFollowUpUnmount}
					isAnswered={isFollowUpAnswered}
					isFollowUpAutoApprovalPaused={isFollowUpAutoApprovalPaused}
				/>
			</div>
		</>
	)
}
