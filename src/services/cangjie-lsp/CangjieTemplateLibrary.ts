import * as vscode from "vscode"
import * as fs from "fs"
import { t } from "../../i18n"

export interface CangjieTemplate {
	id: string
	title: string
	category: CangjieTemplateCategory
	description: string
	/** Parameterized template body. Use `{{paramName}}` for placeholders. */
	body: string
	params: TemplateParam[]
}

export interface TemplateParam {
	name: string
	label: string
	defaultValue: string
}

export type CangjieTemplateCategory =
	| "executable"
	| "library"
	| "http-server"
	| "cli-tool"
	| "data-processing"
	| "testing"
	| "concurrency"

// ---------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------

const BUILTIN_TEMPLATES: CangjieTemplate[] = [
	{
		id: "exec-hello",
		title: t("templates.cangjie.hello_world_title"),
		category: "executable",
		description: t("templates.cangjie.hello_world_desc"),
		body: `package {{packageName}}

import std.console.*

main(): Int64 {
    println("Hello, {{projectName}}!")
    return 0
}
`,
		params: [
			{ name: "packageName", label: t("templates.cangjie.params.package_name"), defaultValue: "my_app" },
			{ name: "projectName", label: t("templates.cangjie.params.project_name"), defaultValue: "Cangjie" },
		],
	},
	{
		id: "http-server",
		title: t("templates.cangjie.http_server_title"),
		category: "http-server",
		description: t("templates.cangjie.http_server_desc"),
		body: `package {{packageName}}

import std.net.*
import std.io.*
import std.console.*

main(): Int64 {
    let server = ServerSocket({{port}})
    println("Listening on port {{port}}…")
    while (true) {
        let client = server.accept()
        spawn {
            handleClient(client)
        }
    }
    return 0
}

func handleClient(client: Socket): Unit {
    // This is a template placeholder - actual implementation would read request and write response
    // The socket is closed after template generation to allow users to fill in their own logic
    client.close()
}
`,
		params: [
			{ name: "packageName", label: t("templates.cangjie.params.package_name"), defaultValue: "my_server" },
			{ name: "port", label: t("templates.cangjie.params.port"), defaultValue: "8080" },
		],
	},
	{
		id: "cli-tool",
		title: t("templates.cangjie.cli_tool_title"),
		category: "cli-tool",
		description: t("templates.cangjie.cli_tool_desc"),
		body: `package {{packageName}}

import std.console.*
import std.env.*

main(): Int64 {
    let args = getArgs()
    if (args.size < 2) {
        println("Usage: {{toolName}} <command>")
        return 1
    }
    let command = args[1]
    match (command) {
        case "help" => printHelp()
        case _ => println("Unknown command: \\(command)")
    }
    return 0
}

func printHelp(): Unit {
    println("{{toolName}} - A Cangjie CLI tool")
    println("Commands:")
    println("  help    Show this help message")
}
`,
		params: [
			{ name: "packageName", label: t("templates.cangjie.params.package_name"), defaultValue: "my_cli" },
			{ name: "toolName", label: t("templates.cangjie.params.tool_name"), defaultValue: "mytool" },
		],
	},
	{
		id: "unittest",
		title: t("templates.cangjie.unit_test_title"),
		category: "testing",
		description: t("templates.cangjie.unit_test_desc"),
		body: `package {{packageName}}

import std.unittest.*
import std.unittest.testmacro.*

@Test
class {{testClassName}} {
    @TestCase
    func testExample() {
        @Assert(1 + 1 == 2)
    }

    @TestCase
    func testStringContains() {
        let s = "Hello, Cangjie"
        @Assert(s.contains("Cangjie"))
    }
}
`,
		params: [
			{ name: "packageName", label: t("templates.cangjie.params.package_name"), defaultValue: "my_app" },
			{ name: "testClassName", label: t("templates.cangjie.params.test_class_name"), defaultValue: "MyTest" },
		],
	},
	{
		id: "data-processing",
		title: t("templates.cangjie.data_processing_title"),
		category: "data-processing",
		description: t("templates.cangjie.data_processing_desc"),
		body: `package {{packageName}}

import std.collection.*
import std.console.*

main(): Int64 {
    var items = ArrayList<String>()
    items.append("alpha")
    items.append("beta")
    items.append("gamma")

    var counts = HashMap<String, Int64>()
    for (item in items) {
        counts[item] = (counts.getOrDefault(item, 0)) + 1
    }

    for ((k, v) in counts) {
        println("\\(k): \\(v)")
    }
    return 0
}
`,
		params: [{ name: "packageName", label: t("templates.cangjie.params.package_name"), defaultValue: "my_app" }],
	},
	{
		id: "concurrency-mutex",
		title: t("templates.cangjie.concurrency_title"),
		category: "concurrency",
		description: t("templates.cangjie.concurrency_desc"),
		body: `package {{packageName}}

import std.sync.*
import std.console.*
import std.time.*

main(): Int64 {
    let mutex = ReentrantMutex()
    var counter = 0

    let threads = ArrayList<Thread>()
    for (_ in 0..{{threadCount}}) {
        let t = spawn {
            for (_ in 0..1000) {
                mutex.lock()
                counter++
                mutex.unlock()
            }
        }
        threads.append(t)
    }
    for (t in threads) {
        t.join()
    }
    println("Counter: \\(counter)")
    return 0
}
`,
		params: [
			{ name: "packageName", label: t("templates.cangjie.params.package_name"), defaultValue: "my_app" },
			{ name: "threadCount", label: t("templates.cangjie.params.thread_count"), defaultValue: "4" },
		],
	},
	{
		id: "static-library",
		title: t("templates.cangjie.static_lib_title"),
		category: "library",
		description: t("templates.cangjie.static_lib_desc"),
		body: `package {{packageName}}

public class {{className}} {
    private var _value: {{valueType}}

    public init(value: {{valueType}}) {
        _value = value
    }

    public func getValue(): {{valueType}} {
        return _value
    }

    public func setValue(v: {{valueType}}): Unit {
        _value = v
    }
}
`,
		params: [
			{ name: "packageName", label: t("templates.cangjie.params.package_name"), defaultValue: "my_lib" },
			{ name: "className", label: t("templates.cangjie.params.class_name"), defaultValue: "MyService" },
			{ name: "valueType", label: t("templates.cangjie.params.value_type"), defaultValue: "String" },
		],
	},
]

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CangjieTemplateLibrary {
	private templates: CangjieTemplate[] = [...BUILTIN_TEMPLATES]

	/**
	 * Load additional templates from a JSON file (project-local customization).
	 */
	loadFromFile(filePath: string): void {
		try {
			if (!fs.existsSync(filePath)) return
			const raw = fs.readFileSync(filePath, "utf-8")
			const parsed = JSON.parse(raw) as { templates?: CangjieTemplate[] }
			if (Array.isArray(parsed.templates)) {
				this.templates.push(...parsed.templates)
			}
		} catch {
			// intentionally ignored: malformed template files
		}
	}

	getAll(): CangjieTemplate[] {
		return this.templates
	}

	getByCategory(category: CangjieTemplateCategory): CangjieTemplate[] {
		return this.templates.filter((t) => t.category === category)
	}

	getById(id: string): CangjieTemplate | undefined {
		return this.templates.find((t) => t.id === id)
	}

	/**
	 * Instantiate a template with the given parameter values.
	 */
	render(template: CangjieTemplate, values: Record<string, string>): string {
		let result = template.body
		for (const param of template.params) {
			const value = values[param.name] ?? param.defaultValue
			result = result.replace(new RegExp(`\\{\\{${param.name}\\}\\}`, "g"), value)
		}
		return result
	}

	/**
	 * Show a quick-pick to select and instantiate a template, then insert into editor.
	 */
	async showTemplatePicker(): Promise<void> {
		const items = this.templates.map((t) => ({
			label: t.title,
			description: `[${t.category}]`,
			detail: t.description,
			template: t,
		}))

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: t("placeholders.select_cangjie_template"),
			matchOnDescription: true,
			matchOnDetail: true,
		})

		if (!selected) return

		const values: Record<string, string> = {}
		for (const param of selected.template.params) {
			const value = await vscode.window.showInputBox({
				prompt: param.label,
				value: param.defaultValue,
			})
			if (value === undefined) return // cancelled
			values[param.name] = value
		}

		const code = this.render(selected.template, values)

		const editor = vscode.window.activeTextEditor
		if (editor) {
			await editor.edit((editBuilder) => {
				editBuilder.insert(editor.selection.active, code)
			})
		} else {
			const doc = await vscode.workspace.openTextDocument({
				language: "cangjie",
				content: code,
			})
			await vscode.window.showTextDocument(doc)
		}
	}
}
