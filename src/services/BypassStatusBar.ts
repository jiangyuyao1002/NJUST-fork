import * as vscode from "vscode"
import { t } from "../i18n"

/**
 * VS Code 状态栏指示器：当权限模式为 bypass 时显示常驻警告。
 * 优先级 48，排在 CangjieLspStatusBar (50, 49) 之后。
 */
export class BypassStatusBar implements vscode.Disposable {
	private item: vscode.StatusBarItem

	constructor() {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48)
		this.item.name = "NJUST-AI Bypass Mode"
		this.item.command = "njust-ai.toggleAutoApprove"
		this.item.tooltip = t("tooltips.bypass_mode_enabled")
		this.hide()
	}

	update(permissionMode: "default" | "bypass"): void {
		if (permissionMode === "bypass") {
			this.item.text = "$(shield) Bypass"
			this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
			this.show()
		} else {
			this.hide()
		}
	}

	show(): void {
		this.item.show()
	}

	hide(): void {
		this.item.hide()
	}

	dispose(): void {
		this.item.dispose()
	}
}
