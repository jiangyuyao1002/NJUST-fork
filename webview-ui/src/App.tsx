import React, { useCallback, useEffect, useRef, useState } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

import { type ExtensionMessage } from "@njust-ai/types"

import TranslationProvider from "./i18n/TranslationContext"
import { vscode } from "./utils/vscode"
import { initializeSourceMaps, exposeSourceMapsForDebugging } from "./utils/sourceMapInitializer"
import { ExtensionStateContextProvider, useExtensionState } from "./context/ExtensionStateContext"
import ChatView, { ChatViewRef } from "./components/chat/ChatView"
import HistoryView from "./components/history/HistoryView"
import SettingsView, { SettingsViewRef } from "./components/settings/SettingsView"
import WelcomeView from "./components/welcome/WelcomeViewProvider"
import { CheckpointRestoreDialog } from "./components/chat/CheckpointRestoreDialog"
import { DeleteMessageDialog, EditMessageDialog } from "./components/chat/MessageModificationConfirmationDialog"
import ErrorBoundary from "./components/ErrorBoundary"
import { useAddNonInteractiveClickListener } from "./components/ui/hooks/useNonInteractiveClick"
import { TooltipProvider } from "./components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "./components/ui/standard-tooltip"

type Tab = "settings" | "history" | "chat"

interface DeleteMessageDialogState {
	isOpen: boolean
	messageTs: number
	hasCheckpoint: boolean
}

interface EditMessageDialogState {
	isOpen: boolean
	messageTs: number
	text: string
	hasCheckpoint: boolean
	images?: string[]
}

// Memoize dialog components to prevent unnecessary re-renders
const MemoizedDeleteMessageDialog = React.memo(DeleteMessageDialog)
const MemoizedEditMessageDialog = React.memo(EditMessageDialog)
const MemoizedCheckpointRestoreDialog = React.memo(CheckpointRestoreDialog)
const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	historyButtonClicked: "history",
}

