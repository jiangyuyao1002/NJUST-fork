#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const errors = []

function fail(message) {
	errors.push(message)
}

function readText(file) {
	return readFileSync(file, "utf8").trim()
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"))
	} catch (error) {
		fail(`${file}: invalid JSON (${error.message})`)
		return null
	}
}

function gitLsFiles(patterns = []) {
	const args = ["ls-files", ...patterns]
	return execFileSync("git", args, { encoding: "utf8" })
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
}

function assertEqual(label, actual, expected) {
	if (actual !== expected) {
		fail(`${label}: expected ${expected}, got ${actual || "<empty>"}`)
	}
}

const rootPackage = readJson("package.json")
const srcPackage = readJson("src/package.json")

if (rootPackage) {
	const packageManager = rootPackage.packageManager ?? ""
	const pnpmVersion = packageManager.startsWith("pnpm@") ? packageManager.slice("pnpm@".length) : ""
	const nvmNode = existsSync(".nvmrc") ? readText(".nvmrc").replace(/^v/, "") : ""
	const toolVersions = existsSync(".tool-versions") ? readText(".tool-versions") : ""
	const toolNode = toolVersions.match(/^nodejs\s+(.+)$/m)?.[1] ?? ""
	const toolPnpm = toolVersions.match(/^pnpm\s+(.+)$/m)?.[1] ?? ""
	const setupAction = existsSync(".github/actions/setup-node-pnpm/action.yml")
		? readText(".github/actions/setup-node-pnpm/action.yml")
		: ""
	const setupNode = setupAction.match(/default:\s*"([^"]+)"/)?.[1] ?? ""
	const setupPnpm = setupAction.match(/pnpm-version:[\s\S]*?default:\s*"([^"]+)"/)?.[1] ?? ""

	assertEqual("root engines.node vs .nvmrc", rootPackage.engines?.node, nvmNode)
	assertEqual("root engines.node vs .tool-versions nodejs", rootPackage.engines?.node, toolNode)
	assertEqual("packageManager pnpm vs .tool-versions pnpm", pnpmVersion, toolPnpm)
	assertEqual("setup action node-version vs root engines.node", setupNode, rootPackage.engines?.node)
	assertEqual("setup action pnpm-version vs packageManager", setupPnpm, pnpmVersion)
}

if (rootPackage && srcPackage) {
	assertEqual("src engines.node vs root engines.node", srcPackage.engines?.node, rootPackage.engines?.node)
}

for (const file of gitLsFiles(["*package.json"])) {
	readJson(file)
}

const forbiddenRootArtifacts = [
	/^cangjie_lsp_.*\.txt$/,
	/^eslint-report.*\.json$/,
	/^temp-lint-.*\.txt$/,
	/^tsc-output\.txt$/,
	/^progress\.txt$/,
]

for (const file of gitLsFiles()) {
	if (!existsSync(file)) {
		continue
	}
	const normalized = file.replace(/\\/g, "/")
	if (!normalized.includes("/") && forbiddenRootArtifacts.some((pattern) => pattern.test(normalized))) {
		fail(`tracked local artifact at repo root: ${normalized}`)
	}
}

if (errors.length > 0) {
	console.error("Repository hygiene check failed:")
	for (const error of errors) {
		console.error(`- ${error}`)
	}
	process.exit(1)
}

console.log("Repository hygiene check passed.")
