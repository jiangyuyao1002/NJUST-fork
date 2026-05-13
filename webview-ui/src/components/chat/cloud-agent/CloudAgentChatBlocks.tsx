import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { ClineMessage } from "@njust-ai-cj/types"
import { PlayCircle, Wrench, AlertCircle, Cloud, Loader2, CheckCircle2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { Markdown } from "../Markdown"
import ImageBlock from "../../common/ImageBlock"
import { OpenMarkdownPreviewButton } from "../OpenMarkdownPreviewButton"
import { getCloudAgentCardSummary, shouldCollapseCloudAgentText } from "./cloudAgentMessagePreview"
import { CloudAgentTechnicalDetailDialog } from "./CloudAgentTechnicalDetailDialog"

/** Matches `Task.ts`: `[Deferred] executing tool: ${tool} (${call_id})` */
export function parseDeferredExecutingTool(text: string | undefined): { tool: string; callId: string } | null {
	if (!text?.trim()) return null
	const m = text.trim().match(/^\[Deferred\] executing tool:\s+(\S+)\s+\(([^)]+)\)\s*$/)
	if (!m) return null
	return { tool: m[1]!, callId: m[2]! }
}

/** Matches deferred tool error lines from `Task.ts`. */
export function parseDeferredToolError(text: string | undefined): { tool: string; message: string } | null {
	if (!text?.trim()) return null
	const m = text.trim().match(/^\[Deferred\] tool (\S+) error:\s*([\s\S]*)$/)
	if (!m) return null
	return { tool: m[1]!, message: m[2]!.trim() }
}

export function isCloudAgentAssistantTextMessage(m: ClineMessage | undefined): boolean {
	if (!m || m.type !== "say" || m.say !== "text") return false
	return !parseDeferredExecutingTool(m.text ?? undefined) && !parseDeferredToolError(m.text ?? undefined)
}

export function isCloudAgentCompletionMessage(m: ClineMessage | undefined): boolean {
	return Boolean(m && m.type === "say" && m.say === "completion_result")
}

/**
 * Positions one Cloud Agent assistant text row inside a merged run card (single shell + step dividers).
 */
export type CloudAgentAssistantRunSlot =
	| "single"
	| "first"
	| "middle"
	| "last"
	| "beforeCompletion"

export function getCloudAgentAssistantRunSlot(
	clineMessages: ClineMessage[],
	messageTs: number,
): CloudAgentAssistantRunSlot {
	const idx = clineMessages.findIndex((m) => m.ts === messageTs)
	if (idx < 0) return "single"
	const prev = idx > 0 ? clineMessages[idx - 1] : undefined
	const next = idx < clineMessages.length - 1 ? clineMessages[idx + 1] : undefined
	const isFirst = !isCloudAgentAssistantTextMessage(prev)
	const nextIsAssistant = isCloudAgentAssistantTextMessage(next)
	const nextIsCompletion = isCloudAgentCompletionMessage(next)

	if (isFirst && !nextIsAssistant && !nextIsCompletion) return "single"
	if (isFirst && (nextIsAssistant || nextIsCompletion)) return "first"
	if (!nextIsAssistant && nextIsCompletion) return "beforeCompletion"
	if (!nextIsAssistant && !nextIsCompletion) return "last"
	return "middle"
}

function buildDeferredToolPlainText(tool: string, callId?: string, errorBody?: string): string {
	const lines = [`[Cloud Agent / Deferred]`, `tool: ${tool}`]
	if (callId) lines.push(`call_id: ${callId}`)
	if (errorBody) lines.push("", "error:", errorBody)
	return lines.join("\n")
}

type CloudAgentDeferredToolCardProps = {
	tool: string
	callId?: string
	variant?: "default" | "error"
	errorBody?: string
}

