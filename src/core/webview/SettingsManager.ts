import type { GlobalState, NJUST_AI_CJSettings } from "@njust-ai-cj/types"

import type { ContextProxy } from "../config/ContextProxy"

export class SettingsManager {
	constructor(private readonly contextProxy: ContextProxy) {}

	public async setGlobalValue<K extends keyof GlobalState>(key: K, value: GlobalState[K]): Promise<void> {
		await this.contextProxy.setValue(key, value)
	}

	public getGlobalValue<K extends keyof GlobalState>(key: K): GlobalState[K] | undefined {
		return this.contextProxy.getValue(key)
	}

	public async setValue<K extends keyof NJUST_AI_CJSettings>(key: K, value: NJUST_AI_CJSettings[K]): Promise<void> {
		await this.contextProxy.setValue(key, value)
	}

	public getValue<K extends keyof NJUST_AI_CJSettings>(key: K): NJUST_AI_CJSettings[K] | undefined {
		return this.contextProxy.getValue(key)
	}

	public getValues(): NJUST_AI_CJSettings {
		return this.contextProxy.getValues()
	}

	public async setValues(values: NJUST_AI_CJSettings): Promise<void> {
		await this.contextProxy.setValues(values)
	}
}
