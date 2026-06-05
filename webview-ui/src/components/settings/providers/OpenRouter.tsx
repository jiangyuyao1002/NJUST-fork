import { useCallback, useEffect, useState } from "react"
import { Checkbox } from "vscrui"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { type ProviderSettings, type OrganizationAllowList, type RouterModels } from "@njust-ai/types"
import { openRouterDefaultModelId } from "@njust-ai/core/providers"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { getOpenRouterAuthUrl, type OAuthUrlResult } from "@src/oauth/urls"
import { VSCodeButtonLink } from "@src/components/common/VSCodeButtonLink"
import { vscode } from "@src/utils/vscode"

import { inputEventTransform } from "../transforms"

import { ModelPicker } from "../ModelPicker"
import { OpenRouterBalanceDisplay } from "./OpenRouterBalanceDisplay"

type OpenRouterProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	selectedModelId: string
	uriScheme: string | undefined
	simplifySettings?: boolean
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
}

export const OpenRouter = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	uriScheme,
	simplifySettings,
	organizationAllowList,
	modelValidationError,
}: OpenRouterProps) => {
	const { t } = useAppTranslation()

	const [openRouterBaseUrlSelected, setOpenRouterBaseUrlSelected] = useState(!!apiConfiguration?.openRouterBaseUrl)
	const [oauthUrl, setOauthUrl] = useState<string>("")

	// Generate OAuth URL with state + PKCE on mount (async)
	useEffect(() => {
		let cancelled = false
		getOpenRouterAuthUrl(uriScheme).then((result: OAuthUrlResult) => {
			if (!cancelled) {
				setOauthUrl(result.url)
				// Send state + codeVerifier to extension for callback verification
				vscode.postMessage({
					type: "openRouterOAuthState",
					state: result.state,
					codeVerifier: result.codeVerifier,
					oauthProvider: "openrouter",
				})
			}
		})
		return () => {
			cancelled = true
		}
	}, [uriScheme])

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
				value={apiConfiguration?.openRouterApiKey || ""}
				type="password"
				onInput={handleInputChange("openRouterApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<div className="flex justify-between items-center mb-1">
					<label className="block font-medium">{t("settings:providers.openRouterApiKey")}</label>
					{apiConfiguration?.openRouterApiKey && (
						<OpenRouterBalanceDisplay
							apiKey={apiConfiguration.openRouterApiKey}
							baseUrl={apiConfiguration.openRouterBaseUrl}
						/>
					)}
				</div>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			{!apiConfiguration?.openRouterApiKey && (
				<VSCodeButtonLink
					href={oauthUrl || "#"}
					style={{ width: "100%", opacity: oauthUrl ? 1 : 0.5, pointerEvents: oauthUrl ? "auto" : "none" }}
					appearance="primary">
					{t("settings:providers.getOpenRouterApiKey")}
				</VSCodeButtonLink>
			)}
			{!simplifySettings && (
				<div>
					<Checkbox
						checked={openRouterBaseUrlSelected}
						onChange={(checked: boolean) => {
							setOpenRouterBaseUrlSelected(checked)

							if (!checked) {
								setApiConfigurationField("openRouterBaseUrl", "")
							}
						}}>
						{t("settings:providers.useCustomBaseUrl")}
					</Checkbox>
					{openRouterBaseUrlSelected && (
						<VSCodeTextField
							value={apiConfiguration?.openRouterBaseUrl || ""}
							type="url"
							onInput={handleInputChange("openRouterBaseUrl")}
							placeholder="Default: https://openrouter.ai/api/v1"
							className="w-full mt-1"
						/>
					)}
				</div>
			)}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={openRouterDefaultModelId}
				models={routerModels?.openrouter ?? {}}
				modelIdKey="openRouterModelId"
				serviceName="OpenRouter"
				serviceUrl="https://openrouter.ai/models"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
