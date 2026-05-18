import { type ProviderSettings, type OrganizationAllowList, type RouterModels } from "@njust-ai-cj/types"
import { rooDefaultModelId } from "@njust-ai-cj/core/providers"

import { ModelPicker } from "../ModelPicker"

type RooProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	routerModels?: RouterModels
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

export const Roo = ({
	apiConfiguration,
	setApiConfigurationField,
	routerModels,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: RooProps) => {
	return (
		<>
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={rooDefaultModelId}
				models={routerModels?.roo ?? {}}
				modelIdKey="apiModelId"
				serviceName="NJUST_AI_CJ Router"
				serviceUrl="https://github.com/NJUST-AI/NJUST_AI_CJ"
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>
		</>
	)
}
