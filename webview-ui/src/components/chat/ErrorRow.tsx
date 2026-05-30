import React, { useState, useCallback, memo, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { BookOpenText, MessageCircleWarning, Copy, Check, Microscope, Info, ChevronDown, ChevronRight, Settings, RotateCcw } from "lucide-react"

import { useCopyToClipboard } from "@src/utils/clipboard"
import { vscode } from "@src/utils/vscode"
import CodeBlock from "../common/CodeBlock"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@src/components/ui/dialog"
import { Button } from "../ui"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import { PROVIDERS } from "../settings/constants"

/**
 * Unified error display component for all error types in the chat.
 * Provides consistent styling, icons, and optional documentation links across all errors.
 *
 * Errors are displayed in a tiered fashion:
 * 1. User-friendly title + message (always visible)
 * 2. Technical error details (collapsible, hidden by default)
 * 3. Action buttons for recovery (shown contextually based on error type/code)
 *
 * @param type - Error type determines default title
 * @param title - Optional custom title (overrides default for error type)
 * @param message - Error message text (required)
 * @param docsURL - Optional documentation link URL (shown as "Learn more" with book icon)
 * @param showCopyButton - Whether to show copy button for error message
 * @param expandable - Whether error content can be expanded/collapsed
 * @param defaultExpanded - Whether expandable content starts expanded
 * @param additionalContent - Optional React nodes to render after message
 * @param headerClassName - Custom CSS classes for header section
 * @param messageClassName - Custom CSS classes for message section
 * @param actionLabel - Label for recovery action button (shown alongside error message)
 * @param onAction - Callback when the recovery action button is clicked
 */
export interface ErrorRowProps {
	type:
		| "error"
		| "mistake_limit"
		| "api_failure"
		| "diff_error"
		| "streaming_failed"
		| "cancelled"
		| "api_req_retry_delayed"
	title?: string
	message: string
	showCopyButton?: boolean
	expandable?: boolean
	defaultExpanded?: boolean
	additionalContent?: React.ReactNode
	headerClassName?: string
	messageClassName?: string
	code?: number
	docsURL?: string // Optional documentation link
	errorDetails?: string // Optional detailed error message shown in modal
	actionLabel?: string // Label for recovery action button (e.g., "Go to Settings")
	onAction?: () => void // Callback when the action button is clicked
}

/**
 * Unified error display component for all error types in the chat.
 * Shows user-friendly messages by default with technical details available on demand.
 */
export const ErrorRow = memo(
	({
		type,
		title,
		message,
		showCopyButton = false,
		expandable = false,
		defaultExpanded = false,
		additionalContent,
		headerClassName,
		messageClassName,
		docsURL,
		code,
		errorDetails,
		actionLabel,
		onAction,
	}: ErrorRowProps) => {
		const { t } = useTranslation()
		const [isExpanded, setIsExpanded] = useState(defaultExpanded)
		const [showCopySuccess, setShowCopySuccess] = useState(false)
		const [isDetailsDialogOpen, setIsDetailsDialogOpen] = useState(false)
		const [showDetailsCopySuccess, setShowDetailsCopySuccess] = useState(false)
		const [isTechDetailsExpanded, setIsTechDetailsExpanded] = useState(false)
		const { copyWithFeedback } = useCopyToClipboard()
		const { version, apiConfiguration } = useExtensionState()
		const { provider, id: modelId } = useSelectedModel(apiConfiguration)

		// Validate docsURL to ensure it's a safe protocol
		const safeDocsURL = useMemo(() => {
			if (!docsURL) return undefined
			try {
				const url = new URL(docsURL)
				// Only allow http, https, and NjustAi protocols
				if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "NjustAi:") {
					return docsURL
				}
			} catch {
				// Invalid URL
			}
			return undefined
		}, [docsURL])

		const usesProxy = PROVIDERS.find((p) => p.value === provider)?.proxy ?? false

		// Format error details with metadata prepended
		const formattedErrorDetails = useMemo(() => {
			if (!errorDetails) return undefined

			const metadata = [
				`Date/time: ${new Date().toISOString()}`,
				`Extension version: ${version}`,
				`Provider: ${provider}${usesProxy ? " (proxy)" : ""}`,
				`Model: ${modelId}`,
				"",
				"",
			].join("\n")

			return metadata + errorDetails
		}, [errorDetails, version, provider, modelId, usesProxy])

		const handleDownloadDiagnostics = useCallback(
			(e: React.MouseEvent) => {
				e.stopPropagation()
				vscode.postMessage({
					type: "downloadErrorDiagnostics",
					values: {
						timestamp: new Date().toISOString(),
						version,
						provider,
						model: modelId,
						details: errorDetails || "",
					},
				})
			},
			[version, provider, modelId, errorDetails],
		)

		// Determine if this error has a contextual action suggestion
		const contextualAction = useMemo(() => {
			// If explicit action is provided, use it
			if (actionLabel && onAction) {
				return { label: actionLabel, action: onAction }
			}

			// Auto-detect common error patterns
			if (type === "api_failure" || type === "api_req_retry_delayed") {
				if (code === 401 || code === 403) {
					return {
						label: t("chat:apiRequest.errorMessage.goToSettings", { defaultValue: "Go to Settings" }),
						action: () =>
							window.postMessage(
								{ type: "action", action: "settingsButtonClicked", values: { section: "providers" } },
								"*",
							),
					}
				}
				if (code === 429) {
					return {
						label: "Retry",
						action: () =>
							window.postMessage(
								{ type: "action", action: "retryButtonClicked" },
								"*",
							),
					}
				}
			}

			return null
		}, [actionLabel, onAction, type, code, t])

		// Default titles for different error types
		const getDefaultTitle = () => {
			if (title) return title

			switch (type) {
				case "error":
					return t("chat:error")
				case "mistake_limit":
					return t("chat:troubleMessage")
				case "api_failure":
					return t("chat:apiRequest.failed")
				case "api_req_retry_delayed":
					return t("chat:apiRequest.errorTitle", { code: code ? ` · ${code}` : "" })
				case "streaming_failed":
					return t("chat:apiRequest.streamingFailed")
				case "cancelled":
					return t("chat:apiRequest.cancelled")
				case "diff_error":
					return t("chat:diffError.title")
				default:
					return null
			}
		}

		const handleToggleExpand = useCallback(() => {
			if (expandable) {
				setIsExpanded(!isExpanded)
			}
		}, [expandable, isExpanded])

		const handleCopy = useCallback(
			async (e: React.MouseEvent) => {
				e.stopPropagation()
				const success = await copyWithFeedback(message)
				if (success) {
					setShowCopySuccess(true)
					setTimeout(() => {
						setShowCopySuccess(false)
					}, 1000)
				}
			},
			[message, copyWithFeedback],
		)

		const handleCopyDetails = useCallback(
			async (e: React.MouseEvent) => {
				e.stopPropagation()
				if (formattedErrorDetails) {
					const success = await copyWithFeedback(formattedErrorDetails)
					if (success) {
						setShowDetailsCopySuccess(true)
						setTimeout(() => {
							setShowDetailsCopySuccess(false)
						}, 1000)
					}
				}
			},
			[formattedErrorDetails, copyWithFeedback],
		)

		const errorTitle = getDefaultTitle()

		// For diff_error type with expandable content
		if (type === "diff_error" && expandable) {
			return (
				<div className="mt-0 overflow-hidden mb-2 pr-1 group">
					<div
						className="font-sm text-vscode-editor-foreground flex items-center justify-between cursor-pointer"
						onClick={handleToggleExpand}>
						<div className="flex items-center gap-2 flex-grow text-vscode-errorForeground">
							<MessageCircleWarning className="w-4" />
							<span className="text-vscode-errorForeground font-bold grow cursor-pointer">
								{errorTitle}
							</span>
						</div>
						<div className="flex items-center transition-opacity opacity-0 group-hover:opacity-100">
							{showCopyButton && (
								<VSCodeButton
									appearance="icon"
									className="p-0.75 h-6 mr-1 text-vscode-editor-foreground flex items-center justify-center bg-transparent"
									onClick={handleCopy}>
									<span className={`codicon codicon-${showCopySuccess ? "check" : "copy"}`} />
								</VSCodeButton>
							)}
							<span className={`codicon codicon-chevron-${isExpanded ? "up" : "down"}`} />
						</div>
					</div>
					{isExpanded && (
						<div className="px-2 py-1 mt-2 bg-vscode-editor-background ml-6 rounded-lg">
							<CodeBlock source={message} language="text" />
						</div>
					)}
				</div>
			)
		}

		// Standard error display
		return (
			<>
				<div className="group pr-2">
					{errorTitle && (
						<div className={headerClassName || "flex items-center justify-between gap-2 break-words"}>
							<MessageCircleWarning className="w-4 text-vscode-errorForeground shrink-0" />
							<span className="font-bold grow cursor-default">{errorTitle}</span>
							<div className="flex items-center gap-2">
								{safeDocsURL && (
									<a
										href={safeDocsURL}
										className="text-sm flex items-center gap-1 transition-opacity opacity-0 group-hover:opacity-100"
										onClick={(e) => {
											e.preventDefault()
											if (safeDocsURL.startsWith("NjustAi://settings")) {
												vscode.postMessage({
													type: "switchTab",
													tab: "settings",
													values: { section: "providers" },
												})
											} else {
												vscode.postMessage({ type: "openExternal", url: safeDocsURL })
											}
										}}>
										<BookOpenText className="size-3 mt-[3px]" />
										{safeDocsURL.startsWith("NjustAi://settings")
											? t("chat:apiRequest.errorMessage.goToSettings", {
													defaultValue: "Settings",
												})
											: t("chat:apiRequest.errorMessage.docs")}
									</a>
								)}
							</div>
						</div>
					)}
					<div className="ml-2 pl-4 mt-1 pt-0.5 border-l border-vscode-errorForeground/50">
						<p
							className={
								messageClassName ||
								"cursor-default my-0 font-light whitespace-pre-wrap break-words text-vscode-descriptionForeground"
							}>
							{message}
							{formattedErrorDetails && (
								<button
									onClick={() => setIsDetailsDialogOpen(true)}
									className="cursor-pointer ml-1 text-vscode-descriptionForeground/50 hover:text-vscode-descriptionForeground hover:underline font-normal"
									aria-label={t("chat:errorDetails.title")}>
									{t("chat:errorDetails.link")}
								</button>
							)}
						</p>
						{/* Action buttons */}
						{(contextualAction || formattedErrorDetails) && (
							<div className="flex items-center gap-2 mt-2">
								{contextualAction && (
									<button
										onClick={contextualAction.action}
										className="cursor-pointer inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded bg-vscode-button-background text-vscode-button-foreground hover:opacity-90 transition-opacity">
										{contextualAction.label === t("chat:apiRequest.errorMessage.goToSettings", { defaultValue: "Go to Settings" }) ? (
											<Settings className="size-3" />
										) : (
											<RotateCcw className="size-3" />
										)}
										{contextualAction.label}
									</button>
								)}
								{formattedErrorDetails && (
									<button
										onClick={(e) => {
											e.stopPropagation()
											setIsTechDetailsExpanded(!isTechDetailsExpanded)
										}}
										className="cursor-pointer inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded text-vscode-descriptionForeground hover:bg-vscode-editor-background transition-colors">
										{isTechDetailsExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
										{isTechDetailsExpanded ? "Hide technical details" : "Show technical details"}
									</button>
								)}
							</div>
						)}
						{/* Inline technical details (tiered disclosure) */}
						{isTechDetailsExpanded && formattedErrorDetails && (
							<div className="mt-2 p-3 bg-vscode-editor-background rounded border border-vscode-editorGroup-border">
								<pre className="font-mono text-xs whitespace-pre-wrap break-words max-h-48 overflow-auto">
									{formattedErrorDetails}
								</pre>
								<div className="flex items-center gap-2 mt-2">
									<button
										onClick={handleCopyDetails}
										className="cursor-pointer inline-flex items-center gap-1 text-xs text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors">
										{showDetailsCopySuccess ? <Check className="size-3" /> : <Copy className="size-3" />}
										{showDetailsCopySuccess ? t("chat:errorDetails.copied") : t("chat:errorDetails.copyToClipboard")}
									</button>
									<button
										onClick={handleDownloadDiagnostics}
										className="cursor-pointer inline-flex items-center gap-1 text-xs text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors">
										<Microscope className="size-3" />
										{t("chat:errorDetails.diagnostics")}
									</button>
									{usesProxy && (
										<span className="flex items-center gap-1 text-xs text-vscode-descriptionForeground ml-auto">
											<Info className="size-3 shrink-0" />
											{t("chat:errorDetails.proxyProvider")}
										</span>
									)}
								</div>
							</div>
						)}
						{additionalContent}
					</div>
				</div>

				{/* Error Details Dialog (kept for backward compatibility with full-screen modal) */}
				{formattedErrorDetails && (
					<Dialog open={isDetailsDialogOpen} onOpenChange={setIsDetailsDialogOpen}>
						<DialogContent className="max-w-2xl">
							<DialogHeader>
								<DialogTitle>{t("chat:errorDetails.title")}</DialogTitle>
							</DialogHeader>
							<div className="max-h-96 overflow-auto bg-vscode-editor-background rounded-xl border border-vscode-editorGroup-border">
								<pre className="font-mono text-sm whitespace-pre-wrap break-words bg-transparent px-3">
									{formattedErrorDetails}
								</pre>
								{usesProxy && (
									<div className="cursor-default flex gap-2 border-t-1 px-3 py-2 border-vscode-editorGroup-border bg-foreground/5 text-vscode-button-secondaryForeground">
										<Info className="size-3 shrink-0 mt-1 text-vscode-descriptionForeground" />
										<span className="text-vscode-descriptionForeground text-sm">
											{t("chat:errorDetails.proxyProvider")}
										</span>
									</div>
								)}
							</div>
							<DialogFooter>
								<Button variant="secondary" className="w-full" onClick={handleCopyDetails}>
									{showDetailsCopySuccess ? (
										<>
											<Check className="size-3" />
											{t("chat:errorDetails.copied")}
										</>
									) : (
										<>
											<Copy className="size-3" />
											{t("chat:errorDetails.copyToClipboard")}
										</>
									)}
								</Button>
								<Button variant="secondary" className="w-full" onClick={handleDownloadDiagnostics}>
									<Microscope className="size-3" />
									{t("chat:errorDetails.diagnostics")}
								</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
				)}
			</>
		)
	},
)

export default ErrorRow
