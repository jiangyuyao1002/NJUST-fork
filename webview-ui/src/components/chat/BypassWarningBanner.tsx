import React, { memo } from "react"
import { TriangleAlert } from "lucide-react"
import { Trans } from "react-i18next"

export const BypassWarningBanner = memo(() => {
	return (
		<div className="bg-red-600 text-white flex items-center gap-3 px-4 py-2 shrink-0">
			<TriangleAlert className="w-4 h-4 shrink-0" />
			<span className="font-bold text-sm">
				<Trans i18nKey="chat:bypassMode.title" ns="chat" />
			</span>
			<span className="text-xs opacity-90">
				<Trans i18nKey="chat:bypassMode.description" ns="chat" />
			</span>
		</div>
	)
})
