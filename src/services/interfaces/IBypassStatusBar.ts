import type * as vscode from "vscode"

/**
 * VS Code 状态栏指示器接口：当权限模式为 bypass 时显示常驻警告。
 */
export interface IBypassStatusBar extends vscode.Disposable {
	update(permissionMode: "default" | "bypass"): void
	show(): void
	hide(): void
}
