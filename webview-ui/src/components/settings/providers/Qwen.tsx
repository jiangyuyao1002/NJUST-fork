import { useCallback } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@njust-ai/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"

import { inputEventTransform } from "../transforms"

type QwenProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
}

export const Qwen = ({ apiConfiguration, setApiConfigurationField }: QwenProps) => {
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
				value={apiConfiguration?.qwenApiKey || ""}
				type="password"
				onInput={handleInputChange("qwenApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">Qwen API Key</label>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			<VSCodeTextField
				value={apiConfiguration?.qwenBaseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1"}
				onInput={handleInputChange("qwenBaseUrl")}
				placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
				className="w-full">
				<label className="block font-medium mb-1">Base URL</label>
			</VSCodeTextField>
			{!apiConfiguration?.qwenApiKey && (
				<VSCodeButtonLink href="https://dashscope.console.aliyun.com/apiKey" appearance="secondary">
					Get Qwen API Key
				</VSCodeButtonLink>
			)}
		</>
	)
}
