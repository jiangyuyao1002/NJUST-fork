import { memo, useMemo } from "react"
import { useTranslation } from "react-i18next"

import { formatLargeNumber } from "@/utils/format"
import { calculateTokenDistribution } from "@/utils/model-utils"
import { StandardTooltip } from "@/components/ui"

interface ContextWindowProgressProps {
	contextWindow: number
	contextTokens: number
	maxTokens?: number
	autoCompactPercent?: number
}

export const ContextWindowProgress = memo(
	({ contextWindow, contextTokens, maxTokens, autoCompactPercent }: ContextWindowProgressProps) => {
		const { t } = useTranslation()

		// Use the shared utility function to calculate all token distribution values
		const tokenDistribution = useMemo(
			() => calculateTokenDistribution(contextWindow, contextTokens, maxTokens),
			[contextWindow, contextTokens, maxTokens],
		)

		// Destructure the values we need
		const { currentPercent, reservedPercent, availableSize, reservedForOutput, availablePercent } =
			tokenDistribution

		// For display purposes
		const safeContextWindow = Math.max(0, contextWindow)
		const safeContextTokens = Math.max(0, contextTokens)

		// Determine warning level for color coding
		// Uses the actual usage percentage (currentPercent) to determine color
		const warningLevel = useMemo(() => {
			if (currentPercent >= 85) return "critical" as const
			if (currentPercent >= 70) return "warning" as const
			return "normal" as const
		}, [currentPercent])

		// Bar color based on warning level
		const barColor =
			warningLevel === "critical"
				? "var(--vscode-charts-red)"
				: warningLevel === "warning"
					? "var(--vscode-charts-yellow)"
					: "var(--vscode-foreground)"

		// Combine all tooltip content into a single tooltip
		const tooltipContent = (
			<div className="space-y-1">
				<div>
					{t("chat:tokenProgress.tokensUsed", {
						used: formatLargeNumber(safeContextTokens),
						total: formatLargeNumber(safeContextWindow),
					})}
				</div>
				{reservedForOutput > 0 && (
					<div>
						{t("chat:tokenProgress.reservedForResponse", {
							amount: formatLargeNumber(reservedForOutput),
						})}
					</div>
				)}
				{availableSize > 0 && (
					<div>
						{t("chat:tokenProgress.availableSpace", {
							amount: formatLargeNumber(availableSize),
						})}
					</div>
				)}
				{warningLevel !== "normal" && (
					<div
						className={
							warningLevel === "critical"
								? "text-vscode-charts-red pt-1 font-medium"
								: "text-vscode-charts-yellow pt-1 font-medium"
						}>
						{warningLevel === "critical"
							? t("chat:tokenProgress.criticalWarning", {
									defaultValue: "Context nearly full — compaction imminent",
								})
							: t("chat:tokenProgress.warning", {
									defaultValue: "Context running high — compaction may trigger soon",
								})}
					</div>
				)}
			</div>
		)

		return (
			<>
				<div className="flex items-center gap-2 flex-1 whitespace-nowrap">
					<div
						data-testid="context-tokens-count"
						className={
							warningLevel === "critical"
								? "text-vscode-charts-red"
								: warningLevel === "warning"
									? "text-vscode-charts-yellow"
									: undefined
						}>
						{formatLargeNumber(safeContextTokens)}
					</div>
					{autoCompactPercent !== undefined && currentPercent >= Math.max(autoCompactPercent - 10, 50) && (
						<div
							className="text-[10px] px-1 rounded whitespace-nowrap opacity-70"
							style={{ backgroundColor: "color-mix(in srgb, var(--vscode-foreground) 15%, transparent)" }}
							title={`Auto-compact triggers at ${autoCompactPercent}% context usage`}>
							≃{autoCompactPercent}%
						</div>
					)}
					<StandardTooltip content={tooltipContent} side="top" sideOffset={8}>
						<div className="flex-1 relative">
							{/* Main progress bar container */}
							<div
								className="flex items-center h-1 rounded-[2px] overflow-hidden w-full bg-[color-mix(in_srgb,var(--vscode-foreground)_20%,transparent)]"
								role="progressbar"
								aria-valuenow={Math.round(currentPercent)}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-label="Context window usage">
								{/* Current tokens container */}
								<div
									className="relative h-full"
									style={{ width: `${currentPercent}%` }}
									data-testid="context-tokens-used">
									{/* Current tokens used - colored by warning level */}
									<div
										className="h-full w-full transition-[background-color,width] duration-300 ease-out"
										style={{ backgroundColor: barColor }}
									/>
								</div>

								{/* Container for reserved tokens */}
								<div
									className="relative h-full"
									style={{ width: `${reservedPercent}%` }}
									data-testid="context-reserved-tokens">
									{/* Reserved for output section - medium gray */}
									<div className="h-full w-full bg-[color-mix(in_srgb,var(--vscode-foreground)_30%,transparent)] transition-width duration-300 ease-out" />
								</div>

								{/* Empty section (if any) */}
								{availablePercent > 0 && (
									<div
										className="relative h-full"
										style={{ width: `${availablePercent}%` }}
										data-testid="context-available-space-section">
										{/* Available space - transparent */}
									</div>
								)}
							</div>
						</div>
					</StandardTooltip>
					<div data-testid="context-window-size">{formatLargeNumber(safeContextWindow)}</div>
				</div>
			</>
		)
	},
)
