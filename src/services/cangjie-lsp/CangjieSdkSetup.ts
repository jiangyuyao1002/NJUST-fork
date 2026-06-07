import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { execFile } from "child_process"
import { promisify } from "util"
import { Package } from "../../shared/package"
import { detectCangjieHome, formatCangjieToolchainSummaryLine } from "./cangjieToolUtils"
import { t } from "../../i18n"

const execFileAsync = promisify(execFile)
const DISMISSED_KEY = "cangjie.sdkSetupDismissed"
const DOWNLOAD_URL = "https://cangjie-lang.cn/download"

async function validateSdk(sdkPath: string): Promise<string | undefined> {
	const exeName = process.platform === "win32" ? "cjc.exe" : "cjc"
	const candidates = [path.join(sdkPath, "bin", exeName), path.join(sdkPath, "tools", "bin", exeName)]

	for (const cjcPath of candidates) {
		if (!fs.existsSync(cjcPath)) continue
		try {
			const { stdout } = await execFileAsync(cjcPath, ["--version"], { timeout: 10_000 })
			const version = stdout.trim().split("\n")[0]
			return version || "unknown version"
		} catch {
			continue
		}
	}
	return undefined
}

async function configureSdkPath(sdkPath: string): Promise<void> {
	const config = vscode.workspace.getConfiguration(Package.name)
	const lspExe = process.platform === "win32" ? "LSPServer.exe" : "LSPServer"
	const lspCandidates = [path.join(sdkPath, "bin", lspExe), path.join(sdkPath, "tools", "bin", lspExe)]
	const lspPath = lspCandidates.find((p) => fs.existsSync(p))
	if (lspPath) {
		await config.update("cangjieLsp.serverPath", lspPath, vscode.ConfigurationTarget.Global)
	}
}

async function promptManualSelect(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	const uris = await vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		openLabel: t("dialogs.select_cangjie_sdk_dir"),
	})

	if (!uris || uris.length === 0) return

	const selectedPath = uris[0]!.fsPath
	const version = await validateSdk(selectedPath)

	if (version) {
		await configureSdkPath(selectedPath)
		vscode.window.showInformationMessage(t("info.cangjie_sdk_configured", { version }))
		outputChannel.appendLine(`[CangjieSdkSetup] SDK configured at ${selectedPath} (${version})`)
		void formatCangjieToolchainSummaryLine().then((line) => {
			if (line) {
				const verifyLabel = t("buttons.verify_toolchain")
				vscode.window.showInformationMessage(line, verifyLabel).then((c) => {
					if (c === verifyLabel) void vscode.commands.executeCommand("njust-ai.cangjieVerifySdk")
				})
			}
		})
	} else {
		const reselectLabel = t("buttons.reselect")
		const cancelLabel = t("buttons.cancel")
		const retry = await vscode.window.showWarningMessage(
			t("warnings.cangjie_cjc_not_found"),
			reselectLabel,
			cancelLabel,
		)
		if (retry === reselectLabel) {
			await promptManualSelect(context, outputChannel)
		}
	}
}

const QUICK_START_KEY = "cangjie.quickStartNudgeShown"

export async function checkAndPromptSdkSetup(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	const config = vscode.workspace.getConfiguration(Package.name)
	const configuredServerPath = config.get<string>("cangjieLsp.serverPath", "")
	if (configuredServerPath && fs.existsSync(configuredServerPath)) {
		if (!context.globalState.get<boolean>(QUICK_START_KEY)) {
			await context.globalState.update(QUICK_START_KEY, true)
			void formatCangjieToolchainSummaryLine().then((line) => {
				const msg = line ?? t("info.cangjie_lsp_ready")
				const steps = t("info.cangjie_quick_start")
				const verifyLabel = t("buttons.verify_toolchain")
				void vscode.window.showInformationMessage(`${msg}\n${steps}`, verifyLabel).then((c) => {
					if (c === verifyLabel) void vscode.commands.executeCommand("njust-ai.cangjieVerifySdk")
				})
			})
		}
		return
	}

	if (context.globalState.get<boolean>(DISMISSED_KEY)) {
		return
	}

	const detectedHome = detectCangjieHome()

	if (detectedHome) {
		const version = await validateSdk(detectedHome)
		const label = version ? `（${version}）` : ""

		const yesLabel = t("answers.yes")
		const manualSelectLabel = t("buttons.manual_select")
		const dismissLabel = t("buttons.dismiss")
		const choice = await vscode.window.showInformationMessage(
			t("info.cangjie_sdk_detected", { path: detectedHome, version: label }),
			yesLabel,
			manualSelectLabel,
			dismissLabel,
		)

		if (choice === yesLabel) {
			await configureSdkPath(detectedHome)
			vscode.window.showInformationMessage(t("info.cangjie_sdk_auto_configured", { version: label }))
			outputChannel.appendLine(`[CangjieSdkSetup] Auto-configured SDK at ${detectedHome} ${label}`)
			void formatCangjieToolchainSummaryLine().then((line) => {
				if (line) {
					const verifyLabel = t("buttons.verify_toolchain")
					vscode.window.showInformationMessage(line, verifyLabel).then((c) => {
						if (c === verifyLabel) void vscode.commands.executeCommand("njust-ai.cangjieVerifySdk")
					})
				}
			})
		} else if (choice === manualSelectLabel) {
			await promptManualSelect(context, outputChannel)
		} else {
			await context.globalState.update(DISMISSED_KEY, true)
		}
	} else {
		const selectDirLabel = t("buttons.select_sdk_dir")
		const downloadLabel = t("buttons.download_sdk")
		const laterLabel = t("buttons.later")
		const choice = await vscode.window.showWarningMessage(
			t("warnings.cangjie_sdk_not_detected"),
			selectDirLabel,
			downloadLabel,
			laterLabel,
		)

		if (choice === selectDirLabel) {
			await promptManualSelect(context, outputChannel)
		} else if (choice === downloadLabel) {
			vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL))
		} else {
			await context.globalState.update(DISMISSED_KEY, true)
		}
	}
}
