import type { GlobalSettings } from "@njust-ai/types"
import { ALWAYS_ALLOW_ALL_MODES } from "@njust-ai/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { Button, StandardTooltip } from "@/components/ui"

type CoreAutoApproveToggles = Pick<
	GlobalSettings,
	| "alwaysAllowAll"
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowMcp"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "alwaysAllowFollowupQuestions"
>

/** Mirrors VS Code `njust-ai.saveAllBeforeExecuteCommand`; not part of GlobalSettings storage. */
type AutoApproveToggles = CoreAutoApproveToggles & {
	saveAllBeforeExecuteCommand?: boolean
}

export type AutoApproveSetting = keyof AutoApproveToggles

type AutoApproveConfig = {
	key: AutoApproveSetting
	labelKey: string
	descriptionKey: string
	icon: string
	testId: string
}

export const autoApproveSettingsConfig: Record<AutoApproveSetting, AutoApproveConfig> = {
	alwaysAllowAll: {
		key: "alwaysAllowAll",
		labelKey: "settings:autoApprove.all.label",
		descriptionKey: "settings:autoApprove.all.description",
		icon: "shield",
		testId: "always-allow-all-toggle",
	},
	alwaysAllowReadOnly: {
		key: "alwaysAllowReadOnly",
		labelKey: "settings:autoApprove.readOnly.label",
		descriptionKey: "settings:autoApprove.readOnly.description",
		icon: "eye",
		testId: "always-allow-readonly-toggle",
	},
	alwaysAllowWrite: {
		key: "alwaysAllowWrite",
		labelKey: "settings:autoApprove.write.label",
		descriptionKey: "settings:autoApprove.write.description",
		icon: "edit",
		testId: "always-allow-write-toggle",
	},
	alwaysAllowMcp: {
		key: "alwaysAllowMcp",
		labelKey: "settings:autoApprove.mcp.label",
		descriptionKey: "settings:autoApprove.mcp.description",
		icon: "plug",
		testId: "always-allow-mcp-toggle",
	},
	alwaysAllowModeSwitch: {
		key: "alwaysAllowModeSwitch",
		labelKey: "settings:autoApprove.modeSwitch.label",
		descriptionKey: "settings:autoApprove.modeSwitch.description",
		icon: "sync",
		testId: "always-allow-mode-switch-toggle",
	},
	alwaysAllowSubtasks: {
		key: "alwaysAllowSubtasks",
		labelKey: "settings:autoApprove.subtasks.label",
		descriptionKey: "settings:autoApprove.subtasks.description",
		icon: "list-tree",
		testId: "always-allow-subtasks-toggle",
	},
	alwaysAllowExecute: {
		key: "alwaysAllowExecute",
		labelKey: "settings:autoApprove.execute.label",
		descriptionKey: "settings:autoApprove.execute.description",
		icon: "terminal",
		testId: "always-allow-execute-toggle",
	},
	saveAllBeforeExecuteCommand: {
		key: "saveAllBeforeExecuteCommand",
		labelKey: "settings:autoApprove.saveFiles.label",
		descriptionKey: "settings:autoApprove.saveFiles.description",
		icon: "save",
		testId: "save-all-before-execute-toggle",
	},
	alwaysAllowFollowupQuestions: {
		key: "alwaysAllowFollowupQuestions",
		labelKey: "settings:autoApprove.followupQuestions.label",
		descriptionKey: "settings:autoApprove.followupQuestions.description",
		icon: "question",
		testId: "always-allow-followup-questions-toggle",
	},
}

type AutoApproveToggleProps = AutoApproveToggles & {
	onToggle: (key: AutoApproveSetting, value: boolean) => void
	currentMode?: string
}

export const AutoApproveToggle = ({ onToggle, currentMode, ...props }: AutoApproveToggleProps) => {
	const { t } = useAppTranslation()

	const isModeAllowed = (ALWAYS_ALLOW_ALL_MODES as readonly string[]).includes(currentMode ?? "")
	const isAllEnabled = !!props.alwaysAllowAll

	return (
		<div className={cn("flex flex-row flex-wrap gap-2 py-2")}>
			{Object.values(autoApproveSettingsConfig)
				.filter(({ key }) => {
					// Hide "alwaysAllowAll" when current mode is not in the allowed list.
					if (key === "alwaysAllowAll" && !isModeAllowed) {
						return false
					}
					return true
				})
				.map(({ key, descriptionKey, labelKey, icon, testId }) => {
					// Sub-toggles are disabled (greyed out) when alwaysAllowAll is on.
					const isDisabledByAll = isAllEnabled && key !== "alwaysAllowAll"
					return (
						<StandardTooltip key={key} content={t(descriptionKey || "")}>
							<Button
								variant={props[key] ? "primary" : "secondary"}
								onClick={() => onToggle(key, !props[key])}
								aria-label={t(labelKey)}
								aria-pressed={!!props[key]}
								data-testid={testId}
								disabled={isDisabledByAll}
								className={cn(
									"gap-1.5 text-xs whitespace-nowrap",
									!props[key] && "opacity-50",
									isDisabledByAll && "opacity-40 cursor-not-allowed pointer-events-none",
								)}>
								<span className={`codicon codicon-${icon} text-sm`} />
								<span>{t(labelKey)}</span>
							</Button>
						</StandardTooltip>
					)
				})}
		</div>
	)
}
