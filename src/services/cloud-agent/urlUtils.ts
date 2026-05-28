/**
 * 移除 URL 末尾的斜杠，确保格式统一。
 */
export function normalizeServerUrl(url: string): string {
	return url.replace(/\/$/, "")
}
