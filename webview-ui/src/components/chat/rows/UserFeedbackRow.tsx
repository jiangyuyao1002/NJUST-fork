import React, { type Dispatch, type SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

import type { ClineMessage, ClineSayTool } from "@njust-ai/types"
import type { ModelInfo } from "@njust-ai/types"
import { Mode } from "@shared/modes"

import { vscode } from "@src/utils/vscode"

import { Mention } from "../Mention"
import Thumbnails from "../../common/Thumbnails"
import { ChatTextArea } from "../ChatTextArea"
import CodeAccordion from "../../common/CodeAccordion"

import { User, Edit, Trash2 } from "lucide-react"

import { headerStyle } from "./constants"

interface UserFeedbackRowProps {
	message: ClineMessage
	isEditing: boolean
	editedContent: string
	setEditedContent: (v: string) => void
	editMode: Mode
	setEditMode: (m: Mode) => void
	editImages: string[]
	setEditImages: Dispatch<SetStateAction<string[]>>
	handleEditClick: () => void
	handleCancelEdit: () => void
	handleSaveEdit: () => void
	handleSelectContextFiles: () => void
	isCloudAgentUi: boolean
	isStreaming: boolean
	model?: ModelInfo
	onToggleExpand: () => void
	isExpanded: boolean
}

export const UserFeedbackRow = ({
	message,
	isEditing,
	editedContent,
	setEditedContent,
	editMode,
	setEditMode,
	editImages,
	setEditImages,
	handleEditClick,
	handleCancelEdit,
	handleSaveEdit,
	handleSelectContextFiles,
	isCloudAgentUi,
	isStreaming,
	model,
	onToggleExpand,
	isExpanded,
}: UserFeedbackRowProps) => {
	const { t } = useTranslation()

	if (message.say === "user_feedback_diff") {
		const tool = JSON.parse(message.text || "{}") as ClineSayTool | null
		return (
			<div style={{ marginTop: -10, width: "100%" }}>
				<CodeAccordion
					code={tool?.diff}
					language="diff"
					isFeedback={true}
					isExpanded={isExpanded}
					onToggleExpand={onToggleExpand}
				/>
			</div>
		)
	}

	return (
		<div className={cn("group", isCloudAgentUi ? "ca-user-card" : undefined)}>
			<div
				className={cn(
					isCloudAgentUi ? "ca-user-header" : undefined,
					!isCloudAgentUi && "flex items-center gap-2",
				)}
				style={!isCloudAgentUi ? headerStyle : undefined}>
				<User
					className="w-4 shrink-0"
					style={isCloudAgentUi ? { color: "var(--ca-blue)" } : undefined}
					aria-hidden="true"
				/>
				<span
					className={cn(isCloudAgentUi ? "ca-user-title" : undefined)}
					style={!isCloudAgentUi ? { fontWeight: "bold" } : undefined}>
					{t("chat:feedback.youSaid")}
				</span>
			</div>
			<div
				className={cn(
					isCloudAgentUi ? "pb-2" : "border rounded-md overflow-hidden",
					isEditing
						? "bg-vscode-editor-background text-vscode-editor-foreground"
						: "cursor-text p-1 bg-vscode-editor-foreground/70 text-vscode-editor-background",
				)}>
				{isEditing ? (
					<div className="flex flex-col gap-2">
						<ChatTextArea
							inputValue={editedContent}
							setInputValue={setEditedContent}
							sendingDisabled={false}
							selectApiConfigDisabled={true}
							placeholderText={t("chat:editMessage.placeholder")}
							selectedImages={editImages}
							setSelectedImages={setEditImages}
							onSend={handleSaveEdit}
							onSelectContextFiles={handleSelectContextFiles}
							shouldDisableImages={!model?.supportsImages}
							mode={editMode}
							setMode={setEditMode}
							modeShortcutText=""
							isEditMode={true}
							onCancel={handleCancelEdit}
						/>
					</div>
				) : (
					<div className="flex justify-between">
						<div
							className="flex-grow px-2 py-1 wrap-anywhere rounded-lg transition-colors"
							onClick={(e) => {
								e.stopPropagation()
								if (!isStreaming) {
									handleEditClick()
								}
							}}
							title={t("chat:queuedMessages.clickToEdit")}>
							<Mention text={message.text} withShadow />
						</div>
						<div className="flex gap-2 pr-1">
							<div
								className="cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
								style={{ visibility: isStreaming ? "hidden" : "visible" }}
								aria-label={t("chat:editMessage.ariaLabel")}
								onClick={(e) => {
									e.stopPropagation()
									handleEditClick()
								}}>
								<Edit className="w-4 shrink-0" aria-hidden="true" />
							</div>
							<div
								className="cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
								style={{ visibility: isStreaming ? "hidden" : "visible" }}
								aria-label={t("chat:deleteMessage.ariaLabel")}
								onClick={(e) => {
									e.stopPropagation()
									vscode.postMessage({ type: "deleteMessage", value: message.ts })
								}}>
								<Trash2 className="w-4 shrink-0" aria-hidden="true" />
							</div>
						</div>
					</div>
				)}
				{!isEditing && message.images && message.images.length > 0 && (
					<Thumbnails images={message.images} style={{ marginTop: "8px" }} />
				)}
			</div>
		</div>
	)
}
