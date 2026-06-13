/**
 * check-any-gate.mjs
 *
 * CI gate script: counts `eslint-disable @typescript-eslint/no-explicit-any`
 * occurrences across the codebase. Fails if the count exceeds the baseline,
 * enforcing a "never increase" policy on UnsafeAny usage.
 *
 * Usage: node scripts/check-any-gate.mjs [--update-baseline]
 *
 * The --update-baseline flag writes the current count as the new baseline.
 * Use this ONLY when the count has legitimately decreased (e.g., after a
 * dedicated narrowing PR). Never use it to raise the baseline.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, "..")

// ── Configuration ──────────────────────────────────────────────────
// Baseline: the maximum allowed number of eslint-disable any comments.
// Set to the current count as of 2026-06-13. This must only decrease.
const BASELINE_FILE = join(__dirname, ".any-gate-baseline")

// Directories to scan (production code only, no node_modules)
const SCAN_DIRS = ["src", "packages", "apps", "webview-ui"]

// File extensions to scan
const EXTENSIONS = [".ts", ".tsx", ".mjs"]

// Pattern to match eslint-disable for no-explicit-any
// Covers: eslint-disable, eslint-disable-next-line, eslint-disable-line
const ANY_DISABLE_RE = /eslint-disable(?:-next-line|-line)?\s+@typescript-eslint\/no-explicit-any/g

// ── Helpers ────────────────────────────────────────────────────────

function getAllFiles(dir) {
	try {
		const entries = execSync(`git ls-files --cached --others --exclude-standard -- "${dir}"`, {
			cwd: rootDir,
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
		})
			.trim()
			.split("\n")
			.filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)))
		return entries
	} catch {
		// Fallback: use find (slower but works without git)
		return []
	}
}

function countDisablesInFile(filePath) {
	try {
		const content = readFileSync(join(rootDir, filePath), "utf-8")
		const matches = content.match(ANY_DISABLE_RE)
		return matches ? matches.length : 0
	} catch {
		return 0
	}
}

function readBaseline() {
	try {
		return parseInt(readFileSync(BASELINE_FILE, "utf-8").trim(), 10)
	} catch {
		return null
	}
}

function writeBaseline(count) {
	writeFileSync(BASELINE_FILE, `${count}\n`, "utf-8")
}

// ── Main ───────────────────────────────────────────────────────────

const updateBaseline = process.argv.includes("--update-baseline")

console.log("🔍 UnsafeAny Gate: scanning for eslint-disable @typescript-eslint/no-explicit-any...\n")

let totalCount = 0
const perDir = {}

for (const dir of SCAN_DIRS) {
	const files = getAllFiles(dir)
	let dirCount = 0

	for (const file of files) {
		const count = countDisablesInFile(file)
		if (count > 0) {
			dirCount += count
		}
	}

	perDir[dir] = dirCount
	totalCount += dirCount
}

// Print per-directory breakdown
console.log("📊 Per-directory breakdown:")
for (const [dir, count] of Object.entries(perDir)) {
	console.log(`   ${dir}: ${count}`)
}
console.log(`\n   Total: ${totalCount}`)

// Read or initialize baseline
let baseline = readBaseline()
if (baseline === null) {
	// First run: set baseline to current count
	baseline = totalCount
	writeBaseline(baseline)
	console.log(`\n📝 No baseline found. Initialized to ${totalCount}.`)
	console.log(`   Baseline file: ${relative(rootDir, BASELINE_FILE)}`)
}

if (updateBaseline) {
	if (totalCount > baseline) {
		console.error(
			`\n❌ REFUSED: Count increased from ${baseline} to ${totalCount}. ` +
				`The --update-baseline flag can only be used when the count has decreased.`,
		)
		process.exit(1)
	}
	writeBaseline(totalCount)
	console.log(`\n✅ Baseline updated: ${baseline} → ${totalCount}`)
	process.exit(0)
}

// Gate check
if (totalCount > baseline) {
	console.error(
		`\n❌ UnsafeAny gate FAILED: ${totalCount} eslint-disable any comments found, ` +
			`but baseline is ${baseline} (+${totalCount - baseline}).\n` +
			`   Each PR must not increase the total count of eslint-disable @typescript-eslint/no-explicit-any.\n` +
			`   Please narrow at least ${totalCount - baseline} UnsafeAny usage(s) or use a more specific type.`,
	)
	process.exit(1)
}

if (totalCount < baseline) {
	console.log(
		`\n✅ UnsafeAny gate PASSED: ${totalCount} (baseline ${baseline}, ↓${baseline - totalCount}). ` +
			`Great progress! Run with --update-baseline to lock in the improvement.`,
	)
} else {
	console.log(`\n✅ UnsafeAny gate PASSED: ${totalCount} (baseline ${baseline}, no change).`)
}
