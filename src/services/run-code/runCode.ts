import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import * as shellQuote from "shell-quote"
import { resolveCangjieToolPath, buildCangjieToolEnv, CJC_CONFIG_KEY } from "../cangjie-lsp/cangjieToolUtils"
import { buildMatlabRunConfig } from "../matlab/matlabRunner"
import { resolveMatlabRuntime } from "../matlab/matlabToolUtils"
import { Package } from "../../shared/package"
import { resolveLatexmkExecutable, resolvePdflatexExecutable } from "../latex/latexResolve"
import { t } from "../../i18n"

interface RunConfig {
	command: string
	cwd?: string
	env?: Record<string, string>
}

const isWin = process.platform === "win32"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect shell metacharacters that could lead to command injection.
 * These characters can break out of quoted strings or execute arbitrary commands.
 */
function containsShellMetacharacters(p: string): boolean {
	return /[&|;<>()$`!\n\r]/.test(p)
}

/**
 * Quote a file path for safe use in shell commands.
 * Uses double quotes with escaping for special characters.
 * This prevents shell injection while ensuring the command works on both platforms.
 * If the path contains shell metacharacters that cannot be safely escaped, an error is thrown.
 */
function quotePath(p: string): string {
	if (containsShellMetacharacters(p)) {
		throw new Error(
			`File path contains shell metacharacters and cannot be safely executed: ${p}. ` +
				`Please rename the file to remove special characters like &, |, ;, <, >, $, \`, !.`,
		)
	}
	// Escape double quotes and backticks to prevent breaking out of the quoted string.
	const escaped = p.replace(/"/g, '\\"').replace(/`/g, "\\`")
	return `"${escaped}"`
}

/**
 * Chain multiple shell commands with short-circuit on failure.
 * On Windows (cmd.exe) uses `&&`; on POSIX uses `&&`.
 * The terminal is opened with cmd.exe on Windows so `&&` is always valid.
 */
function chain(...cmds: string[]): string {
	return cmds.join(" && ")
}

function findProjectRoot(startDir: string, markers: string[]): string | undefined {
	let dir = startDir
	const root = path.parse(dir).root
	while (true) {
		for (const marker of markers) {
			if (fs.existsSync(path.join(dir, marker))) {
				return dir
			}
		}
		const parent = path.dirname(dir)
		if (parent === dir || parent === root) {
			break
		}
		dir = parent
	}
	return undefined
}

function listSourceFiles(dir: string, extensions: string[]): string[] {
	try {
		return fs.readdirSync(dir).filter((f) => {
			const ext = path.extname(f).toLowerCase()
			return extensions.includes(ext) && fs.statSync(path.join(dir, f)).isFile()
		})
	} catch {
		return []
	}
}

function exeName(base: string): string {
	return isWin ? `${base}.exe` : `./${base}`
}

// ---------------------------------------------------------------------------
// Per-language run config builders
// ---------------------------------------------------------------------------

function buildPythonConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)

	const pyprojectRoot = findProjectRoot(fileDir, ["pyproject.toml"])
	if (pyprojectRoot) {
		if (fs.existsSync(path.join(pyprojectRoot, "poetry.lock"))) {
			return { command: `poetry run python ${quotePath(filePath)}`, cwd: pyprojectRoot }
		}
		return { command: `python ${quotePath(filePath)}`, cwd: pyprojectRoot }
	}

	if (fs.existsSync(path.join(fileDir, "__main__.py"))) {
		const pkgDir = path.dirname(fileDir)
		const pkgName = path.basename(fileDir)
		return { command: `python -m ${pkgName}`, cwd: pkgDir }
	}

	return { command: `python ${quotePath(filePath)}` }
}

function buildJavaScriptConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)
	const pkgRoot = findProjectRoot(fileDir, ["package.json"])

	if (pkgRoot) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8"))
			if (pkg.scripts?.start) {
				return { command: "npm start", cwd: pkgRoot }
			}
			if (pkg.scripts?.dev) {
				return { command: "npm run dev", cwd: pkgRoot }
			}
		} catch {
			// intentionally ignored: package.json read failure
		}
	}

	return { command: `node ${quotePath(filePath)}` }
}

function buildTypeScriptConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)
	const pkgRoot = findProjectRoot(fileDir, ["package.json"])

	if (pkgRoot) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf-8"))
			if (pkg.scripts?.start) {
				return { command: "npm start", cwd: pkgRoot }
			}
			if (pkg.scripts?.dev) {
				return { command: "npm run dev", cwd: pkgRoot }
			}
		} catch {
			// intentionally ignored: package.json read failure
		}
	}

	return { command: `npx tsx ${quotePath(filePath)}` }
}

function buildCConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)

	const cmakeRoot = findProjectRoot(fileDir, ["CMakeLists.txt"])
	if (cmakeRoot) {
		const bd = path.join(cmakeRoot, "build")
		return {
			command: chain(
				`cmake -S ${quotePath(cmakeRoot)} -B ${quotePath(bd)}`,
				`cmake --build ${quotePath(bd)}`,
				`cmake --build ${quotePath(bd)} --target run`,
			),
			cwd: cmakeRoot,
		}
	}

	const makeRoot = findProjectRoot(fileDir, ["Makefile", "makefile", "GNUmakefile"])
	if (makeRoot) {
		return { command: chain("make", "make run"), cwd: makeRoot }
	}

	const base = path.basename(filePath, ".c")
	const cFiles = listSourceFiles(fileDir, [".c"])
	const cFilesQuoted = cFiles.map(quotePath)
	if (cFiles.length > 1) {
		const out = exeName(base)
		return { command: chain(`gcc ${cFilesQuoted.join(" ")} -o ${quotePath(out)}`, quotePath(out)), cwd: fileDir }
	}
	const out = exeName(base)
	return {
		command: chain(`gcc ${quotePath(path.basename(filePath))} -o ${quotePath(out)}`, quotePath(out)),
		cwd: fileDir,
	}
}

function buildCppConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)

	const cmakeRoot = findProjectRoot(fileDir, ["CMakeLists.txt"])
	if (cmakeRoot) {
		const bd = path.join(cmakeRoot, "build")
		return {
			command: chain(
				`cmake -S ${quotePath(cmakeRoot)} -B ${quotePath(bd)}`,
				`cmake --build ${quotePath(bd)}`,
				`cmake --build ${quotePath(bd)} --target run`,
			),
			cwd: cmakeRoot,
		}
	}

	const makeRoot = findProjectRoot(fileDir, ["Makefile", "makefile", "GNUmakefile"])
	if (makeRoot) {
		return { command: chain("make", "make run"), cwd: makeRoot }
	}

	const base = path.basename(filePath, path.extname(filePath))
	const cppFiles = listSourceFiles(fileDir, [".cpp", ".cc", ".cxx"])
	const cppFilesQuoted = cppFiles.map(quotePath)
	if (cppFiles.length > 1) {
		const out = exeName(base)
		return {
			command: chain(`g++ ${cppFilesQuoted.join(" ")} -o ${quotePath(out)}`, quotePath(out)),
			cwd: fileDir,
		}
	}
	const out = exeName(base)
	return {
		command: chain(`g++ ${quotePath(path.basename(filePath))} -o ${quotePath(out)}`, quotePath(out)),
		cwd: fileDir,
	}
}

function buildJavaConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)

	const mavenRoot = findProjectRoot(fileDir, ["pom.xml"])
	if (mavenRoot) {
		const mvn = isWin ? "mvn.cmd" : "mvn"
		return { command: chain(`${mvn} compile`, `${mvn} exec:java`), cwd: mavenRoot }
	}

	const gradleRoot = findProjectRoot(fileDir, ["build.gradle", "build.gradle.kts"])
	if (gradleRoot) {
		const wrapper = isWin ? "gradlew.bat" : "./gradlew"
		const cmd = fs.existsSync(path.join(gradleRoot, isWin ? "gradlew.bat" : "gradlew")) ? wrapper : "gradle"
		return { command: `${cmd} run`, cwd: gradleRoot }
	}

	const className = path.basename(filePath, ".java")
	const javaFiles = listSourceFiles(fileDir, [".java"])
	const javaFilesQuoted = javaFiles.map(quotePath)
	if (javaFiles.length > 1) {
		return { command: chain(`javac ${javaFilesQuoted.join(" ")}`, `java ${quotePath(className)}`), cwd: fileDir }
	}

	return {
		command: chain(`javac ${quotePath(path.basename(filePath))}`, `java ${quotePath(className)}`),
		cwd: fileDir,
	}
}

function buildGoConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)

	const goModRoot = findProjectRoot(fileDir, ["go.mod"])
	if (goModRoot) {
		const relDir = path.relative(goModRoot, fileDir) || "."
		return { command: `go run ./${relDir.replace(/\\/g, "/")}`, cwd: goModRoot }
	}

	const goFiles = listSourceFiles(fileDir, [".go"])
	if (goFiles.length > 1) {
		return { command: "go run .", cwd: fileDir }
	}

	return { command: `go run ${quotePath(filePath)}` }
}

function buildRustConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)

	const cargoRoot = findProjectRoot(fileDir, ["Cargo.toml"])
	if (cargoRoot) {
		return { command: "cargo run", cwd: cargoRoot }
	}

	const base = path.basename(filePath, ".rs")
	const out = exeName(base)
	return { command: chain(`rustc ${quotePath(filePath)} -o ${quotePath(out)}`, quotePath(out)), cwd: fileDir }
}

function buildMatlabConfig(filePath: string, _workDir: string): RunConfig | undefined {
	const ext = path.extname(filePath).toLowerCase()
	if (ext === ".mlx") {
		void vscode.window.showWarningMessage(t("errors.run_code.matlab_live_script_unsupported"))
		return undefined
	}
	const c = buildMatlabRunConfig(filePath)
	if (!c) {
		if (ext === ".m") {
			if (!resolveMatlabRuntime()) {
				void vscode.window.showErrorMessage(t("errors.run_code.matlab_not_detected"))
			} else {
				void vscode.window.showWarningMessage("Failed to generate run command for this file.")
			}
		}
		return undefined
	}
	return c
}

function buildCangjieConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)
	const env = buildCangjieToolEnv()

	const cjpmRoot = findProjectRoot(fileDir, ["cjpm.toml"])
	if (cjpmRoot) {
		const cjpm = resolveCangjieToolPath("cjpm", "cangjieTools.cjpmPath") || "cjpm"
		const cmd = isWin ? `& ${quotePath(cjpm)} run` : `${quotePath(cjpm)} run`
		return { command: cmd, cwd: cjpmRoot, env }
	}

	const cjc = resolveCangjieToolPath("cjc", CJC_CONFIG_KEY) || "cjc"
	const base = path.basename(filePath, ".cj")
	const cjFiles = listSourceFiles(fileDir, [".cj"])
	const cjFilesQuoted = cjFiles.map(quotePath)
	if (cjFiles.length > 1) {
		const out = exeName(base)
		return {
			command: chain(`${quotePath(cjc)} ${cjFilesQuoted.join(" ")} -o ${quotePath(out)}`, quotePath(out)),
			cwd: fileDir,
			env,
		}
	}
	const out = exeName(base)
	return {
		command: chain(`${quotePath(cjc)} ${quotePath(path.basename(filePath))} -o ${quotePath(out)}`, quotePath(out)),
		cwd: fileDir,
		env,
	}
}

function buildKotlinConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)

	const gradleRoot = findProjectRoot(fileDir, ["build.gradle", "build.gradle.kts"])
	if (gradleRoot) {
		const wrapper = isWin ? "gradlew.bat" : "./gradlew"
		const cmd = fs.existsSync(path.join(gradleRoot, isWin ? "gradlew.bat" : "gradlew")) ? wrapper : "gradle"
		return { command: `${cmd} run`, cwd: gradleRoot }
	}

	const base = path.basename(filePath, ".kt")
	const ktFiles = listSourceFiles(fileDir, [".kt"])
	const ktFilesQuoted = ktFiles.map(quotePath)
	if (ktFiles.length > 1) {
		return {
			command: chain(
				`kotlinc ${ktFilesQuoted.join(" ")} -include-runtime -d ${quotePath(base + ".jar")}`,
				`java -jar ${quotePath(base + ".jar")}`,
			),
			cwd: fileDir,
		}
	}

	return {
		command: chain(
			`kotlinc ${quotePath(path.basename(filePath))} -include-runtime -d ${quotePath(base + ".jar")}`,
			`java -jar ${quotePath(base + ".jar")}`,
		),
		cwd: fileDir,
	}
}

function buildDartConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)
	const pubRoot = findProjectRoot(fileDir, ["pubspec.yaml"])
	return { command: `dart run ${quotePath(filePath)}`, cwd: pubRoot || fileDir }
}

function buildSwiftConfig(filePath: string): RunConfig {
	const fileDir = path.dirname(filePath)

	const spmRoot = findProjectRoot(fileDir, ["Package.swift"])
	if (spmRoot) {
		return { command: "swift run", cwd: spmRoot }
	}

	const swiftFiles = listSourceFiles(fileDir, [".swift"])
	const swiftFilesQuoted = swiftFiles.map(quotePath)
	if (swiftFiles.length > 1) {
		const base = path.basename(filePath, ".swift")
		const out = exeName(base)
		return {
			command: chain(`swiftc ${swiftFilesQuoted.join(" ")} -o ${quotePath(out)}`, quotePath(out)),
			cwd: fileDir,
		}
	}

	return { command: `swift ${quotePath(filePath)}` }
}

/**
 * LaTeX: compile to PDF in the same directory as the .tex file (default tool output location).
 * Uses `njust-ai.latex.*` settings (same as command LaTeX: Compile local).
 */
function buildLatexConfig(filePath: string, _workDir: string): RunConfig {
	const cwd = path.dirname(filePath)
	const base = path.basename(filePath)
	const cfg = vscode.workspace.getConfiguration(Package.name)
	const engine = (cfg.get<string>("latex.engine") ?? "latexmk").toLowerCase()
	const extra = cfg.get<string[]>("latex.extraArgs") ?? []

	const quoteArg = (a: string) => shellQuote.quote([a])

	if (engine === "latexmk") {
		const bin = quoteArg(resolveLatexmkExecutable(cfg.get<string>("latex.latexmkPath")))
		const args = [
			"-pdf",
			"-interaction=nonstopmode",
			"-file-line-error",
			"-synctex=1",
			...extra.map(quoteArg),
			quoteArg(base),
		]
		return { command: `${bin} ${args.join(" ")}`, cwd }
	}

	const bin = quoteArg(resolvePdflatexExecutable(cfg.get<string>("latex.pdflatexPath")))
	const args = ["-interaction=nonstopmode", "-file-line-error", "-synctex=1", ...extra.map(quoteArg), quoteArg(base)]
	return { command: `${bin} ${args.join(" ")}`, cwd }
}

// ---------------------------------------------------------------------------
// Language → builder mapping
// ---------------------------------------------------------------------------

type RunConfigBuilder = (filePath: string, workDir: string) => RunConfig | undefined

