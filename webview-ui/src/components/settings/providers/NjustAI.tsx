import { type ProviderSettings, type OrganizationAllowList, type RouterModels } from "@njust-ai/types"
import { rooDefaultModelId } from "@njust-ai/core/providers"

import { ModelPicker } from "../ModelPicker"

type NjustAiProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

export const NjustAI = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: NjustAiProps) => {
	return (
		<>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={rooDefaultModelId}
				models={routerModels?.["njust-ai"] ?? {}}
				modelIdKey="apiModelId"
				serviceName="NJUST_AI Router"
				serviceUrl="https://github.com/NJUST-AI/NJUST_AI"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
