/**
 * SSH with Password Extension
 *
 * Enables SSH remote execution with password-based authentication.
 * The password is entered by the user in the TUI (never exposed to the AI).
 * Uses sshpass under the hood for password-based SSH.
 *
 * Usage (runtime, no startup flags needed):
 *   /ssh user@host
 *   /ssh user@host:/remote/path
 *
 * Requirements:
 *   - sshpass installed on local machine: sudo apt install sshpass
 *   - bash on remote machine
 *
 * How it works:
 *   1. User types /ssh user@host in the TUI (or AI calls ssh_connect)
 *   2. A masked password prompt appears in the TUI (60s timeout)
 *   3. Password is stored in-memory only, never sent to AI
 *   4. AI gets new remote tools: ssh_bash, ssh_read, ssh_write, ssh_edit
 *   5. Built-in local tools remain fully available — AI can operate both
 *   6. User ! commands: "!ssh <cmd>" routes to remote, plain "!<cmd>" stays local
 */

import { spawn, execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── State ────────────────────────────────────────────────────────────────────

interface SshConfig {
	remote: string;
	remoteCwd: string;
}

let sshConfig: SshConfig | null = null;
let sshPassword: string | null = null;
const localCwd = process.cwd();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function checkSshpass(): string | null {
	try {
		const path = execSync("which sshpass", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
		return path || null;
	} catch {
		return null;
	}
}

function toRemotePath(localPath: string): string {
	if (!sshConfig) return localPath;
	// Match directory prefix only, not substring. /home/user must not match /home/user2.
	if (localPath === localCwd) return sshConfig.remoteCwd;
	if (localPath.startsWith(localCwd + "/")) {
		return sshConfig.remoteCwd + localPath.slice(localCwd.length);
	}
	// Path outside cwd — pass through as-is (may fail on remote, which is correct)
	return localPath;
}

function sshExec(command: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<Buffer> {
	if (!sshConfig || !sshPassword) {
		return Promise.reject(new Error("SSH not connected. The AI should call ssh_connect first, or use /ssh in the TUI."));
	}

	const timeout = opts?.timeout;
	const signal = opts?.signal;

	return new Promise((resolve, reject) => {
		// Guard: already aborted before we even spawn
		if (signal?.aborted) {
			return reject(new Error("Aborted"));
		}

		const child = spawn(
			"sshpass",
			["-e", "ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", sshConfig!.remote, command],
			{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SSHPASS: sshPassword! } },
		);

		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];

		// Timeout timer
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (timeout && timeout > 0) {
			timer = setTimeout(() => {
				child.kill();
				reject(new Error(`SSH command timed out after ${timeout}s`));
			}, timeout * 1000);
		}

		// Abort listener
		const onAbort = () => {
			child.kill();
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (data: Buffer) => chunks.push(data));
		child.stderr.on("data", (data: Buffer) => errChunks.push(data));

		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
				? "sshpass not found. Install: sudo apt install sshpass"
				: `SSH spawn failed: ${err.message}`;
			reject(new Error(msg));
		});

		child.on("close", (code, exitSignal) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);

			if (exitSignal) {
				return reject(new Error(`SSH process killed by signal ${exitSignal}`));
			}
			if (code !== 0) {
				const errText = Buffer.concat(errChunks).toString().trim();
				// Classify common failures
				if (errText.includes("Permission denied") || errText.includes("password")) {
					return reject(new Error(`SSH authentication failed: ${errText}`));
				}
				if (errText.includes("Connection refused") || errText.includes("Connection timed out") || errText.includes("No route to host")) {
					return reject(new Error(`SSH connection failed: ${errText}`));
				}
				if (errText.includes("Host key verification failed")) {
					return reject(new Error(`SSH host key changed or unknown. Run: ssh-keygen -R ${sshConfig!.remote} and retry.`));
				}
				reject(new Error(`SSH command failed (exit ${code}): ${errText}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

function requireConnected(): SshConfig {
	if (!sshConfig || !sshPassword) {
		throw new Error("Not connected to SSH. The AI should call ssh_connect first, or the user should run /ssh.");
	}
	return sshConfig;
}

// ─── Remote Operations Factories ──────────────────────────────────────────────

function createRemoteReadOps(): ReadOperations {
	return {
		readFile: (p: string) => {
			const remote = toRemotePath(p);
			return sshExec(`cat ${JSON.stringify(remote)}`);
		},
		access: (p: string) => {
			const remote = toRemotePath(p);
			return sshExec(`test -r ${JSON.stringify(remote)}`).then(
				() => {},
				() => { throw new Error(`File not accessible on remote: ${p}`); },
			);
		},
		detectImageMimeType: async (p: string) => {
			try {
				const remote = toRemotePath(p);
				const r = await sshExec(`file --mime-type -b ${JSON.stringify(remote)}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(): WriteOperations {
	return {
		writeFile: async (p: string, content: Buffer) => {
			const remote = toRemotePath(p);
			const b64 = content.toString("base64");
			await sshExec(`echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(remote)}`);
		},
		mkdir: (dir: string) => {
			const remote = toRemotePath(dir);
			return sshExec(`mkdir -p ${JSON.stringify(remote)}`).then(() => {});
		},
	};
}

function createRemoteEditOps(readOps: ReadOperations, writeOps: WriteOperations): EditOperations {
	return { readFile: readOps.readFile, access: readOps.access, writeFile: writeOps.writeFile };
}

function createRemoteBashOps(): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cfg = requireConnected();
				const remoteCmd = `cd ${JSON.stringify(toRemotePath(cwd))} && ${command}`;
				const child = spawn(
					"sshpass",
					["-e", "ssh", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", cfg.remote, remoteCmd],
					{ stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SSHPASS: sshPassword! } },
				);

				let timedOut = false;
				const timer = timeout
					? setTimeout(() => { timedOut = true; child.kill(); }, timeout * 1000)
					: undefined;

				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });

				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

// ─── Password Input Component (TUI) ───────────────────────────────────────────

const PASSWORD_TIMEOUT_SEC = 60;

function promptPassword(
	label: string,
	theme: { fg: (name: string, text: string) => string },
	tui: { requestRender: () => void },
	done: (value: string | null) => void,
) {
	let value = "";
	let cachedLines: string[] | undefined;
	const deadline = Date.now() + PASSWORD_TIMEOUT_SEC * 1000;
	let resolved = false;

	function resolve(val: string | null) {
		if (resolved) return;
		resolved = true;
		if (tickTimer) clearInterval(tickTimer);
		if (timeoutTimer) clearTimeout(timeoutTimer);
		done(val);
	}

	const tickTimer = setInterval(() => tui.requestRender(), 500);
	const timeoutTimer = setTimeout(() => resolve(null), PASSWORD_TIMEOUT_SEC * 1000);

	function refresh() { cachedLines = undefined; tui.requestRender(); }

	function render(renderWidth: number): string[] {
		if (cachedLines) return cachedLines;
		const lines: string[] = [];
		const w = Math.max(1, renderWidth);
		const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
		const countdown = remaining <= 10
			? theme.fg("warning", ` (${remaining}s)`)
			: theme.fg("dim", ` (${remaining}s)`);

		lines.push(theme.fg("accent", "─".repeat(w)));
		for (const l of wrapTextWithAnsi(theme.fg("text", label + countdown), w)) lines.push(l);
		lines.push("");

		const masked = value.length > 0
			? theme.fg("accent", "*".repeat(value.length))
			: theme.fg("dim", "(type your password)");
		lines.push(`  ${masked}`);
		lines.push("");
		lines.push("");
		for (const l of wrapTextWithAnsi(theme.fg("dim", "Enter to confirm • Esc to cancel"), w)) lines.push(l);
		lines.push(theme.fg("accent", "─".repeat(w)));

		cachedLines = lines;
		return lines;
	}

	return {
		render,
		invalidate: () => { cachedLines = undefined; },
		handleInput(data: string) {
			if (resolved) return;
			if (matchesKey(data, Key.enter)) { if (value.length > 0) resolve(value); return; }
			if (matchesKey(data, Key.escape)) { resolve(null); return; }
			if (matchesKey(data, Key.backspace) || data === "\x7f") { value = value.slice(0, -1); refresh(); return; }
			if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) { value += data; refresh(); }
		},
	};
}

// ─── Shared connect / disconnect logic ────────────────────────────────────────

interface ConnectCtx {
	mode: string;
	ui: {
		custom<T>(cb: (tui: any, theme: any, kb: any, done: (val: T) => void) => any): Promise<T>;
		notify: (msg: string, level: string) => void;
		setStatus: (id: string, text: string | undefined) => void;
		theme: { fg: (n: string, t: string) => string };
	};
}

async function doConnect(
	target: string,
	passwordPromptText: string,
	ctx: ConnectCtx,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
	if (!checkSshpass()) {
		return {
			content: [{ type: "text", text: "Error: sshpass is not installed. Run: sudo apt install sshpass" }],
			details: {},
		};
	}

	if (sshPassword) {
		return {
			content: [{ type: "text", text: `Already connected to ${sshConfig!.remote}:${sshConfig!.remoteCwd}. Use ssh_disconnect to switch.` }],
			details: {},
		};
	}

	if (ctx.mode !== "tui") {
		return {
			content: [{ type: "text", text: "Error: TUI mode required for password input." }],
			details: {},
		};
	}

	// Parse target: "user@host:/path" or "user@host"
	let remote: string;
	let remoteCwd: string;
	if (target.includes(":")) {
		const idx = target.indexOf(":");
		remote = target.slice(0, idx);
		remoteCwd = target.slice(idx + 1);
	} else {
		remote = target;
		remoteCwd = "";
	}

	// Prompt for password in TUI
	const password = await ctx.ui.custom<string | null>((tui, theme, _kb, done) =>
		promptPassword(passwordPromptText.replace("{target}", remote), theme, tui, done),
	);

	if (!password) {
		return {
			content: [{ type: "text", text: `Password entry timed out after ${PASSWORD_TIMEOUT_SEC}s or was cancelled.` }],
			details: {},
		};
	}

	// Test the connection
	sshConfig = { remote, remoteCwd };
	sshPassword = password;

	try {
		if (!remoteCwd) {
			const pwd = (await sshExec("pwd")).toString().trim();
			sshConfig.remoteCwd = pwd;
		} else {
			await sshExec("pwd");
		}
	} catch (err) {
		sshPassword = null;
		sshConfig = null;
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: `SSH authentication failed: ${msg}` }],
			details: {},
		};
	}

	ctx.ui.setStatus("ssh", ctx.ui.theme.fg("success", `SSH: ${sshConfig.remote}:${sshConfig.remoteCwd}`));
	ctx.ui.notify(`Connected to ${sshConfig.remote}:${sshConfig.remoteCwd}`, "info");

	return {
		content: [{
			type: "text",
			text: `Connected to ${sshConfig.remote}:${sshConfig.remoteCwd}. Remote tools available:\n- ssh_bash: run commands on remote\n- ssh_read: read files on remote\n- ssh_write: write files on remote\n- ssh_edit: edit files on remote\n\nBuilt-in local tools remain available for local operations.`,
		}],
		details: {},
	};
}

