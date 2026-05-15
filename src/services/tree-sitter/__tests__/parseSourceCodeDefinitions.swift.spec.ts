// npx vitest services/tree-sitter/__tests__/parseSourceCodeDefinitions.swift.spec.ts

import { it, expect, vi, beforeEach, beforeAll } from "vitest"

import { swiftQuery } from "../queries"
import { initializeTreeSitter, testParseSourceCodeDefinitions } from "./helpers"

const runSwiftTreeSitterTests = process.env.RUN_SWIFT_TREE_SITTER_TESTS === "1"

const sampleSwiftContent = String.raw`
class StandardClassDefinition {
    private var standardProperty: String
    func standardMethod() -> String {
        return standardProperty
    }
}

final class FinalClassDefinition {
    func finalClassMethod() -> Int {
        return 1
    }
}

open class OpenClassDefinition {
    open func openOverridableMethod() -> Double {
        return 1.0
    }
}

protocol ProtocolDefinition {
    var protocolRequiredProperty: String { get set }
    func protocolRequiredMethod(with parameter: String) -> Bool
}

class InheritingClassDefinition: StandardClassDefinition, ProtocolDefinition {
    var protocolRequiredProperty: String = "Required property"
    func protocolRequiredMethod(with parameter: String) -> Bool {
        return !parameter.isEmpty
    }
}

struct StandardStructDefinition {
    var standardStructProperty: String
}

struct GenericStructDefinition<T: Comparable, U> {
    var items: [T]
    var mappings: [T: U]
}

protocol AssociatedTypeProtocolDefinition {
    associatedtype AssociatedItem
    var items: [AssociatedItem] { get set }
}

extension StandardClassDefinition {
    func classExtensionMethod() -> String {
        return "class"
    }
}

extension StandardStructDefinition {
    func structExtensionMethod() -> String {
        return "struct"
    }
}

extension ProtocolDefinition {
    func protocolExtensionMethod() -> String {
        return "protocol"
    }
}

class MethodContainer {
    func instanceMethodDefinition(parameter1: String) -> String {
        return parameter1
    }
}

struct TypeMethodContainer {
    static func typeMethodDefinition(parameter1: String) -> String {
        return parameter1
    }
}

class StoredPropertyContainer {
    var storedPropertyWithObserver: Int = 0 {
        willSet { }
        didSet { }
    }
}

class ComputedPropertyContainer {
    var computedProperty: String {
        get { return "" }
        set { }
    }
}

class DesignatedInitializerContainer {
    init(property1: String) { }
}

class ConvenienceInitializerContainer {
    init(property1: String, property2: Int) { }
    convenience init(defaultsWithOverride: String = "Default") {
        self.init(property1: defaultsWithOverride, property2: 42)
    }
}

class DeinitializerDefinition {
    deinit { }
}

class SubscriptDefinition {
    subscript(index: Int) -> String {
        get { return "" }
        set { }
    }
}

class TypeAliasContainer {
    typealias DictionaryOfArrays<Key: Hashable, Value: Equatable> = [Key: [Value]]
}
`

// Swift test options
const testOptions = {
	language: "swift",
	wasmFile: "tree-sitter-swift.wasm",
	queryString: swiftQuery,
	extKey: "swift",
}

// Mock fs module
vi.mock("fs/promises")

// Mock languageParser module
vi.mock("../languageParser", () => ({
	loadRequiredLanguageParsers: vi.fn(),
}))

// Mock file existence check
vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation(() => Promise.resolve(true)),
}))

describe.skipIf(!runSwiftTreeSitterTests)("parseSourceCodeDefinitionsForFile with Swift", () => {
	// Cache the result to avoid repeated slow parsing
	let parsedResult: string | undefined

	// Run once before all tests to parse the Swift code
	beforeAll(async () => {
		await initializeTreeSitter()
		// Parse Swift code once and store the result
		parsedResult = await testParseSourceCodeDefinitions("/test/file.swift", sampleSwiftContent, testOptions)
	})

	beforeEach(() => {
		vi.clearAllMocks()
	})

	// Single test for class declarations (standard, final, open, and inheriting classes)
	it("should capture class declarations with all modifiers", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*class StandardClassDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*final class FinalClassDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*open class OpenClassDefinition/)
		expect(parsedResult).toMatch(
			/\d+--\d+ \|\s*class InheritingClassDefinition: StandardClassDefinition, ProtocolDefinition/,
		)
	})

	// Single test for struct declarations (standard and generic structs)
	it("should capture struct declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*struct StandardStructDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*struct GenericStructDefinition<T: Comparable, U>/)
	})

	// Single test for protocol declarations (basic and with associated types)
	it("should capture protocol declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*protocol ProtocolDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*protocol AssociatedTypeProtocolDefinition/)
	})

	// Single test for extension declarations (for class, struct, and protocol)
	it("should capture extension declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*extension StandardClassDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*extension StandardStructDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*extension ProtocolDefinition/)
	})

	// Single test for method declarations (instance and type methods)
	it("should capture method declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*func instanceMethodDefinition/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*static func typeMethodDefinition/)
	})

	// Single test for property declarations (stored and computed)
	it("should capture property declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*var storedPropertyWithObserver: Int = 0/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*var computedProperty: String/)
	})

	// Single test for initializer declarations (designated and convenience)
	it("should capture initializer declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*init\(/)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*convenience init\(/)
	})

	// Single test for deinitializer declarations
	it("should capture deinitializer declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*deinit/)
	})

	// Single test for subscript declarations
	it("should capture subscript declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*subscript\(/)
	})

	// Single test for type alias declarations
	it("should capture type alias declarations", async () => {
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*typealias DictionaryOfArrays</)
		expect(parsedResult).toMatch(/\d+--\d+ \|\s*class TypeAliasContainer/)
	})
})
