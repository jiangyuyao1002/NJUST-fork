import type { GlobalState, NJUST_AISettings } from "@njust-ai/types"

import type { ContextProxy } from "../config/ContextProxy"

export class SettingsManager {
	constructor(private readonly contextProxy: ContextProxy) {}

	public async setGlobalValue<K extends keyof GlobalState>(key: K, value: GlobalState[K]): Promise<void> {
		await this.contextProxy.setValue(key, value)
	}

	public getGlobalValue<K extends keyof GlobalState>(key: K): GlobalState[K] | undefined {
		return this.contextProxy.getValue(key)
	}

	public async setValue<K extends keyof NJUST_AISettings>(key: K, value: NJUST_AISettings[K]): Promise<void> {
		await this.contextProxy.setValue(key, value)
	}

	public getValue<K extends keyof NJUST_AISettings>(key: K): NJUST_AISettings[K] | undefined {
		return this.contextProxy.getValue(key)
	}

	public getValues(): NJUST_AISettings {
		return this.contextProxy.getValues()
	}

	public async setValues(values: NJUST_AISettings): Promise<void> {
		await this.contextProxy.setValues(values)
	}
}