function doDisconnect(ctx: ConnectCtx): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
	if (!sshPassword) {
		return { content: [{ type: "text", text: "Not connected." }], details: {} };
	}
	const host = sshConfig?.remote ?? "unknown";
	sshPassword = null;
	sshConfig = null;
	ctx.ui.setStatus("ssh", undefined);
	ctx.ui.notify(`Disconnected from ${host}`, "info");
	return { content: [{ type: "text", text: `Disconnected from ${host}.` }], details: {} };
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const isConnected = (): boolean => sshConfig !== null && sshPassword !== null;

	// ── /ssh command (user types in TUI) ────────────────────────────────────
	pi.registerCommand("ssh", {
		description: "Connect to remote via SSH: /ssh user@host or /ssh user@host:/path",
		handler: async (args, ctx) => {
			const target = args?.trim();
			if (!target) {
				ctx.ui.notify("Usage: /ssh user@host or /ssh user@host:/path", "warning");
				return;
			}
			const result = await doConnect(target, "Enter SSH password for {target}:", ctx);
			if (result.content[0]) {
				const text = result.content[0].text;
				if (text.startsWith("Error") || text.startsWith("SSH auth")) {
					ctx.ui.notify(text, "error");
				}
			}
		},
	});

	// ── /ssh-disconnect command ─────────────────────────────────────────────
	pi.registerCommand("ssh-disconnect", {
		description: "Disconnect from remote SSH",
		handler: async (_args, ctx) => {
			doDisconnect(ctx);
		},
	});

	// ── ssh_connect tool (AI can call) ──────────────────────────────────────
	pi.registerTool({
		name: "ssh_connect",
		label: "SSH Connect",
		description:
			"Initiate an SSH connection to a remote host. The user will be prompted in the TUI for their password (NEVER sent to the AI). After connecting, the remote tools (ssh_bash, ssh_read, ssh_write, ssh_edit) become available alongside the built-in local tools. Target format: 'user@host' or 'user@host:/remote/path'.",
		parameters: Type.Object({
			target: Type.String({ description: "SSH target: user@host or user@host:/remote/path" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			return doConnect(params.target, "Enter SSH password for {target}:", ctx);
		},
	});

	// ── ssh_disconnect tool ─────────────────────────────────────────────────
	pi.registerTool({
		name: "ssh_disconnect",
		label: "SSH Disconnect",
		description: "Disconnect from the remote SSH session. Clears stored password from memory.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return doDisconnect(ctx);
		},
	});

	// ── Remote tools (available only when connected) ────────────────────────

	pi.registerTool({
		name: "ssh_bash",
		label: "SSH Bash",
		description:
			"Execute a bash command on the REMOTE host via SSH. Use this for remote operations. The local 'bash' tool remains available for local commands. Only works after ssh_connect.",
		promptSnippet: "Execute a bash command on the remote SSH host",
		promptGuidelines: [
			"Use ssh_bash for running commands on the remote host. Use the regular bash tool for local commands.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute on the remote host" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			requireConnected();
			const tool = createBashTool(localCwd, { operations: createRemoteBashOps() });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "ssh_read",
		label: "SSH Read",
		description:
			"Read a file from the REMOTE host via SSH. The path is translated from local cwd to remote cwd. Use the local 'read' tool for local files. Only works after ssh_connect.",
		promptSnippet: "Read file contents from the remote SSH host",
		promptGuidelines: [
			"Use ssh_read for reading files on the remote host. Use the regular read tool for local files.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file on the remote host" }),
			offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			requireConnected();
			const tool = createReadTool(localCwd, { operations: createRemoteReadOps() });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "ssh_write",
		label: "SSH Write",
		description:
			"Write content to a file on the REMOTE host via SSH. Creates parent directories automatically. Use the local 'write' tool for local files. Only works after ssh_connect.",
		promptSnippet: "Write a file to the remote SSH host",
		promptGuidelines: [
			"Use ssh_write for writing files on the remote host. Use the regular write tool for local files.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file on the remote host" }),
			content: Type.String({ description: "Content to write to the file" }),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			requireConnected();
			const tool = createWriteTool(localCwd, { operations: createRemoteWriteOps() });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		name: "ssh_edit",
		label: "SSH Edit",
		description:
			"Edit a file on the REMOTE host via SSH using precise text replacement. Use the local 'edit' tool for local files. Only works after ssh_connect.",
		promptSnippet: "Edit a file on the remote SSH host with exact text replacement",
		promptGuidelines: [
			"Use ssh_edit for editing files on the remote host. Use the regular edit tool for local files.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file on the remote host" }),
			edits: Type.Array(
				Type.Object({
					oldText: Type.String({ description: "Exact text to replace" }),
					newText: Type.String({ description: "Replacement text" }),
				}),
				{ description: "Array of edit operations" },
			),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			requireConnected();
			const r = createRemoteReadOps();
			const w = createRemoteWriteOps();
			const e = createRemoteEditOps(r, w);
			const tool = createEditTool(localCwd, { operations: e });
			return tool.execute(id, params, signal, onUpdate, ctx);
		},
	});

	// ── User ! commands: "!ssh <cmd>" routes to remote, "!<cmd>" stays local
	pi.on("user_bash", (event) => {
		const cmd = event.command.trim();
		if (!cmd.startsWith("ssh ") && !cmd.startsWith("ssh\t")) return; // not our prefix

		if (!isConnected()) {
			return {
				result: {
					output: "(SSH not connected. Run /ssh user@host first.)",
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}

		const remoteCmd = cmd.slice(3).trim(); // strip "ssh " prefix
		return { operations: createRemoteBashOps(), command: remoteCmd };
	});

	// ── System prompt: mention SSH context when connected ───────────────────
	pi.on("before_agent_start", async (event) => {
		if (!isConnected() || !sshConfig) return;

		const sshNote = [
			"",
			"## SSH Remote Connection",
			`Connected to ${sshConfig.remote}, working directory ${sshConfig.remoteCwd}.`,
			"Remote tools: ssh_bash, ssh_read, ssh_write, ssh_edit.",
			"Local tools (bash, read, write, edit) remain available for local operations.",
		].join("\n");

		return { systemPrompt: event.systemPrompt + sshNote };
	});
}
