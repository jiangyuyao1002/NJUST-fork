import { logger } from "../shared/logger"
import { getErrorMessage } from "../shared/error-utils"
import { TelemetryService } from "@njust-ai-cj/telemetry"
import { TelemetryEventName } from "@njust-ai-cj/types"

interface Say {
	speak: (text: string, voice?: string, speed?: number, callback?: (err?: string) => void) => void
	stop: () => void
}

type PlayTtsOptions = {
	onStart?: () => void
	onStop?: () => void
}

type QueueItem = {
	message: string
	options: PlayTtsOptions
}

let isTtsEnabled = false

export const setTtsEnabled = (enabled: boolean) => (isTtsEnabled = enabled)

let speed = 1.0

export const setTtsSpeed = (newSpeed: number) => (speed = newSpeed)

let sayInstance: Say | undefined = undefined
let queue: QueueItem[] = []

export const playTts = async (message: string, options: PlayTtsOptions = {}) => {
	if (!isTtsEnabled) {
		return
	}

	try {
		queue.push({ message, options })
		await processQueue()
	} catch (error) {
		// TTS playback errors are non-critical — log but don't throw
		logger.warn("Tts", `TTS playback interrupted: ${getErrorMessage(error)}`)
		TelemetryService.reportError(error, TelemetryEventName.UTILITY_ERROR)
	}
}

export const stopTts = () => {
	sayInstance?.stop()
	sayInstance = undefined
	queue = []
}

const processQueue = async (): Promise<void> => {
	if (!isTtsEnabled || sayInstance) {
		return
	}

	const item = queue.shift()

	if (!item) {
		return
	}

	try {
		const { message: nextUtterance, options } = item

		await new Promise<void>((resolve, reject) => {
			// eslint-disable-next-line @typescript-eslint/no-require-imports -- Dynamic require needed for conditional TTS module loading
			const say: Say = require("say")
			sayInstance = say
			options.onStart?.()

			say.speak(nextUtterance, undefined, speed, (err) => {
				options.onStop?.()

				if (err) {
					reject(new Error(err))
				} else {
					resolve()
				}

				sayInstance = undefined
			})
		})

		await processQueue()
	} catch (_error: unknown) {
		sayInstance = undefined
		await processQueue()
	}
}
