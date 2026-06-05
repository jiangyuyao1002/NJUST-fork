/**
 * AuditLogger — append-only audit log writer.
 *
 * Writes NDJSON entries to `{baseDir}/audit/events-{YYYYMMDD}.ndjson`.
 * Each file is capped at MAX_ENTRIES_PER_FILE to prevent unbounded growth.
 *
 * This is intentionally separate from TelemetryLogger because audit logs
 * have different retention, compliance, and access requirements.
 */

import fs from "fs"
import * as path from "path"

import { logger } from "../shared/logger"

/** Structured audit log entry. */
export interface AuditEntry {
	/** ISO-8601 timestamp */
	timestamp: string
	/** Audit event category */
	category: AuditCategory
	/** Human-readable action description */
	action: string
	/** Task ID that triggered this event (if applicable) */
	taskId?: string
	/** Tool name (for tool-related events) */
	tool?: string
	/** Outcome: success, denied, error */
	outcome: "success" | "denied" | "error"
	/** Additional structured metadata */
	meta?: Record<string, unknown>
}

export type AuditCategory =
	| "tool.execution"
	| "tool.permission"
	| "session.lifecycle"
	| "subagent.lifecycle"
	| "config.change"
	| "security.alert"

const MAX_ENTRIES_PER_FILE = 50_000

export class AuditLogger {
	private baseDir: string
	private currentStream: fs.WriteStream | null = null
	private currentDate = ""
	private entryCount = 0
	private disposed = false

	constructor(baseDir: string) {
		this.baseDir = path.join(baseDir, "audit")
	}

	/** Write a single audit entry. Silently drops if disposed or over limit. */
	log(entry: AuditEntry): void {
		if (this.disposed) {
			return
		}

		const today = formatDate(new Date())
		if (today !== this.currentDate) {
			this.rotateStream(today)
		}

		if (this.entryCount >= MAX_ENTRIES_PER_FILE) {
			return // Silently drop to prevent unbounded growth
		}

		const line = JSON.stringify(entry) + "\n"
		this.currentStream?.write(line)
		this.entryCount++
	}

	/** Flush and close the underlying write stream. */
	async flush(): Promise<void> {
		if (!this.currentStream) {
			return
		}
		return new Promise<void>((resolve) => {
			this.currentStream!.end(() => resolve())
		})
	}

	/** Dispose the logger (flushes pending writes). */
	async dispose(): Promise<void> {
		this.disposed = true
		await this.flush()
		this.currentStream = null
	}

	private rotateStream(date: string): void {
		if (this.currentStream) {
			this.currentStream.end()
		}

		// Ensure audit directory exists
		fs.mkdirSync(this.baseDir, { recursive: true })

		const filePath = path.join(this.baseDir, `events-${date}.ndjson`)
		this.currentStream = fs.createWriteStream(filePath, { flags: "a", mode: 0o600 })
		this.currentStream.on("error", (err) => {
			logger.error("AuditLogger", "Write stream error:", err)
		})
		this.currentDate = date
		this.entryCount = 0

		logger.info("AuditLogger", `Rotated to ${filePath}`)
	}
}

function formatDate(d: Date): string {
	const y = d.getFullYear()
	const m = String(d.getMonth() + 1).padStart(2, "0")
	const day = String(d.getDate()).padStart(2, "0")
	return `${y}${m}${day}`
}
