#!/usr/bin/env node

/**
 * Generate a minimal SPDX JSON SBOM from pnpm-lock.yaml.
 *
 * Usage:
 *   node scripts/generate-sbom.mjs > bom.spdx.json
 */

import { readFileSync, writeFileSync, existsSync } from "fs"
import { resolve } from "path"

function parsePnpmLock(content) {
	const deps = []
	const lines = content.split("\n")
	let currentPkg = null

	for (const line of lines) {
		// Match package specifier lines like:
		//   /lodash@4.17.21:
		//   /@types/node@20.14.0:
		const pkgMatch = line.match(/^\s+\/(@?[^/]+)@([^:]+):/)
		if (pkgMatch) {
			currentPkg = {
				name: pkgMatch[1],
				version: pkgMatch[2].replace(/[()]/g, "").trim(),
			}
			continue
		}

		// Match resolution lines like:
		//   resolution: {integrity: sha512-...}
		if (currentPkg && line.includes("integrity:")) {
			const integrityMatch = line.match(/integrity:\s*(sha\d+-[a-zA-Z0-9+/=]+)/)
			if (integrityMatch) {
				currentPkg.checksum = integrityMatch[1]
			}
			deps.push(currentPkg)
			currentPkg = null
		}
	}

	return deps
}

function generateSPDX(packages) {
	const now = new Date().toISOString()
	const pkg = JSON.parse(readFileSync("package.json", "utf-8"))

	const spdx = {
		spdxVersion: "SPDX-2.3",
		dataLicense: "CC0-1.0",
		SPDXID: "SPDXRef-DOCUMENT",
		name: `${pkg.name}-${pkg.version}`,
		creationInfo: {
			created: now,
			creators: ["Tool: njust-ai-sbom-generator"],
		},
		packages: [
			{
				SPDXID: "SPDXRef-ROOT",
				name: pkg.name,
				versionInfo: pkg.version,
				licenseConcluded: pkg.license || "NOASSERTION",
				supplier: `Person: ${pkg.author || "unknown"}`,
				filesAnalyzed: false,
			},
			...packages.map((dep, i) => ({
				SPDXID: `SPDXRef-PKG-${i}`,
				name: dep.name,
				versionInfo: dep.version,
				licenseConcluded: "NOASSERTION",
				checksums: dep.checksum
					? [{ algorithm: "SHA256", checksumValue: dep.checksum.split("-")[1] || dep.checksum }]
					: [],
				filesAnalyzed: false,
			})),
		],
		relationships: packages.map((_, i) => ({
			spdxElementId: "SPDXRef-ROOT",
			relatedSpdxElement: `SPDXRef-PKG-${i}`,
			relationshipType: "DEPENDS_ON",
		})),
	}

	return spdx
}

const lockPath = resolve("pnpm-lock.yaml")
if (!existsSync(lockPath)) {
	console.error("pnpm-lock.yaml not found. Run from project root.", { lockPath })
	process.exit(1)
}

const lockContent = readFileSync(lockPath, "utf-8")
const deps = parsePnpmLock(lockContent)
const spdx = generateSPDX(deps)

const outPath = resolve(`bom-${new Date().toISOString().slice(0, 10)}.spdx.json`)
writeFileSync(outPath, JSON.stringify(spdx, null, 2))
console.log(`SBOM written to ${outPath} (${deps.length} packages)`)
