import { execFile } from "child_process"

export interface ProcessInfo {
	PID: string
	PPID: string
	COMMAND: string
	STAT: string
}

/**
 * Get all descendant processes of a given PID (children, grandchildren, etc.).
 *
 * Replaces the `ps-tree` npm package to eliminate the dependency on `wmic.exe`
 * (deprecated on Windows 11) in favor of PowerShell `Get-CimInstance`.
 *
 * Uses a two-pass approach:
 *   1. Collect ALL processes on the system
 *   2. Recursively filter descendants of the target PID
 *
 * This ensures all levels of the process tree are captured, not just direct children.
 */
export function getProcessTree(pid: number, callback: (err: Error | null, children: ProcessInfo[]) => void): void {
	if (process.platform === "win32") {
		getWindowsProcessTree(pid, callback)
	} else {
		getUnixProcessTree(pid, callback)
	}
}

function getWindowsProcessTree(pid: number, callback: (err: Error | null, children: ProcessInfo[]) => void): void {
	// Get-CimInstance replaces the deprecated wmic.exe on Windows 11+
	const cmd =
		"Get-CimInstance -ClassName Win32_Process | Select-Object Name, ProcessId, ParentProcessId | ConvertTo-Csv -NoTypeInformation"

	execFile("powershell", ["-Command", cmd], (error, stdout) => {
		if (error) {
			return callback(error, [])
		}

		try {
			const lines = stdout.trim().split("\n")
			if (lines.length < 2) {
				return callback(null, [])
			}

			// Parse CSV header
			const headers = lines[0]!.split(",").map((h) => h.replace(/"/g, "").trim())

			// Pass 1: Collect all processes
			const allProcesses: ProcessInfo[] = []
			for (let i = 1; i < lines.length; i++) {
				const line = lines[i]!.trim()
				if (!line) continue

				const values = line.split(",").map((v) => v.replace(/"/g, "").trim())
				const row: Record<string, string> = {}
				headers.forEach((header, index) => {
					row[header] = values[index] || ""
				})

				allProcesses.push({
					COMMAND: row.Name || "",
					PID: row.ProcessId || "",
					PPID: row.ParentProcessId || "",
					STAT: "",
				})
			}

			// Pass 2: Recursively find all descendants
			callback(null, filterDescendants(allProcesses, pid))
		} catch (parseError) {
			callback(parseError instanceof Error ? parseError : new Error(String(parseError)), [])
		}
	})
}

function getUnixProcessTree(pid: number, callback: (err: Error | null, children: ProcessInfo[]) => void): void {
	execFile("ps", ["-A", "-o", "ppid,pid,stat,comm"], (error, stdout) => {
		if (error) {
			return callback(error, [])
		}

		try {
			const lines = stdout.trim().split("\n")

			// Pass 1: Collect all processes
			const allProcesses: ProcessInfo[] = []
			for (let i = 1; i < lines.length; i++) {
				const columns = lines[i]!.trim().split(/\s+/)
				if (columns.length < 4) continue

				allProcesses.push({
					PPID: columns[0]!,
					PID: columns[1]!,
					STAT: columns[2]!,
					COMMAND: columns.slice(3).join(" "),
				})
			}

			// Pass 2: Recursively find all descendants
			callback(null, filterDescendants(allProcesses, pid))
		} catch (parseError) {
			callback(parseError instanceof Error ? parseError : new Error(String(parseError)), [])
		}
	})
}

/**
 * Two-pass recursive filter: finds all descendants of `rootPid` in the process list.
 *
 * Algorithm:
 *   1. Build a parent→children lookup map
 *   2. BFS/DFS from rootPid to collect all descendants
 */
function filterDescendants(allProcesses: ProcessInfo[], rootPid: number): ProcessInfo[] {
	const childrenByPpid = new Map<string, ProcessInfo[]>()

	for (const proc of allProcesses) {
		const existing = childrenByPpid.get(proc.PPID)
		if (existing) {
			existing.push(proc)
		} else {
			childrenByPpid.set(proc.PPID, [proc])
		}
	}

	const result: ProcessInfo[] = []
	const queue: string[] = [rootPid.toString()]

	while (queue.length > 0) {
		const currentPid = queue.shift()!
		const children = childrenByPpid.get(currentPid)
		if (!children) continue

		for (const child of children) {
			result.push(child)
			queue.push(child.PID)
		}
	}

	return result
}
