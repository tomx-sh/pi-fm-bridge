/**
 * Apple Foundation Models provider for pi, served by fm-bridge (github.com/tomx-sh/fm-bridge).
 *
 * Registers `apple-fm/system`: Apple's on-device model with native tool calling. The bridge
 * starts on first use (an already-running one is reused) and stops when pi quits if this
 * extension started it. `/fm [status|start|stop]` manages it by hand; its log goes to
 * $TMPDIR/pi-fm-bridge.log.
 *
 * Env: FM_BRIDGE_BIN (default `fm-bridge` on PATH), FM_BRIDGE_PORT (default 1977).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "apple-fm";
const MODEL_ID = "system";
const BRIDGE_BIN = process.env.FM_BRIDGE_BIN ?? "fm-bridge";
const PORT = Number(process.env.FM_BRIDGE_PORT ?? 1977);
const LOG_FILE = join(tmpdir(), "pi-fm-bridge.log");
const START_TIMEOUT_MS = 30_000;

// The bridge outlives an extension /reload, so track it process-wide.
interface State {
	child?: ChildProcess;
	spawnError?: string;
	starting?: Promise<void>;
	exitHook?: boolean;
}
const state: State = ((globalThis as { __piFmBridge?: State }).__piFmBridge ??= {});

function isAppleFm(model: { provider: string; id: string } | undefined): boolean {
	return model?.provider === PROVIDER && model.id === MODEL_ID;
}

function alive(child: ChildProcess | undefined): child is ChildProcess {
	return child?.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

async function healthy(): Promise<boolean> {
	try {
		return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) })).ok;
	} catch {
		return false;
	}
}

async function start(): Promise<void> {
	if (!alive(state.child)) {
		state.spawnError = undefined;
		const log = openSync(LOG_FILE, "a");
		const child = spawn(BRIDGE_BIN, ["--port", String(PORT)], { cwd: homedir(), stdio: ["ignore", log, log] });
		closeSync(log);
		child.on("error", (err) => {
			state.spawnError = err.message;
			appendFileSync(LOG_FILE, `[pi] ${BRIDGE_BIN}: ${err.message}\n`);
		});
		child.unref();
		state.child = child;
	}
	if (!state.exitHook) {
		process.once("exit", stop);
		state.exitHook = true;
	}
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await healthy()) return;
		if (!alive(state.child)) {
			throw new Error(
				state.spawnError?.includes("ENOENT")
					? `${BRIDGE_BIN} not found; install fm-bridge or set FM_BRIDGE_BIN`
					: `fm-bridge failed to start, see ${LOG_FILE}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`fm-bridge not healthy after ${START_TIMEOUT_MS / 1000}s, see ${LOG_FILE}`);
}

function ensureBridge(): Promise<void> {
	state.starting ??= (async () => {
		if (!(await healthy())) await start();
	})().finally(() => {
		state.starting = undefined;
	});
	return state.starting;
}

/** Stops the bridge if this extension started it. */
function stop(): boolean {
	const child = state.child;
	state.child = undefined;
	if (!alive(child)) return false;
	child.kill("SIGTERM");
	return true;
}

async function ensureWithUi(ctx: ExtensionContext): Promise<boolean> {
	if (await healthy()) return true;
	ctx.ui.setStatus(PROVIDER, "Apple FM: starting…");
	try {
		await ensureBridge();
		return true;
	} catch (err) {
		ctx.ui.notify(`Apple FM: ${err instanceof Error ? err.message : String(err)}`, "error");
		return false;
	} finally {
		ctx.ui.setStatus(PROVIDER, undefined);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER, {
		name: "Apple Foundation Models",
		baseUrl: `http://127.0.0.1:${PORT}/v1`,
		api: "openai-completions",
		apiKey: "fm-bridge", // the bridge ignores it, but pi needs a credential to list the model
		models: [
			{
				id: MODEL_ID,
				name: "Apple On-Device",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				// 0 means "no cap": pi then sends none. A real value gets clamped to the window
				// minus a 4096-token margin minus the prompt, which reaches 1 token halfway
				// through an 8K window. The bridge stops at the window on its own.
				maxTokens: 0,
			},
		],
	});

	pi.on("session_start", (_event, ctx) => {
		if (isAppleFm(ctx.model)) void ensureWithUi(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		if (isAppleFm(event.model)) void ensureWithUi(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (isAppleFm(ctx.model)) await ensureWithUi(ctx);
	});

	pi.on("session_shutdown", (event) => {
		if (event.reason === "quit") stop();
	});

	pi.registerCommand("fm", {
		description: "Apple Foundation Models bridge: status | start | stop",
		getArgumentCompletions: (prefix) => {
			const actions = ["status", "start", "stop"].filter((a) => a.startsWith(prefix));
			return actions.length > 0 ? actions.map((a) => ({ value: a, label: a })) : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "start") {
				if (await ensureWithUi(ctx)) ctx.ui.notify(`Apple FM ready at http://127.0.0.1:${PORT}/v1`, "info");
			} else if (action === "stop") {
				ctx.ui.notify(
					stop()
						? "Apple FM: bridge stopped"
						: "Apple FM: no bridge started by pi is running (stop an external one where it was launched)",
					"info",
				);
			} else if (action === "status") {
				const running = (await healthy()) ? "running" : "not running";
				const origin = alive(state.child) ? `started by pi (pid ${state.child.pid})` : "not started by pi";
				ctx.ui.notify(`Apple FM: ${running}, ${origin}. Log: ${LOG_FILE}`, "info");
			} else {
				ctx.ui.notify("Usage: /fm [status|start|stop]", "warning");
			}
		},
	});
}
