import { useCallback, useEffect, useState } from "react"
import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { type ProviderSettings, type OrganizationAllowList, type RouterModels } from "@njust-ai/types"
import { requestyDefaultModelId } from "@njust-ai/core/providers"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"
import { RequestyBalanceDisplay } from "./RequestyBalanceDisplay"
import { getRequestyAuthUrl, type OAuthUrlResult } from "@/oauth/urls"

type RequestyProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	refetchRouterModels: () => void
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	uriScheme?: string
	simplifySettings?: boolean
}

export const Requesty = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	uriScheme,
	simplifySettings,
}: RequestyProps) => {
	const { t } = useAppTranslation()

	const [requestyEndpointSelected, setRequestyEndpointSelected] = useState(!!apiConfiguration.requestyBaseUrl)
	const [oauthUrl, setOauthUrl] = useState<string>("")

	// Generate OAuth URL with CSRF state on mount (async)
	useEffect(() => {
		let cancelled = false
		getRequestyAuthUrl(uriScheme, apiConfiguration.requestyBaseUrl).then((result: OAuthUrlResult) => {
			if (!cancelled) {
				setOauthUrl(result.url)
				// Send state to extension for callback CSRF verification
				vscode.postMessage({
					type: "openRouterOAuthState",
					state: result.state,
					oauthProvider: "requesty",
					oauthBaseUrl: apiConfiguration.requestyBaseUrl,
				})
			}
		})
		return () => {
			cancelled = true
		}
	}, [uriScheme, apiConfiguration.requestyBaseUrl])

	// This ensures that the "Use custom URL" checkbox is hidden when the user deletes the URL.
	useEffect(() => {
		setRequestyEndpointSelected(!!apiConfiguration?.requestyBaseUrl)
	}, [apiConfiguration?.requestyBaseUrl])

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
				value={apiConfiguration?.requestyApiKey || ""}
				type="password"
				onInput={handleInputChange("requestyApiKey")}
				placeholder={t("settings:providers.getRequestyApiKey")}
				className="w-full">
				<div className="flex justify-between items-center mb-1">
					<label className="block font-medium">{t("settings:providers.requestyApiKey")}</label>
					{apiConfiguration?.requestyApiKey && (
						<RequestyBalanceDisplay
							baseUrl={apiConfiguration.requestyBaseUrl}
							apiKey={apiConfiguration.requestyApiKey}
						/>
					)}
				</div>
			</VSCodeTextField>
			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>
			<a
				href={oauthUrl || "#"}
				target="_blank"
				rel="noopener noreferrer"
				className="inline-flex items-center justify-center whitespace-nowrap text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 rounded-md px-3 w-full"
				style={{
					width: "100%",
					textDecoration: "none",
					color: "var(--vscode-button-foreground)",
					backgroundColor: "var(--vscode-button-background)",
					opacity: oauthUrl ? 1 : 0.5,
					pointerEvents: oauthUrl ? "auto" : "none",
				}}>
				{t("settings:providers.getRequestyApiKey")}
			</a>

			<VSCodeCheckbox
				checked={requestyEndpointSelected}
				onChange={(e: any) => {
					const isChecked = e.target.checked === true
					if (!isChecked) {
						setApiConfigurationField("requestyBaseUrl", undefined)
					}

					setRequestyEndpointSelected(isChecked)
				}}>
				{t("settings:providers.requestyUseCustomBaseUrl")}
			</VSCodeCheckbox>
			{requestyEndpointSelected && (
				<VSCodeTextField
					value={apiConfiguration?.requestyBaseUrl || ""}
					type="text"
					onInput={handleInputChange("requestyBaseUrl")}
					placeholder={t("settings:providers.getRequestyBaseUrl")}
					className="w-full">
					<div className="flex justify-between items-center mb-1">
						<label className="block font-medium">{t("settings:providers.getRequestyBaseUrl")}</label>
					</div>
				</VSCodeTextField>
			)}
			<Button
				variant="outline"
				onClick={() => {
					vscode.postMessage({ type: "requestRouterModels", values: { provider: "requesty", refresh: true } })
				}}>
				<div className="flex items-center gap-2">
					<span className="codicon codicon-refresh" />
					{t("settings:providers.refreshModels.label")}
				</div>
			</Button>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={requestyDefaultModelId}
				models={routerModels?.requesty ?? {}}
				modelIdKey="requestyModelId"
				serviceName="Requesty"
				serviceUrl="https://requesty.ai"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