const LANGUAGE_RUN_MAP: Record<string, RunConfigBuilder> = {
	python: buildPythonConfig,
	javascript: buildJavaScriptConfig,
	typescript: buildTypeScriptConfig,
	c: buildCConfig,
	cpp: buildCppConfig,
	java: buildJavaConfig,
	go: buildGoConfig,
	rust: buildRustConfig,
	cangjie: buildCangjieConfig,
	kotlin: buildKotlinConfig,
	dart: buildDartConfig,
	swift: buildSwiftConfig,
	ruby: (fp) => ({ command: `ruby ${quotePath(fp)}` }),
	php: (fp) => ({ command: `php ${quotePath(fp)}` }),
	shellscript: (fp) => ({ command: `bash ${quotePath(fp)}` }),
	powershell: (fp) => ({ command: `powershell -ExecutionPolicy Bypass -File ${quotePath(fp)}` }),
	lua: (fp) => ({ command: `lua ${quotePath(fp)}` }),
	perl: (fp) => ({ command: `perl ${quotePath(fp)}` }),
	r: (fp) => ({ command: `Rscript ${quotePath(fp)}` }),
	matlab: buildMatlabConfig,
	latex: buildLatexConfig,
	tex: buildLatexConfig,
}

// ---------------------------------------------------------------------------
// Extension → language
// ---------------------------------------------------------------------------

const EXT_TO_LANGUAGE: Record<string, string> = {
	".py": "python",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".ts": "typescript",
	".mts": "typescript",
	".tsx": "typescript",
	".c": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".java": "java",
	".go": "go",
	".rs": "rust",
	".cj": "cangjie",
	".rb": "ruby",
	".php": "php",
	".sh": "shellscript",
	".bash": "shellscript",
	".ps1": "powershell",
	".lua": "lua",
	".pl": "perl",
	".r": "r",
	".R": "r",
	".swift": "swift",
	".kt": "kotlin",
	".kts": "kotlin",
	".dart": "dart",
	".tex": "latex",
	".ltx": "latex",
}

function detectLanguage(document: vscode.TextDocument): string | undefined {
	const vscodeLang = document.languageId
	if (vscodeLang === "objective-c" && path.extname(document.fileName).toLowerCase() === ".m") {
		return undefined
	}
	if (LANGUAGE_RUN_MAP[vscodeLang]) {
		return vscodeLang
	}
	const ext = path.extname(document.fileName).toLowerCase()
	if (ext === ".m" || ext === ".mlx") {
		return "matlab"
	}
	return EXT_TO_LANGUAGE[ext]
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runActiveEditorCode(outputChannel: vscode.OutputChannel): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		vscode.window.showWarningMessage("No active editor found. Please open a code file first.")
		return
	}

	const document = editor.document

	if (document.isUntitled) {
		vscode.window.showWarningMessage("Please save the file before running.")
		return
	}

	await vscode.workspace.saveAll(false)

	const language = detectLanguage(document)
	if (!language) {
		vscode.window.showWarningMessage(
			`Unsupported file type: ${path.extname(document.fileName) || document.languageId}`,
		)
		return
	}

	const builder = LANGUAGE_RUN_MAP[language]
	if (!builder) {
		vscode.window.showWarningMessage(`Unsupported language: ${language}`)
		return
	}

	const filePath = document.fileName
	const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(filePath)
	let config: RunConfig | undefined
	try {
		config = builder(filePath, workDir)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		vscode.window.showErrorMessage(`Run Code failed: ${message}`)
		return
	}
	if (!config) {
		if (language !== "matlab") {
			vscode.window.showWarningMessage("Failed to generate run command for this file.")
		}
		return
	}

	const cwd = config.cwd || workDir
	const needsCmd = isWin && config.command.includes("&&")

	outputChannel.appendLine(`[Run Code] Language: ${language}, CWD: ${cwd}, Command: ${config.command}`)

	const terminal = vscode.window.createTerminal({
		name: `Run: ${path.basename(filePath)}`,
		cwd,
		env: config.env,
		shellPath: needsCmd ? "cmd.exe" : undefined,
	})
	terminal.show()
	terminal.sendText(config.command)
}
