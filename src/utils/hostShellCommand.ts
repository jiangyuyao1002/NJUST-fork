import os from "os"
import process from "process"

/**
 * CMD and PowerShell on Windows do not treat `./program` as "run program in cwd" — they try to execute
 * `.` as a command. Rewrite `./` → `.\` at segment boundaries. Skipped for bash/sh/WSL/Git-Bash shells
 * where `./` is valid.
 */
export function normalizeDotSlashCommandForWindowsShell(command: string, execaShellPath: string | undefined): string {
	if (process.platform !== "win32") {
		return command
	}
	if (execaShellPath) {
		const normalized = execaShellPath.toLowerCase().replace(/\\/g, "/")
		if (
			normalized.includes("bash") ||
			normalized.includes("/bin/sh") ||
			normalized.includes("wsl") ||
			normalized.includes("msys") ||
			normalized.includes("cygwin") ||
			normalized.includes("git-bash")
		) {
			return command
		}
	}
	return command.replace(/(^|[\s;]|&&|\|\||\|)\.\//g, "$1.\\")
}

/**
 * Short OS-specific compile/run guidance injected into environment_details so the model picks
 * appropriate execute_command strings for the actual host.
 */
export function formatHostExecuteCommandHints(): string {
	const platform = process.platform
	const arch = process.arch
	const type = os.type()
	const release = os.release()

	const lines: string[] = [
		`Tailor **compile and run** commands to this host (execute_command):`,
		``,
		`- **Detected OS**: ${type} — Node platform \`${platform}\`, arch \`${arch}\`, release \`${release}\``,
	]

	if (platform === "win32") {
		lines.push(
			`- **Default shells**: Integrated terminal often uses **cmd.exe** or **PowerShell** (unless the user set Git Bash / WSL as the automation shell).`,
			`- **Run binaries in cwd**: Prefer \`program.exe\` or \`.\\program.exe\`, not Unix-style \`./program\` (cmd does not support \`./\`). This extension may auto-correct \`./\` for default Windows shells.`,
			`- **GCC / MinGW**: e.g. \`gcc main.c -o main.exe\` then \`main.exe\` or \`.\\main.exe\`.`,
			`- **MSVC** (Developer Command Prompt): \`cl main.c\` then \`main.exe\`.`,
			`- **Python**: \`python script.py\` (same pattern as on Unix).`,
		)
	} else if (platform === "darwin") {
		lines.push(
			`- **C/C++**: e.g. \`clang main.c -o main && ./main\` or \`gcc main.c -o main && ./main\`.`,
			`- **Run**: \`./binary\` for executables built in the current directory.`,
		)
	} else {
		lines.push(
			`- **C/C++**: e.g. \`gcc main.c -o main && ./main\`.`,
			`- **Run**: \`./binary\` for build outputs; use \`chmod +x\` for scripts when needed.`,
		)
	}

	return lines.join("\n")
}
