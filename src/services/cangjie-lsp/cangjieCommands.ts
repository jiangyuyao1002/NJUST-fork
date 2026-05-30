import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { NJUST_AI_CONFIG_DIR } from "@njust-ai-cj/types"
import { invalidateCangjieContextSectionCache } from "../../core/prompts/sections/cangjie-context"
import {
	LEARNED_FIXES_FILE,
	ensureLearnedFixesFile,
	getLearnedFixesJsonPath,
	loadLearnedFixes,
	saveLearnedFixes,
} from "../../core/prompts/sections/learnedFixesStorage"
import { inferCangjiePackageFromSrcLayout } from "./cangjieSourceLayout"
import {
	registerGeneratedCangjieTestFile,
	purgeAllTrackedCangjieTestFiles,
} from "./cangjieGeneratedTestCleanup"
import {
	resolveCangjieToolPath,
	buildCangjieToolEnv,
	formatCangjieToolchainReport,
	probeCangjieToolchain,
} from "./cangjieToolUtils"
import { Package } from "../../shared/package"
import type { CangjieLspClient } from "./CangjieLspClient"
import { CangjieTemplateLibrary } from "./CangjieTemplateLibrary"
import { CangjieProfiler } from "./CangjieProfiler"
import { CangjieRefactoringProvider } from "./CangjieRefactoringProvider"
import type { CangjieSymbolIndex } from "./CangjieSymbolIndex"

interface CjpmCommandDef {
	id: string
	label: string
	cjpmArg: string
}

const CJPM_COMMANDS: CjpmCommandDef[] = [
	{ id: "njust-ai.cangjieBuild", label: "Cangjie: Build (cjpm build)", cjpmArg: "build" },
	{ id: "njust-ai.cangjieRun", label: "Cangjie: Run (cjpm run)", cjpmArg: "run" },
	{ id: "njust-ai.cangjieTest", label: "Cangjie: Test (cjpm test)", cjpmArg: "test" },
	{ id: "njust-ai.cangjieCheck", label: "Cangjie: Check (cjpm check)", cjpmArg: "check" },
	{ id: "njust-ai.cangjieClean", label: "Cangjie: Clean (cjpm clean)", cjpmArg: "clean" },
]

function findCjpmRoot(): string | undefined {
	const folders = vscode.workspace.workspaceFolders
	if (!folders) return undefined

	for (const folder of folders) {
		const tomlPath = path.join(folder.uri.fsPath, "cjpm.toml")
		if (fs.existsSync(tomlPath)) {
			return folder.uri.fsPath
		}
	}

	return folders[0]?.uri.fsPath
}

function sanitizeCangjieTestSymbolBase(base: string): string {
	const s = base.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "")
	return s.length > 0 ? s : "module"
}

function resolveTestFilePath(sourceUri: vscode.Uri, base: string, folder: vscode.WorkspaceFolder | undefined): string {
	const sourceDir = path.dirname(sourceUri.fsPath)
	if (!folder) return path.join(sourceDir, `${base}_test.cj`)

	const testRoot = path.join(folder.uri.fsPath, "test")
	const srcDir = path.join(folder.uri.fsPath, "src")
	if (fs.existsSync(testRoot) && fs.statSync(testRoot).isDirectory()) {
		const normSrc = srcDir.replace(/\\/g, "/").toLowerCase()
		const normSourceDir = sourceDir.replace(/\\/g, "/").toLowerCase()
		if (normSourceDir.startsWith(normSrc + "/") || normSourceDir === normSrc) {
			const rel = path.relative(srcDir, sourceDir)
			if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
				const testSubDir = rel && rel !== "." ? path.join(testRoot, rel) : testRoot
				if (!fs.existsSync(testSubDir)) {
					fs.mkdirSync(testSubDir, { recursive: true })
				}
				return path.join(testSubDir, `${base}_test.cj`)
			}
		}
	}
	return path.join(sourceDir, `${base}_test.cj`)
}

