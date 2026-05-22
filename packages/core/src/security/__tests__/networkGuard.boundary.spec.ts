import { describe, expect, it } from "vitest"

import { assertPublicIp } from "../networkGuard.js"

describe("networkGuard", () => {
	describe("assertPublicIp", () => {
		it("allows public IPv4", () => {
			expect(() => assertPublicIp("93.184.216.34")).not.toThrow()
		})

		it("rejects private IPv4 ranges", () => {
			expect(() => assertPublicIp("127.0.0.1")).toThrow()
			expect(() => assertPublicIp("10.0.0.1")).toThrow()
			expect(() => assertPublicIp("192.168.1.1")).toThrow()
			expect(() => assertPublicIp("172.16.0.1")).toThrow()
		})

		it("rejects localhost IPv6", () => {
			expect(() => assertPublicIp("::1")).toThrow()
		})

		it("rejects IPv6 mapped private addresses", () => {
			expect(() => assertPublicIp("::ffff:192.168.1.1")).toThrow()
			expect(() => assertPublicIp("::ffff:127.0.0.1")).toThrow()
		})

		it("rejects link-local IPv6", () => {
			expect(() => assertPublicIp("fe80::1")).toThrow()
		})

		it("rejects multicast addresses", () => {
			expect(() => assertPublicIp("224.0.0.1")).toThrow()
			expect(() => assertPublicIp("ff02::1")).toThrow()
		})
	})
})
