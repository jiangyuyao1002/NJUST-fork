import React, { useState, useEffect } from "react"
import { CloudAgentProfile } from "@njust-ai-cj/types"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

interface CloudAgentProfileSelectorProps {
	/** 仅当 mode === "cloud-agent" 时渲染 */
	visible: boolean
}

export const CloudAgentProfileSelector: React.FC<CloudAgentProfileSelectorProps> = ({ visible }) => {
	const { t } = useAppTranslation()
	const [profiles, setProfiles] = useState<CloudAgentProfile[]>([])
	const [activeProfileId, setActiveProfileId] = useState<string | undefined>()
	const [isLoading, setIsLoading] = useState(false)

	// Load profiles when visible
	useEffect(() => {
		if (visible) {
			setIsLoading(true)
			vscode.postMessage({ type: "cloudAgentGetProfiles" })
		}
	}, [visible])

	// Listen for profile updates (only when visible to avoid interfering with other message handlers)
	useEffect(() => {
		if (!visible) return
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "cloudAgentProfiles") {
				setProfiles(message.profiles || [])
				setActiveProfileId(message.activeProfileId)
				setIsLoading(false)
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [visible])

	if (!visible) return null

	return (
		<Select
			value={activeProfileId || ""}
			onValueChange={(value) => {
				if (value) {
					vscode.postMessage({
						type: "cloudAgentSetActiveProfile",
						cloudAgentSetActiveProfile: value,
					})
					setActiveProfileId(value)
				}
			}}
			disabled={isLoading}>
			<SelectTrigger className="min-w-[80px] text-ellipsis overflow-hidden flex-shrink text-xs h-7 px-2 py-0.5">
				<SelectValue
					placeholder={
						isLoading
							? t("prompts:cloudAgent.profile.loading")
							: t("prompts:cloudAgent.profile.selectPlaceholder")
					}
				/>
			</SelectTrigger>
			<SelectContent>
				{profiles.map((profile) => (
					<SelectItem key={profile.id} value={profile.id} className="text-xs">
						<span className="text-ellipsis overflow-hidden">{profile.name}</span>
						{profile.isBuiltIn && (
							<span className="ml-1 text-[10px] text-vscode-descriptionForeground">
								({t("prompts:cloudAgent.profile.builtIn")})
							</span>
						)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}
