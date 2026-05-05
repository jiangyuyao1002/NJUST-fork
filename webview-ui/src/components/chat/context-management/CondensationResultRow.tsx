import { memo, useState } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeBadge } from "@vscode/webview-ui-toolkit/react"
import { Sparkles } from "lucide-react"

import type { ContextCondense } from "@njust-ai-cj/types"

import { Markdown } from "../Markdown"

interface CondensationResultRowProps {
	data: ContextCondense
}

/**
 * Displays the result of a successful context condensation operation.
 * Shows token reduction, cost, and an expandable summary section.
 * Uses green/success styling to indicate high-quality compression.
 */
export const CondensationResultRow = memo(({ data }: CondensationResultRowProps) => {
	const { t } = useTranslation()
	const [isExpanded, setIsExpanded] = useState(false)

	const { cost, prevContextTokens, newContextTokens, summary } = data

	// Handle null/undefined token values to prevent crashes
	const prevTokens = prevContextTokens ?? 0
	const newTokens = newContextTokens ?? 0
	const displayCost = cost ?? 0

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
					<Sparkles size={16} className="text-vscode-charts-green shrink-0" aria-hidden="true" />
					<span className="font-bold text-vscode-foreground">
						{t("chat:contextManagement.condensation.title")}
					</span>
					<span className="text-vscode-charts-green text-xs font-medium">
						{t("chat:contextManagement.condensation.subtitle")}
					</span>
					<span className="text-vscode-descriptionForeground text-sm">
						{prevTokens.toLocaleString()} → {newTokens.toLocaleString()}{" "}
						{t("chat:contextManagement.tokens")}
					</span>
					<VSCodeBadge className={displayCost > 0 ? "opacity-100" : "opacity-0"}>
						${displayCost.toFixed(2)}
					</VSCodeBadge>
				</div>
				<span className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} opacity-0 group-hover:opacity-100 transition-opacity`} aria-hidden="true"></span>
			</div>

			{isExpanded && (
				<div className="mt-2 ml-0 p-4 bg-vscode-editor-background rounded text-vscode-foreground text-sm border-l-2 border-vscode-charts-green/40">
					<Markdown markdown={summary} />
				</div>
			)}
		</div>
	)
})
