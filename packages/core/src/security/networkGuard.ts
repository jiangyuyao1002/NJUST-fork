import dns from "node:dns/promises"
import net from "node:net"

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost."])

function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split(".").map((p) => Number.parseInt(p, 10))
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
		return true
	}
	const a = parts[0]!
	const b = parts[1]!
	if (a === 10) return true
	if (a === 127) return true
	if (a === 0) return true
	if (a === 169 && b === 254) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 192 && b === 168) return true
	if (a >= 224) return true // multicast + reserved
	return false
}

function isBlockedIPv6(ip: string): boolean {
	const normalized = ip.toLowerCase()
	if (normalized === "::1") return true
	if (normalized === "::") return true
	if (normalized.startsWith("fe80:")) return true // link-local
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true // unique-local
	if (normalized.startsWith("ff")) return true // multicast
	if (normalized.startsWith("::ffff:")) {
		const mapped = normalized.replace(/^::ffff:/, "")
		if (net.isIP(mapped) === 4 && isPrivateIPv4(mapped)) {
			return true
		}
	}
	return false
}

export function assertPublicIp(ip: string): void {
	const ipVersion = net.isIP(ip)
	if (ipVersion === 4) {
		if (isPrivateIPv4(ip)) {
			throw new Error(`Blocked private or non-routable IPv4 address: ${ip}`)
		}
		return
	}
	if (ipVersion === 6) {
		if (isBlockedIPv6(ip)) {
			throw new Error(`Blocked private or non-routable IPv6 address: ${ip}`)
		}
		return
	}
	throw new Error(`Invalid IP address: ${ip}`)
}

function assertHostnameAllowed(hostname: string): void {
	const lower = hostname.trim().toLowerCase()
	if (!lower) {
		throw new Error("URL hostname is empty.")
	}
	if (BLOCKED_HOSTNAMES.has(lower) || lower.endsWith(".local")) {
		throw new Error(`Blocked local hostname: ${hostname}`)
	}
}

export async function assertSafeOutboundUrl(url: string): Promise<URL> {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new Error(`Invalid URL: ${url}`)
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Only HTTP/HTTPS URLs are allowed. Got: ${parsed.protocol}`)
	}

	assertHostnameAllowed(parsed.hostname)

	const hostIpVersion = net.isIP(parsed.hostname)
	if (hostIpVersion !== 0) {
		assertPublicIp(parsed.hostname)
		return parsed
	}

	const lookedUp = await dns.lookup(parsed.hostname, { all: true, verbatim: true })
	if (!lookedUp.length) {
		throw new Error(`Could not resolve host: ${parsed.hostname}`)
	}

	for (const entry of lookedUp) {
		assertPublicIp(entry.address)
	}

	return parsed
}

export async function guardedFetch(url: string, init?: RequestInit): Promise<Response> {
	const parsed = await assertSafeOutboundUrl(url)

	// IP pinning: resolve once, then connect directly to the verified IP.
	// This prevents DNS rebinding attacks where a second resolution returns
	// a different (potentially internal) address. We set the Host header so
	// the server can still route correctly with the pinned IP.
	if (net.isIP(parsed.hostname) !== 0) {
		// Already an IP literal — public-IP check was done in assertSafeOutboundUrl
		return fetch(parsed.toString(), init)
	}

	const resolved = await dns.lookup(parsed.hostname, { all: true, verbatim: true })
	if (!resolved.length) {
		throw new Error(`Could not resolve host: ${parsed.hostname}`)
	}
	for (const entry of resolved) {
		assertPublicIp(entry.address)
	}

	// Pin to the first resolved public IP
	const pinnedIp = resolved[0]!.address
	const ipUrl = new URL(parsed.toString())
	ipUrl.hostname = net.isIP(pinnedIp) === 6 ? `[${pinnedIp}]` : pinnedIp

	const headers = new Headers(init?.headers)
	if (!headers.has("Host")) {
		headers.set("Host", parsed.hostname)
	}

	return fetch(ipUrl.toString(), { ...init, headers })
}
