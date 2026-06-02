import React, { Component } from "react"
import { withTranslation, WithTranslation } from "react-i18next"
import { enhanceErrorWithSourceMaps } from "@src/utils/sourceMapUtils"
import { vscode } from "@src/utils/vscode"

type ErrorProps = {
	children: React.ReactNode
	fallback?: (error: string, componentStack: string | null) => React.ReactNode
} & WithTranslation

type ErrorState = {
	hasError: boolean
	error?: string
	componentStack?: string | null
	timestamp?: number
}

class ErrorBoundary extends Component<ErrorProps, ErrorState> {
	constructor(props: ErrorProps) {
		super(props)
		this.state = { hasError: false }
	}

	static getDerivedStateFromError(_error: unknown) {
		return {
			hasError: true,
			timestamp: Date.now(),
		}
	}

	async componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		const componentStack = errorInfo.componentStack || ""
		const enhancedError = await enhanceErrorWithSourceMaps(error, componentStack)
		const finalError = enhancedError.sourceMappedStack || enhancedError.stack || ""
		const finalStack = enhancedError.sourceMappedComponentStack || componentStack

		try {
			vscode.postMessage({
				type: "webviewError",
				text: finalError,
				context: finalStack,
			})
		} catch (e) {
			console.error("Failed to report webviewError to host:", e)
		}

		this.setState({
			hasError: true,
			error: finalError,
			componentStack: finalStack,
		})
	}

	render() {
		const { t, fallback } = this.props

		if (this.state.hasError && !this.state.error) {
			if (fallback) {
				return fallback("Loading error details...", null)
			}
			return (
				<div>
					<p className="text-sm opacity-70">{t("errorBoundary.title")}...</p>
				</div>
			)
		}

		if (!this.state.hasError) {
			return this.props.children
		}

		if (fallback) {
			return fallback(this.state.error as string, this.state.componentStack ?? null)
		}

		const errorDisplay = this.state.error
		const componentStackDisplay = this.state.componentStack

		const version = process.env.PKG_VERSION || "unknown"

		return (
			<div>
				<h2 className="text-lg font-bold mt-0 mb-2">
					{t("errorBoundary.title")} (v{version})
				</h2>
				<p className="mb-4">
					{t("errorBoundary.reportText")}{" "}
					<a href="https://github.com/NJUST-AI/NJUST_AI/issues" target="_blank" rel="noreferrer">
						{t("errorBoundary.githubText")}
					</a>
				</p>
				<p className="mb-2">{t("errorBoundary.copyInstructions")}</p>

				<div className="mb-4">
					<h3 className="text-md font-bold mb-1">{t("errorBoundary.errorStack")}</h3>
					<pre className="p-2 border rounded text-sm overflow-auto">{errorDisplay}</pre>
				</div>

				{componentStackDisplay && (
					<div>
						<h3 className="text-md font-bold mb-1">{t("errorBoundary.componentStack")}</h3>
						<pre className="p-2 border rounded text-sm overflow-auto">{componentStackDisplay}</pre>
					</div>
				)}
				<div className="mt-4 flex gap-2">
					<button
						onClick={() => this.setState({ hasError: false, error: undefined, componentStack: undefined })}
						className="px-3 py-1.5 bg-vscode-button-background hover:bg-vscode-button-hoverBackground text-vscode-button-foreground rounded text-sm">
						Retry
					</button>
				</div>
			</div>
		)
	}
}

export default withTranslation("common")(ErrorBoundary)
