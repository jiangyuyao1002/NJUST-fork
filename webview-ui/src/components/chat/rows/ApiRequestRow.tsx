import React from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

import type { ClineMessage } from "@njust-ai-cj/types"

import { ProgressIndicator } from "../ProgressIndicator"
import ErrorRow from "../ErrorRow"

import { Repeat2 } from "lucide-react"

import { headerStyle, normalColor } from "./constants"

interface ApiRequestRowProps {
	message: ClineMessage
	icon: React.ReactNode
	title: React.ReactNode
	cost?: number | null
	apiReqCancelReason?: string | null
	apiReqStreamingFailedMessage?: string | null
	apiRequestFailedMessage?: string
	isCloudAgentUi: boolean
	isLast: boolean
}

export const ApiRequestRow = ({
	message,
	icon,
	title,
	cost,
	apiReqCancelReason,
	apiReqStreamingFailedMessage,
	apiRequestFailedMessage,
	isCloudAgentUi,
	isLast: _isLast,
}: ApiRequestRowProps) => {
	const { t, i18n } = useTranslation()
	const type = message.type === "ask" ? message.ask : message.say

	if (type === "api_req_started") {
		const isApiRequestInProgress =
			apiReqCancelReason === undefined && apiRequestFailedMessage === undefined && cost === undefined

		const errorBlock =
			(((cost === null || cost === undefined) && apiRequestFailedMessage) ||
				apiReqStreamingFailedMessage) && (
				<ErrorRow
					type="api_failure"
					message={apiRequestFailedMessage || apiReqStreamingFailedMessage || ""}
					docsURL={
						apiRequestFailedMessage?.toLowerCase().includes("powershell")
							? "https://github.com/cline/cline/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22"
							: undefined
					}
					errorDetails={apiReqStreamingFailedMessage ?? undefined}
				/>
			)

		if (isCloudAgentUi) {
			return (
				<div className="mt-0 mb-1 flex flex-col items-center gap-0">
					<div className="ca-api-chip w-full max-w-full">
						<div
							className={`ca-api-chip__inner group text-sm transition-opacity flex-wrap justify-center max-w-full ${
								isApiRequestInProgress ? "opacity-100" : "opacity-40 hover:opacity-100"
							}`}>
							{icon}
							{title}
							{cost !== null && cost !== undefined && cost > 0 ? (
								<span className="text-xs font-mono tabular-nums text-vscode-descriptionForeground border border-vscode-widget-border/50 px-1.5 py-0.5 rounded-md">
									${Number(cost).toFixed(4)}
								</span>
							) : null}
						</div>
					</div>
					{errorBlock}
				</div>
			)
		}

		return (
			<div className="chat-api-status-row">
				<div
					className={`group text-sm transition-opacity ${
						isApiRequestInProgress ? "opacity-100" : "opacity-40 hover:opacity-100"
					}`}
					style={{
						...headerStyle,
						marginBottom:
							((cost === null || cost === undefined) && apiRequestFailedMessage) ||
							apiReqStreamingFailedMessage
								? 10
								: 0,
						justifyContent: "space-between",
					}}>
					<div style={{ display: "flex", alignItems: "center", gap: "10px", flexGrow: 1 }}>
						{icon}
						{title}
					</div>
					<div
						className="text-xs text-vscode-dropdown-foreground border-vscode-dropdown-border/50 border px-1.5 py-0.5 rounded-lg font-mono tabular-nums"
						style={{ opacity: cost !== null && cost !== undefined && cost > 0 ? 1 : 0 }}>
						${Number(cost || 0)?.toFixed(4)}
					</div>
				</div>
				{errorBlock}
			</div>
		)
	}

	if (type === "api_req_retry_delayed") {
		let body = t(`chat:apiRequest.failed`)
		let retryInfo, rawError, code, docsURL
		if (message.text !== undefined) {
			const potentialCode = parseInt(message.text.substring(0, 3))
			if (!isNaN(potentialCode) && potentialCode >= 400) {
				code = potentialCode
				const stringForError = `chat:apiRequest.errorMessage.${code}`
				if (i18n.exists(stringForError)) {
					body = t(stringForError)
				} else {
					body = t("chat:apiRequest.errorMessage.unknown")
					docsURL = undefined
				}
			}

			const retryTimerMatch = message.text.match(/<retry_timer>(.*?)<\/retry_timer>/)
			const retryTimer = retryTimerMatch && retryTimerMatch[1] ? parseInt(retryTimerMatch[1], 10) : 0
			rawError = message.text.replace(/<retry_timer>(.*?)<\/retry_timer>/, "").trim()
			retryInfo = retryTimer > 0 && (
				<p
					className={cn(
						"mt-2 font-light text-xs  text-vscode-descriptionForeground cursor-default flex items-center gap-1 transition-all duration-1000",
						retryTimer === 0 ? "opacity-0 max-h-0" : "max-h-2 opacity-100",
					)}>
					<Repeat2 className="size-3" strokeWidth={1.5} />
					<span>{retryTimer}s</span>
				</p>
			)
		}
		return (
			<ErrorRow
				type="api_req_retry_delayed"
				code={code}
				message={body}
				docsURL={docsURL}
				additionalContent={retryInfo}
				errorDetails={rawError}
			/>
		)
	}

	if (type === "api_req_rate_limit_wait") {
		const isWaiting = message.partial === true

		const waitSeconds = (() => {
			if (!message.text) return undefined
			try {
				const data = JSON.parse(message.text)
				return typeof data.seconds === "number" ? data.seconds : undefined
			} catch {
				return undefined
			}
		})()

		return isWaiting && waitSeconds !== undefined ? (
			isCloudAgentUi ? (
				<div className="mt-0 mb-1 flex justify-center">
					<div className="ca-api-chip__inner text-sm">
						<ProgressIndicator />
						<span style={{ color: normalColor }}>{t("chat:apiRequest.rateLimitWait")}</span>
						<span className="text-xs text-vscode-descriptionForeground tabular-nums">
							{waitSeconds}s
						</span>
					</div>
				</div>
			) : (
				<div className="chat-api-status-row">
					<div
						className={`group text-sm transition-opacity opacity-100`}
						style={{
							...headerStyle,
							marginBottom: 0,
							justifyContent: "space-between",
						}}>
						<div style={{ display: "flex", alignItems: "center", gap: "10px", flexGrow: 1 }}>
							<ProgressIndicator />
							<span style={{ color: normalColor }}>{t("chat:apiRequest.rateLimitWait")}</span>
						</div>
						<span className="text-xs font-light text-vscode-descriptionForeground tabular-nums">
							{waitSeconds}s
						</span>
					</div>
				</div>
			)
		) : null
	}

	return null
}