export function CloudAgentDeferredToolCard({
	tool,
	callId,
	variant = "default",
	errorBody,
}: CloudAgentDeferredToolCardProps) {
	const { t } = useTranslation()
	const [detailsOpen, setDetailsOpen] = useState(false)
	const isError = variant === "error"
	const hasDetails = Boolean(callId || errorBody)
	const plainDetails = buildDeferredToolPlainText(tool, callId, errorBody)

	return (
		<div className={cn("ca-tool-card", isError && "ca-tool-card--error")}>
			<div className="ca-tool-card__shell">
				<div className="ca-tool-card__gutter" aria-hidden />
				<div className="ca-tool-card__main">
					<div className="ca-tool-card__badges">
						<span className="ca-badge ca-badge--tools">
							<Wrench className="ca-badge__icon" strokeWidth={2} aria-hidden />
							{t("chat:cloudAgent.toolBadge")}
						</span>
					</div>
					<div className="ca-tool-card__accent">
						<div className="ca-tool-card__row">
							<div
								className={cn("ca-tool-pill", isError && "ca-tool-pill--error")}
								role="status"
								aria-label={
									isError ? t("chat:cloudAgent.toolError") : t("chat:cloudAgent.executingTool")
								}>
								{isError ? (
									<AlertCircle className="ca-tool-pill__icon" strokeWidth={2} aria-hidden />
								) : (
									<PlayCircle className="ca-tool-pill__icon" strokeWidth={2} aria-hidden />
								)}
								<span>{tool}</span>
							</div>
							{hasDetails && (
								<button
									type="button"
									className="ca-details-link"
									onClick={() => setDetailsOpen(true)}
									aria-expanded={detailsOpen}>
									{t("chat:cloudAgent.details")}
								</button>
							)}
						</div>
						<div className="ca-param-box">
							<span className="ca-param-key">tool</span>
							<span className="ca-param-eq"> = </span>
							<span className="ca-param-val">{tool}</span>
						</div>
					</div>
				</div>
			</div>
			{hasDetails && (
				<CloudAgentTechnicalDetailDialog
					open={detailsOpen}
					onOpenChange={setDetailsOpen}
					plainText={plainDetails}
				/>
			)}
		</div>
	)
}

type CloudAgentAssistantMessageProps = {
	markdown?: string
	partial?: boolean
	images?: string[]
	/** First row in a run of consecutive cloud assistant text messages */
	showRunHeader?: boolean
	totalSteps?: number
	runSlot?: CloudAgentAssistantRunSlot
}

export function CloudAgentAssistantMessage({
	markdown,
	partial,
	images,
	showRunHeader = true,
	totalSteps = 0,
	runSlot = "single",
}: CloudAgentAssistantMessageProps) {
	const { t } = useTranslation()
	const fullText = markdown ?? ""
	const collapse = shouldCollapseCloudAgentText(fullText, partial)
	const [detailsOpen, setDetailsOpen] = useState(false)

	const card = getCloudAgentCardSummary(fullText)
	const displayTitle = card.title || t("chat:cloudAgent.previewPlaceholder")
	const hintLine = card.hint
		? card.hint.length > 100
			? `${card.hint.slice(0, 100)}…`
			: card.hint
		: null

	const showDetailsEntry = !partial && (collapse || fullText.length > 240)

	const showConnectorBelow =
		runSlot === "first" || runSlot === "middle" || runSlot === "beforeCompletion"

	return (
		<div
			className={cn(
				"ca-final-output",
				runSlot !== "single" && `ca-final-output--run-${runSlot}`,
			)}>
			{showRunHeader ? (
				<div className="ca-final-output__header">
					<div className="ca-final-output__brand">
						<div className="ca-final-output__cloud" aria-hidden>
							<Cloud className="ca-final-output__cloud-svg" strokeWidth={2} />
						</div>
						<span className="ca-final-output__title">{t("chat:cloudAgent.headerTitle")}</span>
					</div>
					{totalSteps > 0 ? (
						<span className="ca-final-output__steps-badge">
							{t("chat:cloudAgent.stepsBadge", { count: totalSteps })}
						</span>
					) : null}
					<div className="flex-grow min-w-0" />
					<OpenMarkdownPreviewButton markdown={markdown} />
				</div>
			) : null}

			<div className="ca-final-output__step-row">
				<div className="ca-step-rail" aria-hidden>
					<div
						className={cn(
							"ca-step-rail__dot",
							partial ? "ca-step-rail__dot--pending" : "ca-step-rail__dot--done",
						)}>
						{partial ? (
							<Loader2 className="ca-step-rail__spin" strokeWidth={2} />
						) : (
							<CheckCircle2 className="ca-step-rail__check" strokeWidth={2} />
						)}
					</div>
					{showConnectorBelow ? <div className="ca-step-rail__connector" /> : null}
				</div>
				<div className="ca-step-body">
					{partial ? (
						<Markdown markdown={markdown} partial={partial} />
					) : collapse ? (
						<>
							<div className="ca-step-summary">{displayTitle}</div>
							{hintLine ? <div className="ca-step-hint">{hintLine}</div> : null}
						</>
					) : (
						<Markdown markdown={markdown} partial={false} />
					)}
				</div>
				{showDetailsEntry ? (
					<button type="button" className="ca-step-details-link" onClick={() => setDetailsOpen(true)}>
						{t("chat:cloudAgent.details")}
					</button>
				) : (
					<div className="ca-step-details-spacer" aria-hidden />
				)}
			</div>

			<CloudAgentTechnicalDetailDialog
				open={detailsOpen}
				onOpenChange={setDetailsOpen}
				plainText={fullText}
			/>

			{images && images.length > 0 ? (
				<div className="ca-final-output__images mt-2 space-y-2 pl-[30px]">
					{images.map((image, index) => (
						<ImageBlock key={index} imageData={image} />
					))}
				</div>
			) : null}
		</div>
	)
}