const App = () => {
	const { t } = useTranslation()
	const { didHydrateState, showWelcome, shouldShowAnnouncement, renderContext, fontFamily } = useExtensionState()

	useEffect(() => {
		if (fontFamily && fontFamily !== "serif") {
			document.body.setAttribute("data-font", fontFamily)
		} else {
			document.body.removeAttribute("data-font")
		}
	}, [fontFamily])

	const [showAnnouncement, setShowAnnouncement] = useState(false)
	const [tab, setTab] = useState<Tab>("chat")

	const [deleteMessageDialogState, setDeleteMessageDialogState] = useState<DeleteMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		hasCheckpoint: false,
	})

	const [editMessageDialogState, setEditMessageDialogState] = useState<EditMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		text: "",
		hasCheckpoint: false,
		images: [],
	})

	const settingsRef = useRef<SettingsViewRef>(null)
	const chatViewRef = useRef<ChatViewRef>(null)

	const switchTab = useCallback((newTab: Tab) => {
		setCurrentSection(undefined)

		if (settingsRef.current?.checkUnsaveChanges) {
			settingsRef.current.checkUnsaveChanges(() => setTab(newTab))
		} else {
			setTab(newTab)
		}
	}, [])

	const [currentSection, setCurrentSection] = useState<string | undefined>(undefined)

	const onMessage = useCallback(
		(e: MessageEvent) => {
			try {
				const message: ExtensionMessage = e.data

				if (message.type === "action" && message.action) {
					if (message.action === "switchTab" && message.tab) {
						const targetTab = message.tab as Tab
						switchTab(targetTab)
						const targetSection = message.values?.section as string | undefined
						setCurrentSection(targetSection)
					} else {
						const newTab = tabsByMessageAction[message.action]
						const section = message.values?.section as string | undefined

						if (newTab) {
							switchTab(newTab)
							setCurrentSection(section)
						}
					}
				}

				if (message.type === "showDeleteMessageDialog" && message.messageTs) {
					setDeleteMessageDialogState({
						isOpen: true,
						messageTs: message.messageTs,
						hasCheckpoint: message.hasCheckpoint || false,
					})
				}

				if (message.type === "showEditMessageDialog" && message.messageTs && message.text) {
					setEditMessageDialogState({
						isOpen: true,
						messageTs: message.messageTs,
						text: message.text,
						hasCheckpoint: message.hasCheckpoint || false,
						images: message.images || [],
					})
				}

				if (message.type === "acceptInput") {
					chatViewRef.current?.acceptInput()
				}
			} catch (err) {
				console.error("[webview App] onMessage handler failed:", err)
			}
		},
		[switchTab],
	)

	useEvent("message", onMessage)

	useEffect(() => {
		if (shouldShowAnnouncement && tab === "chat") {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement, tab])

	// Tell the extension that we are ready to receive messages.
	useEffect(() => vscode.postMessage({ type: "webviewDidLaunch" }), [])

	// Initialize source map support for better error reporting
	useEffect(() => {
		// Initialize source maps for better error reporting in production
		initializeSourceMaps()

		// Expose source map debugging utilities in production
		if (process.env.NODE_ENV === "production") {
			exposeSourceMapsForDebugging()
		}

		// Log initialization for debugging
		console.debug("App initialized with source map support")
	}, [])

	// Focus the WebView when non-interactive content is clicked (only in editor/tab mode)
	useAddNonInteractiveClickListener(
		useCallback(() => {
			// Only send focus request if we're in editor (tab) mode, not sidebar
			if (renderContext === "editor") {
				vscode.postMessage({ type: "focusPanelRequest" })
			}
		}, [renderContext]),
	)

	if (!didHydrateState) {
		return null
	}

	// Do not conditionally load ChatView, it's expensive and there's state we
	// don't want to lose (user input, disableInput, askResponse promise, etc.)
	return showWelcome ? (
		<ErrorBoundary>
			<WelcomeView />
		</ErrorBoundary>
	) : (
		<>
			{tab === "history" && (
				<ErrorBoundary>
					<HistoryView onDone={() => switchTab("chat")} />
				</ErrorBoundary>
			)}
			{tab === "settings" && (
				<ErrorBoundary>
					<SettingsView ref={settingsRef} onDone={() => setTab("chat")} targetSection={currentSection} />
				</ErrorBoundary>
			)}
			<ErrorBoundary
				fallback={(_error) => (
					<div className="flex flex-col items-center justify-center h-full p-6 text-center">
						<h2 className="text-lg font-bold mb-4">{t("common:errorBoundary.chatErrorTitle")}</h2>
						<p className="mb-4 text-sm opacity-80">{t("common:errorBoundary.chatErrorMessage")}</p>
						<button
							onClick={() => vscode.postMessage({ type: "downloadErrorDiagnostics" })}
							className="px-4 py-2 bg-vscode-button-background hover:bg-vscode-button-hoverBackground text-vscode-button-foreground rounded text-sm font-medium">
							{t("common:errorBoundary.downloadDiagnostics")}
						</button>
						<p className="mt-4 text-xs opacity-60">{t("common:errorBoundary.reloadInstructions")}</p>
					</div>
				)}>
				<ChatView
					ref={chatViewRef}
					isHidden={tab !== "chat"}
					showAnnouncement={showAnnouncement}
					hideAnnouncement={() => setShowAnnouncement(false)}
				/>
			</ErrorBoundary>
			{deleteMessageDialogState.isOpen && (
				<ErrorBoundary>
					{deleteMessageDialogState.hasCheckpoint ? (
						<MemoizedCheckpointRestoreDialog
							open={deleteMessageDialogState.isOpen}
							type="delete"
							hasCheckpoint={deleteMessageDialogState.hasCheckpoint}
							onOpenChange={(open: boolean) =>
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreCheckpoint: boolean) => {
								vscode.postMessage({
									type: "deleteMessageConfirm",
									messageTs: deleteMessageDialogState.messageTs,
									restoreCheckpoint,
								})
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					) : (
						<MemoizedDeleteMessageDialog
							open={deleteMessageDialogState.isOpen}
							onOpenChange={(open: boolean) =>
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={() => {
								vscode.postMessage({
									type: "deleteMessageConfirm",
									messageTs: deleteMessageDialogState.messageTs,
								})
								setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					)}
				</ErrorBoundary>
			)}
			{editMessageDialogState.isOpen && (
				<ErrorBoundary>
					{editMessageDialogState.hasCheckpoint ? (
						<MemoizedCheckpointRestoreDialog
							open={editMessageDialogState.isOpen}
							type="edit"
							hasCheckpoint={editMessageDialogState.hasCheckpoint}
							onOpenChange={(open: boolean) =>
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={(restoreCheckpoint: boolean) => {
								vscode.postMessage({
									type: "editMessageConfirm",
									messageTs: editMessageDialogState.messageTs,
									text: editMessageDialogState.text,
									restoreCheckpoint,
								})
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					) : (
						<MemoizedEditMessageDialog
							open={editMessageDialogState.isOpen}
							onOpenChange={(open: boolean) =>
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))
							}
							onConfirm={() => {
								vscode.postMessage({
									type: "editMessageConfirm",
									messageTs: editMessageDialogState.messageTs,
									text: editMessageDialogState.text,
									images: editMessageDialogState.images,
								})
								setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
							}}
						/>
					)}
				</ErrorBoundary>
			)}
		</>
	)
}

const queryClient = new QueryClient()

const AppWithLoginGate = () => {
	return (
		<ErrorBoundary>
			<ExtensionStateContextProvider>
				<TranslationProvider>
					<QueryClientProvider client={queryClient}>
						<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>
							<App />
						</TooltipProvider>
					</QueryClientProvider>
				</TranslationProvider>
			</ExtensionStateContextProvider>
		</ErrorBoundary>
	)
}

export default AppWithLoginGate
