/**
 * 模型降级策略管理器
 *
 * 当主模型连续失败超过阈值时，自动切换到备用模型。
 * Fallback 链：主模型 → 备用模型 → 最小模型 → 用户通知
 *
 * 借鉴 Claude Code 的 FallbackTriggeredError 机制：
 * - 连续失败超过阈值时自动切换
 * - 成功调用重置失败计数但不回退模型
 * - 所有模型耗尽时通知用户干预
 */

export interface FallbackConfig {
	/** 切换前最大失败次数 */
	maxFailuresBeforeFallback: number
	/** 备用模型列表（按优先级排序） */
	fallbackModels: string[]
	/** 切换时是否通知用户 */
	notifyUser: boolean
}

export interface FallbackState {
	/** 当前使用的模型索引（0=主模型） */
	currentModelIndex: number
	/** 当前模型的连续失败次数 */
	consecutiveFailures: number
	/** 总 fallback 次数 */
	totalFallbacks: number
	/** 原始主模型 ID */
	originalModel: string
	/** 是否处于 fallback 状态 */
	isInFallback: boolean
}

const DEFAULT_CONFIG: FallbackConfig = {
	maxFailuresBeforeFallback: 3,
	fallbackModels: [],
	notifyUser: true,
}

export class ModelFallbackManager {
	private state: FallbackState
	private config: FallbackConfig
	private models: string[] // [主模型, ...备用模型]

	constructor(primaryModel: string, config?: Partial<FallbackConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.models = [primaryModel, ...this.config.fallbackModels]
		this.state = {
			currentModelIndex: 0,
			consecutiveFailures: 0,
			totalFallbacks: 0,
			originalModel: primaryModel,
			isInFallback: false,
		}
	}

	/**
	 * 报告模型调用失败
	 * @returns 下一个要尝试的模型 ID，或 null 表示所有模型都已耗尽
	 */
	reportFailure(_error: Error): { nextModel: string | null; shouldNotifyUser: boolean; reason: string } {
		this.state.consecutiveFailures++

		// 未达到切换阈值，继续使用当前模型
		if (this.state.consecutiveFailures < this.config.maxFailuresBeforeFallback) {
			return {
				nextModel: this.models[this.state.currentModelIndex] ?? null,
				shouldNotifyUser: false,
				reason: `Model "${this.getCurrentModel()}" failed ${this.state.consecutiveFailures}/${this.config.maxFailuresBeforeFallback} times, continuing with current model.`,
			}
		}

		// 达到阈值，尝试切换到下一个模型
		const nextIndex = this.state.currentModelIndex + 1

		if (nextIndex >= this.models.length) {
			// 所有模型都已耗尽
			return {
				nextModel: null,
				shouldNotifyUser: true,
				reason: `All models exhausted. Primary model "${this.state.originalModel}" and ${this.config.fallbackModels.length} fallback model(s) all failed. User intervention required.`,
			}
		}

		// 切换到下一个模型
		this.state.currentModelIndex = nextIndex
		this.state.consecutiveFailures = 0
		this.state.totalFallbacks++
		this.state.isInFallback = true

		const previousModel = this.models[nextIndex - 1]
		const nextModel = this.models[nextIndex]

		return {
			nextModel: nextModel ?? null,
			shouldNotifyUser: this.config.notifyUser,
			reason: `Model "${previousModel}" failed ${this.config.maxFailuresBeforeFallback} consecutive times. Falling back to "${nextModel}" (fallback #${this.state.totalFallbacks}).`,
		}
	}

	/**
	 * 报告模型调用成功，重置失败计数（但不回退到主模型）
	 */
	reportSuccess(): void {
		this.state.consecutiveFailures = 0
	}

	/**
	 * 获取当前活跃模型
	 */
	getCurrentModel(): string {
		return this.models[this.state.currentModelIndex]!
	}

	/**
	 * 是否处于 fallback 状态
	 */
	isInFallbackMode(): boolean {
		return this.state.isInFallback
	}

	/**
	 * 重置为主模型（用于新的会话或用户手动重置）
	 */
	reset(): void {
		this.state = {
			currentModelIndex: 0,
			consecutiveFailures: 0,
			totalFallbacks: 0,
			originalModel: this.state.originalModel,
			isInFallback: false,
		}
	}

	/**
	 * 获取状态信息（用于 UI 显示和遥测）
	 */
	getState(): Readonly<FallbackState> {
		return { ...this.state }
	}
}
