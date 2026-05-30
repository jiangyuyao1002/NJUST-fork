import type { Language } from "@njust-ai/types"

import { LANGUAGES } from "@shared/language"

import { cn } from "@src/lib/utils"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

type LanguageSwitcherProps = {
	className?: string
	variant?: "full" | "compact"
	value: Language
	onValueChange: (lang: Language) => void
}

/**
 * Controlled language selector. Persist by including `language` in settings Save / `updateSettings`.
 */
export function LanguageSwitcher({ className, variant = "full", value, onValueChange }: LanguageSwitcherProps) {
	const { t } = useAppTranslation()
	const current = value || "en"

	const handleChange = (v: string) => {
		onValueChange(v as Language)
	}

	const label = t("settings:appearance.language.label")

	const control = (
		<Select value={current} onValueChange={handleChange}>
			<SelectTrigger
				className={cn(
					variant === "compact" ? "h-8 w-[min(100%,9rem)]" : "w-full",
				)}>
				<SelectValue placeholder={t("settings:common.select")} />
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					{(Object.keys(LANGUAGES) as Language[]).map((code) => (
						<SelectItem key={code} value={code}>
							{LANGUAGES[code]}
							<span className="text-muted-foreground"> ({code})</span>
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	)

	if (variant === "compact") {
		return (
			<div className={cn("flex items-center gap-2 min-w-0", className)}>
				<span className="text-xs text-vscode-descriptionForeground shrink-0">{label}</span>
				{control}
			</div>
		)
	}

	return (
		<div className={cn("flex flex-col gap-1", className)}>
			<label className="text-xs text-vscode-descriptionForeground">{label}</label>
			{control}
		</div>
	)
}
