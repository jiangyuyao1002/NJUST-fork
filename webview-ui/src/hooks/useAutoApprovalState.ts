import { useMemo } from "react"

interface AutoApprovalToggles {
	alwaysAllowReadOnly?: boolean
	alwaysAllowReadOnlyOutsideWorkspace?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowWriteOutsideWorkspace?: boolean
	alwaysAllowWriteProtected?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowMcp?: boolean
	alwaysAllowModeSwitch?: boolean
	alwaysAllowSubtasks?: boolean
	alwaysAllowFollowupQuestions?: boolean
	saveAllBeforeExecuteCommand?: boolean
}

export function useAutoApprovalState(toggles: AutoApprovalToggles, autoApprovalEnabled?: boolean) {
	const hasEnabledOptions = useMemo(() => {
		return Object.values(toggles).some((value) => !!value)
	}, [toggles])

	const effectiveAutoApprovalEnabled = useMemo(() => {
		return autoApprovalEnabled ?? false
	}, [autoApprovalEnabled])

	return {
		hasEnabledOptions,
		effectiveAutoApprovalEnabled,
	}
}
