import { useCallback } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@njust-ai/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"

import { inputEventTransform } from "../transforms"

type MimoTokenPlanProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const MimoTokenPlan = ({ apiConfiguration, setApiConfigurationField }: MimoTokenPlanProps) => {
	const { t } = useAppTranslation()

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.mimoTokenPlanApiKey || ""}
				type="password"
				onInput={handleInputChange("mimoTokenPlanApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">MiMo Token Plan API Key</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			<div className="text-sm text-vscode-descriptionForeground mt-1">
				<p>Token Plan uses keys prefixed with <code>tp-</code> and a dedicated endpoint.</p>
				<p>
					Supported models: mimo-v2-pro, mimo-v2-omni, mimo-v2-tts.{" "}
					<a href="https://platform.xiaomimimo.com" target="_blank" rel="noopener noreferrer">
						Manage subscription
					</a>
				</p>
			</div>
			{!apiConfiguration?.mimoTokenPlanApiKey && (
				<VSCodeButtonLink href="https://platform.xiaomimimo.com" appearance="secondary">
					Get MiMo Token Plan API Key
				</VSCodeButtonLink>
			)}
		</>
	)
}
