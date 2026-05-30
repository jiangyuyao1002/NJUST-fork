import { memo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Scissors, AlertTriangle } from "lucide-react"

import type { ContextTruncation } from "@njust-ai/types"

interface TruncationResultRowProps {
	data: ContextTruncation
}

/**
 * Displays the result of a sliding window truncation operation.
 * Shows information about how many messages were removed and the
 * token count before and after truncation.
 *
 * For circuit_breaker truncations (triggered after repeated condensation failures),
 * shows a more prominent warning with recovery suggestions.
 */
export const TruncationResultRow = memo(({ data }: TruncationResultRowProps) => {
	const { t } = useTranslation()
	const [isExpanded, setIsExpanded] = useState(false)

	const { messagesRemoved, prevContextTokens, newContextTokens, reason } = data

	// Handle null/undefined values to prevent crashes
	const removedCount = messagesRemoved ?? 0
	const prevTokens = prevContextTokens ?? 0
	const newTokens = newContextTokens ?? 0
	const isCircuitBreaker = reason === "circuit_breaker"

	if (isCircuitBreaker) {
		return (
			<div className="mb-2">
				<div
					role="button"
					tabIndex={0}
					className="flex items-center gap-2 cursor-pointer select-none"
					onClick={() => setIsExpanded(!isExpanded)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault()
							setIsExpanded(!isExpanded)
						}
					}}>
					<AlertTriangle size={16} className="text-vscode-editorWarning-foreground shrink-0" aria-hidden="true" />
					<span className="font-bold text-vscode-editorWarning-foreground">
						{t("chat:contextManagement.circuitBreaker.title")}
					</span>
					<span className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} ml-auto`} aria-hidden="true"></span>
				</div>

				{isExpanded && (
					<div className="mt-2 ml-0 p-4 bg-vscode-editor-background rounded text-sm border-l-2 border-vscode-editorWarning-foreground/40">
						<div className="flex flex-col gap-2">
							<p className="text-vscode-foreground">
								{t("chat:contextManagement.circuitBreaker.description")}
							</p>
							<div className="flex items-center gap-2 text-vscode-descriptionForeground text-xs">
								<Scissors size={12} aria-hidden="true" />
								<span>
									{t("contextManagement.truncation.messagesRemoved", { count: removedCount })} ·{" "}
									{prevTokens.toLocaleString()} → {newTokens.toLocaleString()}{" "}
									{t("chat:contextManagement.tokens")}
								</span>
							</div>
							<p className="text-vscode-descriptionForeground text-xs">
								{t("chat:contextManagement.circuitBreaker.suggestion")}
							</p>
						</div>
					</div>
				)}
			</div>
		)
	}

	return (
		<div className="mb-2">
			<div
				role="button"
				tabIndex={0}
				className="flex items-center justify-between cursor-pointer select-none group"
				onClick={() => setIsExpanded(!isExpanded)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault()
						setIsExpanded(!isExpanded)
					}
				}}>
				<div className="flex items-center gap-2 flex-grow">
					<Scissors size={16} className="text-vscode-descriptionForeground shrink-0" aria-hidden="true" />
					<span className="font-bold text-vscode-foreground">
						{t("chat:contextManagement.truncation.title")}
					</span>
					<span className="text-vscode-descriptionForeground text-xs font-medium">
						{t("chat:contextManagement.truncation.subtitle")}
					</span>
					<span className="text-vscode-descriptionForeground text-sm">
						{prevTokens.toLocaleString()} → {newTokens.toLocaleString()}{" "}
						{t("chat:contextManagement.tokens")}
					</span>
				</div>
				<span className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} opacity-0 group-hover:opacity-100 transition-opacity`} aria-hidden="true"></span>
			</div>

			{isExpanded && (
				<div className="mt-2 ml-0 p-4 bg-vscode-editor-background rounded text-vscode-foreground text-sm">
					<div className="flex flex-col gap-2">
						<div className="flex items-center gap-2">
							<span className="text-vscode-descriptionForeground">
								{t("chat:contextManagement.truncation.messagesRemoved", { count: removedCount })}
							</span>
						</div>
						<p className="text-vscode-descriptionForeground text-xs">
							{t("chat:contextManagement.truncation.description")}
						</p>
						<p className="text-vscode-descriptionForeground text-xs italic">
							{t("chat:contextManagement.truncation.suggestion")}
						</p>
					</div>
				</div>
			)}
		</div>
	)
})