/** If primary path is co-located, return mirror path under test/ when it differs; else undefined. */
function mirroredTestPathUnderTestDir(
	sourceUri: vscode.Uri,
	base: string,
	folder: vscode.WorkspaceFolder,
	primaryResolved: string,
): string | undefined {
	const testRoot = path.join(folder.uri.fsPath, "test")
	const srcDir = path.join(folder.uri.fsPath, "src")
	const sourceDir = path.dirname(sourceUri.fsPath)
	if (!fs.existsSync(testRoot) || !fs.statSync(testRoot).isDirectory()) return undefined

	const normSrc = srcDir.replace(/\\/g, "/").toLowerCase()
	const normSourceDir = sourceDir.replace(/\\/g, "/").toLowerCase()
	if (!normSourceDir.startsWith(normSrc + "/") && normSourceDir !== normSrc) return undefined

	const rel = path.relative(srcDir, sourceDir)
	if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined

	const testSub = rel && rel !== "." ? path.join(testRoot, rel) : testRoot
	const mirrored = path.join(testSub, `${base}_test.cj`)
	if (path.normalize(mirrored) === path.normalize(primaryResolved)) return undefined
	return mirrored
}

function parseCangjiePackageDecl(content: string): string | undefined {
	const m = content.match(/^\s*package\s+([\w.]+)\s*$/m)
	return m?.[1]
}

const MAX_EXTRACT_SYMBOLS = 5

