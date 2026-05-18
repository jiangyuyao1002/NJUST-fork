/**
 * Backpressure Controller for API Streams
 *
 * Wraps an AsyncGenerator and prevents unbounded buffering by limiting
 * the number of unconsumed chunks. When the consumer is slower than the
 * producer, the controller signals the producer to pause.
 *
 * Usage:
 *   const controlled = new BackpressureController(originalStream, 500)
 *   for await (const chunk of controlled) { ... }
 */

export class BackpressureController<T> implements AsyncIterable<T> {
	private buffer: T[] = []
	private error: Error | null = null
	private done = false
	private waitingConsumer: { resolve: (result: IteratorResult<T>) => void; reject: (err: Error) => void } | null = null
	private waitingProducer: { resolve: () => void } | null = null

	constructor(
		private source: AsyncGenerator<T>,
		private readonly highWaterMark: number = 1000,
		private readonly lowWaterMark: number = 250,
	) {
		if (highWaterMark <= lowWaterMark) {
			throw new Error("highWaterMark must be greater than lowWaterMark")
		}
		void this.startPumping()
	}

	private async startPumping(): Promise<void> {
		try {
			for await (const chunk of this.source) {
				this.buffer.push(chunk)

				// If buffer exceeds high water mark, pause upstream consumption
				if (this.buffer.length >= this.highWaterMark) {
					await new Promise<void>((resolve) => {
						this.waitingProducer = { resolve }
					})
				}

				// If a consumer is waiting for data, resolve it now
				if (this.waitingConsumer) {
					const consumer = this.waitingConsumer
					this.waitingConsumer = null
					consumer.resolve({ value: this.buffer.shift()!, done: false })
				}
			}
			this.done = true
			if (this.waitingConsumer) {
				this.waitingConsumer.resolve({ value: undefined, done: true })
			}
		} catch (err) {
			this.error = err instanceof Error ? err : new Error(String(err))
			if (this.waitingConsumer) {
				this.waitingConsumer.reject(this.error)
			}
		}
	}

	private consumerNext(): Promise<IteratorResult<T>> {
		// Data available immediately
		if (this.buffer.length > 0) {
			const value = this.buffer.shift()!

			// Buffer drained below low water mark — resume producer
			if (this.buffer.length <= this.lowWaterMark && this.waitingProducer) {
				const producer = this.waitingProducer
				this.waitingProducer = null
				producer.resolve()
			}

			return Promise.resolve({ value, done: false })
		}

		// Stream ended
		if (this.done) {
			return Promise.resolve({ value: undefined, done: true })
		}

		// Error occurred
		if (this.error) {
			return Promise.reject(this.error)
		}

		// Wait for more data
		return new Promise((resolve, reject) => {
			this.waitingConsumer = { resolve, reject }
		})
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return { next: () => this.consumerNext() }
	}

	/** Current buffer size (for monitoring). */
	get bufferSize(): number {
		return this.buffer.length
	}
}
