import { getModelId, type ProviderSettings } from "@njust-ai/types"

export function shouldRebuildTaskApiHandler(
	previousSettings: ProviderSettings | undefined,
	nextSettings: ProviderSettings,
	forceRebuild: boolean,
): boolean {
	if (forceRebuild) {
		return true
	}

	const previousProvider = previousSettings?.apiProvider
	const previousModelId = previousSettings ? getModelId(previousSettings) : undefined
	const nextProvider = nextSettings.apiProvider
	const nextModelId = getModelId(nextSettings)

	return previousProvider !== nextProvider || previousModelId !== nextModelId
}
