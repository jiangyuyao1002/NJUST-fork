import type { Metadata } from "next"

import { ThemeProvider, ReactQueryProvider } from "@/components/providers"
import { Toaster } from "@/components/ui"
import { Header } from "@/components/layout/header"

import "./globals.css"

export const metadata: Metadata = {
	title: "NJUST_AI_CJ Evals",
}

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode
}>) {
	return (
		<html lang="en">
			<body className="font-sans antialiased pb-12">
				<ThemeProvider attribute="class" forcedTheme="dark" disableTransitionOnChange>
					<ReactQueryProvider>
						<Header />
						{children}
					</ReactQueryProvider>
				</ThemeProvider>
				<Toaster />
			</body>
		</html>
	)
}
