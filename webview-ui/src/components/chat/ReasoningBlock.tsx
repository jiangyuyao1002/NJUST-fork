import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useExtensionState } from "@src/context/ExtensionStateContext"

import MarkdownBlock from "../common/MarkdownBlock"
import { Lightbulb, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"

interface ReasoningBlockProps {
	content: string
	ts: number
	isStreaming: boolean
	isLast: boolean
	metadata?: any
}

export const ReasoningBlock = ({ content, isStreaming, isLast }: ReasoningBlockProps) => {
	const { t } = useTranslation()
	const { reasoningBlockCollapsed, mode } = useExtensionState()
	const isCloudAgentUi = mode === "cloud-agent"

	const [isCollapsed, setIsCollapsed] = useState(reasoningBlockCollapsed)

	const startTimeRef = useRef<number>(Date.now())
	const [elapsed, setElapsed] = useState<number>(0)
	const contentRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		setIsCollapsed(reasoningBlockCollapsed)
	}, [reasoningBlockCollapsed])

	useEffect(() => {
		if (isLast && isStreaming) {
			const tick = () => setElapsed(Date.now() - startTimeRef.current)
			tick()
			const id = setInterval(tick, 1000)
			return () => clearInterval(id)
		}
	}, [isLast, isStreaming])

	const seconds = Math.floor(elapsed / 1000)
	const secondsLabel = t("chat:reasoning.seconds", { count: seconds })

	const handleToggle = () => {
		setIsCollapsed(!isCollapsed)
	}

	return (
		<div className={cn(isCloudAgentUi ? "ca-reasoning-card" : "group chat-reasoning-card")}>
			<div
				className={cn(
					isCloudAgentUi
						? "ca-reasoning-header"
						: "chat-reasoning-card__header flex items-center justify-between cursor-pointer select-none",
				)}
				onClick={handleToggle}
				aria-expanded={!isCollapsed}
				aria-label="Toggle reasoning block">
				<div className="flex items-center gap-2">
					<Lightbulb className="w-4 text-vscode-textLink-foreground" />
					<span className={cn(isCloudAgentUi ? "ca-reasoning-title" : "chat-assistant-card__header-label")}>
						{t("chat:reasoning.thinking")}
					</span>
					{elapsed > 0 && (
						<span className="text-xs text-vscode-descriptionForeground mt-0.5 tabular-nums">
							{secondsLabel}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<ChevronUp
						className={cn(
							"w-4 transition-all text-vscode-descriptionForeground",
							isCloudAgentUi ? "opacity-70" : "opacity-0 group-hover:opacity-100",
							isCollapsed && "-rotate-180",
						)}
					/>
				</div>
			</div>
			{(content?.trim()?.length ?? 0) > 0 && !isCollapsed && (
				<div
					ref={contentRef}
					className={cn(isCloudAgentUi ? "ca-reasoning-body" : "chat-reasoning-card__body break-words")}>
					<MarkdownBlock markdown={content} />
				</div>
			)}
		</div>
	)
}
