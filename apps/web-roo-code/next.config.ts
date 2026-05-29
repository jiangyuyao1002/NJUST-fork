import path from "path"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
	transpilePackages: ["@njust-ai-cj/types"],
	turbopack: {
		root: path.join(__dirname, "../.."),
	},
	async redirects() {
		return [
			// Redirect www to non-www
			{
				source: "/:path*",
				has: [{ type: "host", value: "www.njust-ai-cj.local" }],
				destination: "https://njust-ai-cj.local/:path*",
				permanent: true,
			},
			// Redirect HTTP to HTTPS
			{
				source: "/:path*",
				has: [{ type: "header", key: "x-forwarded-proto", value: "http" }],
				destination: "https://njust-ai-cj.local/:path*",
				permanent: true,
			},
			// Redirect cloud waitlist to Notion page (kept for extension compatibility)
			{
				source: "/cloud-waitlist",
				destination: "https://roo-code.notion.site/238fd1401b0a8087b858e1ad431507cf?pvs=105",
				permanent: false,
			},
			{
				source: "/provider/pricing",
				destination: "/provider",
				permanent: true,
			},
		]
	},
}

export default nextConfig
