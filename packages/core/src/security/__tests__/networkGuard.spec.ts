import { describe, it, expect } from "vitest"
import { assertPublicIp } from "../networkGuard.js"

describe("assertPublicIp", () => {
	it("accepts a public IPv4 address", () => {
		expect(() => assertPublicIp("8.8.8.8")).not.toThrow()
	})

	it("rejects loopback 127.0.0.1", () => {
		expect(() => assertPublicIp("127.0.0.1")).toThrow()
	})

	it("rejects 10.x private range", () => {
		expect(() => assertPublicIp("10.0.0.1")).toThrow()
	})

	it("rejects 172.16.x private range", () => {
		expect(() => assertPublicIp("172.16.0.1")).toThrow()
	})

	it("rejects 192.168.x private range", () => {
		expect(() => assertPublicIp("192.168.1.1")).toThrow()
	})

	it("rejects 169.254.x link-local", () => {
		expect(() => assertPublicIp("169.254.1.1")).toThrow()
	})

	it("rejects multicast 224.x", () => {
		expect(() => assertPublicIp("224.0.0.1")).toThrow()
	})

	it("rejects IPv6 loopback ::1", () => {
		expect(() => assertPublicIp("::1")).toThrow()
	})

	it("rejects IPv6 link-local fe80:", () => {
		expect(() => assertPublicIp("fe80::1")).toThrow()
	})

	it("rejects IPv6 unique-local fc00:", () => {
		expect(() => assertPublicIp("fc00::1")).toThrow()
	})

	it("rejects IPv4-mapped private IPv6", () => {
		expect(() => assertPublicIp("::ffff:192.168.1.1")).toThrow()
	})

	it("accepts a public IPv6 address", () => {
		expect(() => assertPublicIp("2001:4860:4860::8888")).not.toThrow()
	})

	it("rejects invalid IP format", () => {
		expect(() => assertPublicIp("not-an-ip")).toThrow()
	})

	it("accepts public 172.32.x (not private range)", () => {
		expect(() => assertPublicIp("172.32.0.1")).not.toThrow()
	})
})
