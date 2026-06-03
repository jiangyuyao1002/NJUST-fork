import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import process from "node:process"
import * as console from "node:console"

import { copyPaths, copyWasms, copyLocales, setupLocaleWatcher } from "@njust-ai/build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
	const name = "extension"
	const production = process.argv.includes("--production")
	const watch = process.argv.includes("--watch")
	const minify = production
	const sourcemap = true // Always generate source maps for error handling.

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const buildOptions = {
		bundle: true,
		minify,
		sourcemap,
		logLevel: "silent",
		format: "cjs",
		sourcesContent: false,
		platform: "node",
		...(production ? { drop: ["console"] } : {}),
	}

	const srcDir = __dirname
	const buildDir = __dirname
	const distDir = path.join(buildDir, "dist")

	if (fs.existsSync(distDir)) {
		console.log(`[${name}] Cleaning dist directory: ${distDir}`)
		fs.rmSync(distDir, { recursive: true, force: true })
	}

	/**
	 * @type {import('esbuild').Plugin[]}
	 */
	const plugins = [
		{
			// Deduplicate pdf-parse: it ships 4 pdf.js versions via dynamic
			// require(`./pdf.js/${options.version}/build/pdf.js`), but only
			// v1.10.100 is ever used (hardcoded default). We intercept the
			// pdf-parse.js source and replace the dynamic require with a
			// static path to save ~6 MB in the bundle.
			name: "deduplicate-pdf-parse",
			setup(build) {
				const KEEP_VERSION = "v1.10.100"
				build.onLoad({ filter: /pdf-parse[/\\]lib[/\\]pdf-parse\.js$/ }, async (args) => {
					const contents = await fs.promises.readFile(args.path, "utf-8")
					// Replace the dynamic require template literal with a static path
					const patched = contents.replace(
						/require\(`\.\/pdf\.js\/\$\{options\.version\}\/build\/pdf\.js`\)/,
						`require("./pdf.js/${KEEP_VERSION}/build/pdf.js")`,
					)
					return { contents: patched, loader: "js" }
				})
			},
		},
		{
			name: "copyFiles",
			setup(build) {
				build.onEnd(() => {
					copyPaths(
						[
							["../README.md", "README.md"],
							["../CHANGELOG.md", "CHANGELOG.md"],
							["../LICENSE", "LICENSE"],
							["node_modules/vscode-material-icons/generated", "assets/vscode-material-icons"],
							["../webview-ui/audio", "webview-ui/audio"],
							["../webview-ui/build", "webview-ui/build"],
						],
						srcDir,
						buildDir,
					)
				})
			},
		},
		{
			name: "copyWasms",
			setup(build) {
				build.onEnd(() => copyWasms(srcDir, distDir))
			},
		},
		{
			name: "copyLocales",
			setup(build) {
				build.onEnd(() => copyLocales(srcDir, distDir))
			},
		},
		{
			name: "esbuild-problem-matcher",
			setup(build) {
				build.onStart(() => console.log("[esbuild-problem-matcher#onStart]"))
				build.onEnd((result) => {
					result.errors.forEach(({ text, location }) => {
						console.error(`✘ [ERROR] ${text}`)
						if (location && location.file) {
							console.error(`    ${location.file}:${location.line}:${location.column}:`)
						}
					})

					console.log("[esbuild-problem-matcher#onEnd]")
				})
			},
		},
	]

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const extensionConfig = {
		...buildOptions,
		plugins,
		metafile: true,
		entryPoints: ["extension.ts"],
		outfile: "dist/extension.js",
		// global-agent must be external because it dynamically patches Node.js http/https modules
		// which breaks when bundled. It needs access to the actual Node.js module instances.
		// undici must be bundled because our VSIX is packaged with `--no-dependencies`.
		external: ["vscode", "esbuild", "global-agent"],
	}

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const workerConfig = {
		...buildOptions,
		entryPoints: ["workers/countTokens.ts"],
		outdir: "dist/workers",
	}

	const [extensionCtx, workerCtx] = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(workerConfig),
	])

	if (watch) {
		await Promise.all([extensionCtx.watch(), workerCtx.watch()])
		copyLocales(srcDir, distDir)
		setupLocaleWatcher(srcDir, distDir)
	} else {
		const [extensionResult] = await Promise.all([extensionCtx.rebuild(), workerCtx.rebuild()])

		// Write metafile for bundle analysis
		if (extensionResult.metafile) {
			const metafilePath = path.join(distDir, "metafile.json")
			fs.writeFileSync(metafilePath, JSON.stringify(extensionResult.metafile))
			const analysis = await esbuild.analyzeMetafile(extensionResult.metafile, { verbose: false })
			console.log(`\n[${name}] Bundle analysis:\n${analysis}\n`)
		}

		await Promise.all([extensionCtx.dispose(), workerCtx.dispose()])
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
