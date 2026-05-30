import { HTMLAttributes } from "react"
import { Trans } from "react-i18next"
import { Package } from "@shared/package"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type InlineCompletionSettingsProps = HTMLAttributes<HTMLDivElement> & {
	inlineCompletionEnabled?: boolean
	inlineCompletionTriggerDelayMs?: number
	inlineCompletionMaxLines?: number
	inlineCompletionEnableCangjieEnhanced?: boolean
	inlineCompletionTriggerCommand?: string
	setCachedStateField: SetCachedStateField<
		| "inlineCompletionEnabled"
		| "inlineCompletionTriggerDelayMs"
		| "inlineCompletionMaxLines"
		| "inlineCompletionEnableCangjieEnhanced"
		| "inlineCompletionTriggerCommand"
	>
}

function clampDelay(ms: number): number {
	return Math.min(2000, Math.max(100, Math.round(ms)))
}

function clampLines(n: number): number {
	return Math.min(50, Math.max(1, Math.round(n)))
}

export const InlineCompletionSettings = ({
	inlineCompletionEnabled = true,
	inlineCompletionTriggerDelayMs = 300,
	inlineCompletionMaxLines = 10,
	inlineCompletionEnableCangjieEnhanced = true,
	inlineCompletionTriggerCommand = "alt+\\",
	setCachedStateField,
	...props
}: InlineCompletionSettingsProps) => {
	const { t } = useAppTranslation()

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.inlineCompletion")}</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="inline-completion-enabled"
					section="inlineCompletion"
					label={t("settings:inlineCompletion.enabled.label")}>
					<VSCodeCheckbox
						checked={inlineCompletionEnabled}
						onChange={(e: any) => setCachedStateField("inlineCompletionEnabled", e.target.checked)}>
						<span className="font-medium">{t("settings:inlineCompletion.enabled.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:inlineCompletion.enabled.description")}
					</div>
				</SearchableSetting>

				{inlineCompletionEnabled && (
					<>
						<SearchableSetting
							settingId="inline-completion-delay"
							section="inlineCompletion"
							label={t("settings:inlineCompletion.triggerDelayMs.label")}
							className="mt-4">
							<label className="block font-medium mb-1">{t("settings:inlineCompletion.triggerDelayMs.label")}</label>
							<VSCodeTextField
								value={String(inlineCompletionTriggerDelayMs)}
								onInput={(e: any) => {
									const v = parseInt(e.target.value, 10)
									if (!Number.isFinite(v)) return
									setCachedStateField("inlineCompletionTriggerDelayMs", clampDelay(v))
								}}
								className="w-full max-w-xs"
							/>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:inlineCompletion.triggerDelayMs.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="inline-completion-max-lines"
							section="inlineCompletion"
							label={t("settings:inlineCompletion.maxLines.label")}
							className="mt-4">
							<label className="block font-medium mb-1">{t("settings:inlineCompletion.maxLines.label")}</label>
							<VSCodeTextField
								value={String(inlineCompletionMaxLines)}
								onInput={(e: any) => {
									const v = parseInt(e.target.value, 10)
									if (!Number.isFinite(v)) return
									setCachedStateField("inlineCompletionMaxLines", clampLines(v))
								}}
								className="w-full max-w-xs"
							/>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:inlineCompletion.maxLines.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="inline-completion-cangjie"
							section="inlineCompletion"
							label={t("settings:inlineCompletion.enableCangjieEnhanced.label")}
							className="mt-4">
							<VSCodeCheckbox
								checked={inlineCompletionEnableCangjieEnhanced}
								onChange={(e: any) =>
									setCachedStateField("inlineCompletionEnableCangjieEnhanced", e.target.checked)
								}>
								<span className="font-medium">{t("settings:inlineCompletion.enableCangjieEnhanced.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:inlineCompletion.enableCangjieEnhanced.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="inline-completion-trigger-command"
							section="inlineCompletion"
							label={t("settings:inlineCompletion.triggerCommand.label")}
							className="mt-4">
							<label className="block font-medium mb-1">{t("settings:inlineCompletion.triggerCommand.label")}</label>
							<VSCodeTextField
								value={inlineCompletionTriggerCommand}
								onInput={(e: any) => setCachedStateField("inlineCompletionTriggerCommand", e.target.value)}
								className="w-full max-w-md"
							/>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:inlineCompletion.triggerCommand.description")}
							</div>
							<p className="text-vscode-descriptionForeground text-sm mt-2">
								<Trans
									i18nKey="settings:inlineCompletion.triggerCommand.shortcutHint"
									components={{
										ShortcutLink: (
											<a
												href="#"
												className="text-vscode-textLink-foreground hover:underline cursor-pointer"
												onClick={(e) => {
													e.preventDefault()
													vscode.postMessage({
														type: "openKeyboardShortcuts",
														text: `${Package.name}.triggerInlineCompletion`,
													})
												}}
											/>
										),
									}}
								/>
							</p>
						</SearchableSetting>
					</>
				)}
			</Section>
		</div>
	)
}
