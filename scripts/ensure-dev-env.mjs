/**
 * Ensure .env.development exists for local evals development.
 * If missing, copies .env.sample to .env.development as a starting point.
 *
 * Usage: node scripts/ensure-dev-env.mjs
 * (Runs as a pre-step before dotenvx in evals npm scripts)
 */
import { copyFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const evalsDir = resolve(__dirname, "..", "packages", "evals")
const devEnv = resolve(evalsDir, ".env.development")
const sampleEnv = resolve(evalsDir, ".env.sample")

if (!existsSync(devEnv)) {
	if (existsSync(sampleEnv)) {
		copyFileSync(sampleEnv, devEnv)
		console.warn(
			`[ensure-dev-env] .env.development not found; copied from .env.sample.\n` +
				`                  Please update DATABASE_URL with real credentials.`,
		)
	} else {
		console.warn(`[ensure-dev-env] Neither .env.development nor .env.sample found in ${evalsDir}`)
	}
}
