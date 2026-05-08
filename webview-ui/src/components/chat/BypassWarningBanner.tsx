import React, { memo } from "react"
import { TriangleAlert } from "lucide-react"
import { Trans } from "react-i18next"
import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"

type BypassWarningBannerProps = {
	onDismiss?: () => void
}

export const BypassWarningBanner = memo(({ onDismiss }: BypassWarningBannerProps) => {
	const handleDismiss = () => {
		vscode.postMessage({ type: "bypassWarningDismissed" })
		onDismiss?.()
	}

	return (
		<div className="bg-red-600 text-white flex items-center justify-between gap-3 px-4 py-2">
			<div className="flex items-center gap-2">
				<TriangleAlert className="w-4 h-4 shrink-0" />
				<span className="font-bold text-sm">
					<Trans i18nKey="chat:bypassMode.title" ns="chat" />
				</span>
			</div>
			<div className="text-xs flex-1 opacity-90">
				<Trans i18nKey="chat:bypassMode.description" ns="chat" />
			</div>
			<Button
				variant="ghost"
				size="sm"
				className="text-white hover:bg-white/20 text-xs shrink-0"
				onClick={handleDismiss}>
				<Trans i18nKey="chat:bypassMode.dismiss" ns="chat" />
			</Button>
		</div>
	)
})