function extractPublicSymbols(source: string): string[] {
	const names: string[] = []
	const seen = new Set<string>()
	const add = (n: string) => {
		if (!n || n === "main" || n.startsWith("test_") || seen.has(n)) return
		seen.add(n)
		names.push(n)
	}

	let match: RegExpExecArray | null
	const funcDecl = /(?:^|\n)\s*(?:public|open|protected|internal)\s+func\s+(\w+)\s*\(/g
	while ((match = funcDecl.exec(source)) !== null) add(match[1]!)

	const classDecl = /(?:^|\n)\s*(?:public|open)\s+class\s+(\w+)/g
	while ((match = classDecl.exec(source)) !== null) add(match[1]!)

	const structDecl = /(?:^|\n)\s*(?:public|open)\s+struct\s+(\w+)/g
	while ((match = structDecl.exec(source)) !== null) add(match[1]!)

	const ifaceDecl = /(?:^|\n)\s*(?:public|open)\s+interface\s+(\w+)/g
	while ((match = ifaceDecl.exec(source)) !== null) add(match[1]!)

	const topFunc = /(?:^|\n)func\s+(\w+)\s*\(/g
	while ((match = topFunc.exec(source)) !== null) add(match[1]!)

	return names.slice(0, MAX_EXTRACT_SYMBOLS)
}

function hasTestableCangjieExports(source: string): boolean {
	if (/\b(public|open)\s+(func|class|struct|interface)\b/.test(source)) return true
	if (/^func\s+\w+/m.test(source)) return true
	const substantive = source
		.split(/\r?\n/)
		.filter((l) => {
			const t = l.trim()
			return t.length > 0 && !t.startsWith("//") && !t.startsWith("package ") && !t.startsWith("import ")
		})
	return substantive.length >= 2
}

function testClassNameFromBase(safe: string): string {
	if (!safe) return "GeneratedTest"
	return safe.charAt(0).toUpperCase() + safe.slice(1) + "Test"
}

function buildCangjieTestFileBody(safe: string, symbols: string[]): string {
	if (symbols.length === 0) {
		return (
			`\t@TestCase\n` +
			`\tfunc test_${safe}_smoke() {\n` +
			`\t\t@Assert(1 + 1 == 2)\n` +
			`\t}\n`
		)
	}
	return symbols
		.map(
			(sym) =>
				`\t@TestCase\n` +
				`\tfunc test_${sym}() {\n` +
				`\t\t// TODO: exercise ${sym}\n` +
				`\t\t@Assert(1 + 1 == 2)\n` +
				`\t}\n`,
		)
		.join("\n")
}

async function runCangjieGenerateTestFile(
	getCurrentTaskId: (() => string | undefined) | undefined,
	uri?: vscode.Uri,
): Promise<void> {
	let targetUri = uri
	if (!targetUri && vscode.window.activeTextEditor?.document.languageId === "cangjie") {
		targetUri = vscode.window.activeTextEditor.document.uri
	}
	if (!targetUri?.fsPath.endsWith(".cj")) {
		vscode.window.showWarningMessage("请在仓颉 .cj 源文件上执行此命令。")
		return
	}
	const base = path.basename(targetUri.fsPath, ".cj")
	if (base.endsWith("_test")) {
		vscode.window.showInformationMessage("当前文件已是 *_test.cj 测试文件。")
		return
	}

	const folder = vscode.workspace.getWorkspaceFolder(targetUri)
	let srcContent = ""
	try {
		const srcDoc = await vscode.workspace.openTextDocument(targetUri)
		srcContent = srcDoc.getText()
	} catch {
		vscode.window.showErrorMessage("无法读取源文件内容。")
		return
	}

	if (!hasTestableCangjieExports(srcContent)) {
		vscode.window.showInformationMessage("源文件暂无可测试的函数或类型声明。")
		return
	}

	const testPath = resolveTestFilePath(targetUri, base, folder)

	if (folder) {
		const mirrored = mirroredTestPathUnderTestDir(targetUri, base, folder, testPath)
		if (mirrored && fs.existsSync(mirrored) && path.normalize(mirrored) !== path.normalize(testPath)) {
			const choice = await vscode.window.showWarningMessage(
				`测试文件已存在于 test/ 目录：${path.relative(folder.uri.fsPath, mirrored)}`,
				"打开",
				"仍然生成",
				"取消",
			)
			if (choice === "打开") {
				const doc = await vscode.workspace.openTextDocument(mirrored)
				await vscode.window.showTextDocument(doc)
				return
			}
			if (choice !== "仍然生成") return
		}
	}

	if (fs.existsSync(testPath)) {
		const choice = await vscode.window.showWarningMessage(
			`测试文件已存在：${path.basename(testPath)}`,
			"打开",
			"取消",
		)
		if (choice === "打开") {
			const doc = await vscode.workspace.openTextDocument(testPath)
			await vscode.window.showTextDocument(doc)
		}
		return
	}

	const testUri = vscode.Uri.file(testPath)
	const srcPkg = parseCangjiePackageDecl(srcContent) ?? inferCangjiePackageFromSrcLayout(targetUri)
	const testPkg = inferCangjiePackageFromSrcLayout(testUri)

	let pkgPrefix = ""
	if (testPkg) {
		pkgPrefix = `package ${testPkg}\n\n`
	} else {
		const first = srcContent.split(/\r?\n/).find((l) => l.trim().startsWith("package "))
		if (first?.trim().startsWith("package ")) {
			pkgPrefix = `${first.trim()}\n\n`
		}
	}

	let sourceImport = ""
	if (srcPkg && testPkg && srcPkg !== testPkg) {
		sourceImport = `import ${srcPkg}.*\n`
	}

	const safe = sanitizeCangjieTestSymbolBase(base)
	const symbols = extractPublicSymbols(srcContent)
	const className = testClassNameFromBase(safe)
	const body = buildCangjieTestFileBody(safe, symbols)

	const content =
		pkgPrefix +
		sourceImport +
		"import std.unittest.*\n" +
		"import std.unittest.testmacro.*\n\n" +
		"@Test\n" +
		`class ${className} {\n` +
		body +
		"}\n"

	fs.writeFileSync(testPath, content, "utf-8")
	registerGeneratedCangjieTestFile(getCurrentTaskId?.(), testPath)
	const doc = await vscode.workspace.openTextDocument(testPath)
	await vscode.window.showTextDocument(doc)
}

function runCjpmCommand(cjpmArg: string): void {
	const cjpmPath = resolveCangjieToolPath("cjpm", "cangjieTools.cjpmPath")
	if (!cjpmPath) {
		void vscode.window
			.showErrorMessage(
				"未找到 cjpm：请设置 CANGJIE_HOME / PATH，或在设置中配置 njust-ai.cangjieTools.cjpmPath。",
				"打开设置",
			)
			.then((c) => {
				if (c === "打开设置") {
					void vscode.commands.executeCommand("workbench.action.openSettings", `${Package.name}.cangjieTools.cjpmPath`)
				}
			})
		return
	}

	const cwd = findCjpmRoot()
	if (!cwd) {
		vscode.window.showErrorMessage("No workspace folder open.")
		return
	}

	const terminal = vscode.window.createTerminal({
		name: `cjpm ${cjpmArg}`,
		cwd,
		env: buildCangjieToolEnv() as Record<string, string>,
	})
	terminal.show()
	const cmd = process.platform === "win32"
		? `& "${cjpmPath}" ${cjpmArg}`
		: `"${cjpmPath}" ${cjpmArg}`
	terminal.sendText(cmd)
}

export function registerCangjieCommands(
	context: vscode.ExtensionContext,
	lspClient: CangjieLspClient,
	symbolIndex?: CangjieSymbolIndex,
	getCurrentTaskId?: () => string | undefined,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieVerifySdk", async () => {
			const ch = vscode.window.createOutputChannel("Cangjie SDK Verify")
			ch.show(true)
			ch.appendLine("正在检测 cjc / cjpm / cjfmt / cjlint …")
			const probes = await probeCangjieToolchain()
			ch.appendLine(formatCangjieToolchainReport(probes))
			ch.appendLine("\n检测完成。若某项失败，请检查 SDK 安装路径与扩展设置中的 cangjieTools.* / cangjieLsp.cjcPath。")
			if (!probes.every((p) => p.ok)) {
				void vscode.window.showWarningMessage("部分仓颉工具不可用，详见「Cangjie SDK Verify」输出通道。")
			} else {
				void vscode.window.showInformationMessage("仓颉工具链检测全部通过。")
			}
		}),
	)

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (!doc.uri.fsPath.endsWith(LEARNED_FIXES_FILE)) return
			const norm = doc.uri.fsPath.replace(/\\/g, "/")
			if (!norm.includes(`/${NJUST_AI_CONFIG_DIR}/`)) return
			invalidateCangjieContextSectionCache()
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieViewLearnedFixes", async () => {
			const cwd = findCjpmRoot()
			if (!cwd) {
				vscode.window.showErrorMessage("未找到含 cjpm.toml 的工作区项目。")
				return
			}
			ensureLearnedFixesFile(cwd)
			const fileUri = vscode.Uri.file(getLearnedFixesJsonPath(cwd))
			const textDoc = await vscode.workspace.openTextDocument(fileUri)
			await vscode.window.showTextDocument(textDoc)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieManageLearnedFixes", async () => {
			const cwd = findCjpmRoot()
			if (!cwd) {
				vscode.window.showErrorMessage("未找到含 cjpm.toml 的工作区项目。")
				return
			}
			const data = loadLearnedFixes(cwd)
			if (data.patterns.length === 0) {
				vscode.window.showInformationMessage(
					"当前暂无 learned-fixes 条目。编译错误修复成功后会自动写入 .njust_ai/learned-fixes.json。",
				)
				return
			}

			type Pick = vscode.QuickPickItem & { index: number }
			const items: Pick[] = data.patterns.map((p, i) => ({
				label: p.errorPattern.length > 72 ? p.errorPattern.slice(0, 72) + "…" : p.errorPattern,
				description:
					p.fix.length > 0 ? (p.fix.length > 48 ? p.fix.slice(0, 48) + "…" : p.fix) : "（尚无 fix）",
				index: i,
			}))
			const sel = await vscode.window.showQuickPick(items, { placeHolder: "选择一条 learned-fix 记录" })
			if (!sel) return

			const op = await vscode.window.showQuickPick(["编辑修复说明", "删除此条目"], {
				placeHolder: "选择操作",
			})
			if (!op) return

			const idx = sel.index
			if (op === "删除此条目") {
				data.patterns.splice(idx, 1)
				saveLearnedFixes(cwd, data)
				invalidateCangjieContextSectionCache()
				vscode.window.showInformationMessage("已删除该条目。")
				return
			}

			const cur = data.patterns[idx]!
			const next = await vscode.window.showInputBox({
				title: "编辑修复说明",
				value: cur.fix,
				prompt: "写入后保存到 learned-fixes.json",
			})
			if (next === undefined) return
			cur.fix = next.slice(0, 1000)
			saveLearnedFixes(cwd, data)
			invalidateCangjieContextSectionCache()
			vscode.window.showInformationMessage("已更新 learned-fixes。")
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieGenerateTestFile", (resource?: vscode.Uri) =>
			runCangjieGenerateTestFile(getCurrentTaskId, resource),
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieCleanGeneratedTests", () => {
			const { filesRemoved, taskEntriesRemoved } = purgeAllTrackedCangjieTestFiles()
			if (taskEntriesRemoved > 0) {
				void vscode.window.showInformationMessage(
					`已清空 ${taskEntriesRemoved} 个登记桶，删除磁盘文件 ${filesRemoved} 个。`,
				)
			} else {
				void vscode.window.showInformationMessage("没有需要清理的已登记生成测试文件。")
			}
		}),
	)

	for (const cmd of CJPM_COMMANDS) {
		context.subscriptions.push(
			vscode.commands.registerCommand(cmd.id, () => runCjpmCommand(cmd.cjpmArg)),
		)
	}

	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieRestartLsp", async () => {
			vscode.window.showInformationMessage("Restarting Cangjie Language Server…")
			await lspClient.restart()
			vscode.window.showInformationMessage("Cangjie Language Server restarted.")
		}),
	)

	// ── Template Library ──
	const templateLibrary = new CangjieTemplateLibrary()
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieInsertTemplate", () =>
			templateLibrary.showTemplatePicker(),
		),
	)

	// ── Profiler ──
	const outputChannel = vscode.window.createOutputChannel("Cangjie Profiler")
	const profiler = new CangjieProfiler(outputChannel)
	context.subscriptions.push(profiler)
	context.subscriptions.push(
		vscode.commands.registerCommand("njust-ai.cangjieProfile", async () => {
			const cwd = findCjpmRoot()
			if (!cwd) {
				vscode.window.showErrorMessage("No cjpm project found.")
				return
			}
			const result = await profiler.profile(cwd)
			if (result.success) {
				profiler.applyHeatMap(result)
				await profiler.showProfileSummary(result)
			} else {
				vscode.window.showErrorMessage(`Profiling failed: ${result.output.slice(0, 200)}`)
			}
		}),
	)

	// ── Refactoring ──
	if (symbolIndex) {
		const refactoring = new CangjieRefactoringProvider(symbolIndex)
		context.subscriptions.push(
			vscode.languages.registerCodeActionsProvider(
				{ language: "cangjie", scheme: "file" },
				refactoring,
				{ providedCodeActionKinds: CangjieRefactoringProvider.providedCodeActionKinds },
			),
		)
		context.subscriptions.push(
			vscode.commands.registerCommand(
				"njust-ai.cangjieExtractFunction",
				(doc: vscode.TextDocument, range: vscode.Range) =>
					refactoring.extractFunction(doc, range),
			),
		)
		context.subscriptions.push(
			vscode.commands.registerCommand("njust-ai.cangjieMoveFile", async () => {
				const editor = vscode.window.activeTextEditor
				if (editor?.document.fileName.endsWith(".cj")) {
					await refactoring.moveFile(editor.document.uri)
				} else {
					vscode.window.showWarningMessage("请先打开一个 .cj 文件")
				}
			}),
		)
	}
}
