/**
 * Supervises a `harper-ls` child process and drives it over LSP.
 *
 * The child is always started in `--stdio` mode. Harper's TCP mode is a poor
 * fit for supervision: it calls `accept()` exactly once with no loop, so the
 * process exits as soon as the single client disconnects.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { LspClient } from "./lsp.js";

const INITIALIZE_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const KILL_ESCALATION_MS = 2_000;
const CODE_ACTION_TIMEOUT_MS = 15_000;

/**
 * Normalises the two command shapes LSP allows into `{command, arguments}`.
 *
 * `command` may arrive as a bare string (a `Command`, already unwrapped by
 * serialization) or as a nested `Command` object (the `command` field of a
 * `CodeAction`).
 *
 * @param {unknown} value
 * @returns {{command: string, arguments: unknown[]} | null}
 */
function normaliseCommand(value) {
    if (typeof value === "string") {
        return { command: value, arguments: [] };
    }
    if (value && typeof value === "object" && typeof value.command === "string") {
        return { command: value.command, arguments: value.arguments ?? [] };
    }
    return null;
}

/**
 * Display order for Harper's spelling helper commands.
 *
 * Harper emits `HarperIgnoreLint` before the dictionary additions, but the
 * menu reads better with the dictionary choices first and the dismissive
 * action last, where a stray click is least likely to silently suppress a
 * finding. Commands absent from the map keep their relative order after these.
 */
const COMMAND_ORDER = new Map([
    ["HarperAddToFileDict", 0],
    ["HarperAddToWSDict", 1],
    ["HarperAddToUserDict", 2],
    ["HarperIgnoreLint", 3],
]);

/**
 * Builds the `harper-ls` settings object handed back on every
 * `workspace/configuration` pull.
 *
 * Harper re-pulls this on every keystroke, so the object is assembled once and
 * never mutated. A partial `linters` map is fine: Harper layers it over the
 * curated defaults rather than replacing them.
 *
 * The two space rules are disabled on purpose. Masked code blocks are replaced
 * with spaces to keep offsets stable, which produces long runs of whitespace
 * that both rules flag. `Spaces` objects to runs over one character and
 * `NoFrenchSpaces` fires on whitespace runs generally; neither is worth
 * surfacing in a prose note.
 *
 * `Dashes` is disabled for the same reason: it wants `| --- |` table separators
 * and `---` thematic breaks rewritten as em dashes, which is wrong for every
 * markdown document Trilium will ever hold.
 *
 * @param {string} workspaceDir
 * @param {object} overrides Caller-supplied `harper-ls` config overrides.
 */
function buildConfig(workspaceDir, overrides) {
    const { linters, ...rest } = overrides;

    return {
        // Harper only ships an American dictionary, so "Canadian" and "British"
        // simply stop flagging the -our/-re words rather than switching to a
        // different one. Set HARPER_DIALECT to match the user's locale.
        dialect: process.env.HARPER_DIALECT ?? "American",
        diagnosticDelayMs: 750,
        maxFileLength: 4_000_000,
        diagnosticSeverity: "hint",
        // Every dictionary is pinned inside the bridge workspace. Harper's own
        // default for `userDictPath` is the user's real config directory
        // (~/.config/harper-ls/dictionary.txt), which would mean a note in
        // Trilium silently mutating a global file outside the project.
        userDictPath: join(workspaceDir, "user-dictionary.txt"),
        workspaceDictPath: join(workspaceDir, "workspace-dictionary.txt"),
        fileDictPath: join(workspaceDir, "file-dictionaries"),
        ignoredLintsPath: join(workspaceDir, "ignored-lints"),
        linters: {
            Spaces: false,
            NoFrenchSpaces: false,
            Dashes: false,
            ...(linters ?? {}),
        },
        // Harper's `forceStable` reverses the *entire* code-action list, not
        // just the actions it is documented to stabilise. That also flips the
        // spell-check suggestions, so the best match arrives last. Leave it off
        // (Harper's default) and let the native best-first order through; the
        // command group is reordered in `codeAction()` if needed.
        codeActions: { ForceStable: false },
        markdown: { IgnoreLinkTitle: true },
        ...rest,
    };
}

/** @typedef {{ uri: string, range: object, message: string, code: string, severity: number }} Lint */

export class HarperLs {
    /**
     * @param {object} options
     * @param {string} [options.binary] Path to the harper-ls executable.
     * @param {string} options.workspaceDir Directory used as the LSP workspace root.
     * @param {object} [options.config] Extra `harper-ls` config overrides.
     * @param {() => void} [options.onLog]
     */
    constructor({ binary, workspaceDir, config = {}, onLog = () => {} }) {
        this._binary = binary ?? process.env.HARPER_LS_BIN ?? "harper-ls";
        this._workspaceDir = workspaceDir;
        this._log = onLog;
        // Built once: Harper re-pulls this object on every document update, so
        // it is never mutated after construction.
        this._harperConfig = buildConfig(workspaceDir, config);

        /** @type {LspClient | null} */
        this._client = null;
        /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
        this._child = null;

        /** Per-URI open document state. */
        this._docs = new Map();
        /** Resolvers waiting for the next publishDiagnostics, keyed by URI. */
        this._waiting = new Map();

        this._ready = null;
        this._stopping = false;
        this._restartDelayMs = 500;
    }

    get workspaceDir() {
        return this._workspaceDir;
    }

    /** Resolves once the process is spawned and the LSP handshake is done. */
    ready() {
        if (!this._ready) this._ready = this._start();
        return this._ready;
    }

    /** True while no language server is attached. */
    get closed() {
        return this._client === null || this._client.closed;
    }

    async _start() {
        this._log(`spawning ${this._binary} --stdio`);

        const child = spawn(this._binary, ["--stdio"], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        this._child = child;

        child.on("error", (err) => this._log(`spawn error: ${err.message}`));
        child.stderr.on("data", (buf) => {
            const text = buf.toString("utf8").trim();
            if (text) this._log(`stderr: ${text}`);
        });
        child.on("exit", (code, signal) => {
            this._log(`harper-ls exited (code=${code} signal=${signal})`);
            this._teardown();
            if (!this._stopping) this._scheduleRestart();
        });

        const client = new LspClient(child.stdout, child.stdin);
        this._client = client;

        client.on("request", (message) => this._onServerRequest(message));
        client.on("notification", (message) => this._onNotification(message));
        client.on("error", (err) => this._log(`lsp: ${err.message}`));

        const rootUri = pathToFileURL(this._workspaceDir).href;
        const initPromise = client.request("initialize", {
            processId: process.pid,
            clientInfo: { name: "trilium-harper-bridge" },
            rootUri,
            workspaceFolders: [{ uri: rootUri, name: "trilium" }],
            capabilities: {
                // Harper asks for whole-workspace settings; we answer manually.
                workspace: { configuration: true },
                textDocument: {
                    publishDiagnostics: { versionSupport: true },
                    codeAction: {
                        codeActionLiteralSupport: {
                            codeActionKind: { valueSet: ["quickfix"] },
                        },
                    },
                },
            },
        });

        const timeout = new Promise((_, reject) =>
            setTimeout(
                () => reject(new Error(`harper-ls did not initialize within ${INITIALIZE_TIMEOUT_MS}ms`)),
                INITIALIZE_TIMEOUT_MS,
            ).unref(),
        );

        const result = await Promise.race([initPromise, timeout]);

        client.notify("initialized", {});
        this._log(`initialized harper-ls ${result?.serverInfo?.version ?? "?"}`);
        this._restartDelayMs = 500;

        // Anything opened before the handshake completed is unknown to the server.
        this._docs.clear();
        return result;
    }

    _scheduleRestart() {
        const delay = this._restartDelayMs;
        this._restartDelayMs = Math.min(delay * 2, 15_000);
        this._log(`restarting harper-ls in ${delay}ms`);
        setTimeout(() => {
            if (this._stopping) return;
            this._ready = this._start().catch((err) => this._log(`restart failed: ${err.message}`));
        }, delay).unref();
    }

    _teardown() {
        const waiting = [...this._waiting.values()];
        this._waiting.clear();
        this._docs.clear();
        for (const resolve of waiting) resolve([]);

        if (this._client) {
            this._client.dispose(new Error("harper-ls terminated"));
            this._client = null;
        }
        this._child = null;
        this._ready = null;
    }

    _onServerRequest(message) {
        const client = this._client;
        if (!client) return;

        switch (message.method) {
            case "workspace/configuration":
                // Harper re-pulls this on *every* document update. One
                // ConfigurationItem was requested, so one entry goes back.
                client.respond(message.id, [{ "harper-ls": this._harperConfig }]);
                return;
            case "client/registerCapability":
            case "client/unregisterCapability":
            case "window/workDoneProgress/create":
                client.respond(message.id, null);
                return;
            default:
                this._log(`unhandled server request: ${message.method}`);
                client.respond(message.id, null);
        }
    }

    _onNotification(message) {
        if (message.method !== "textDocument/publishDiagnostics") return;

        const { uri, diagnostics } = message.params ?? {};
        const resolve = this._waiting.get(uri);
        if (!resolve) return;

        this._waiting.delete(uri);
        resolve(diagnostics.map((d) => this._toLint(uri, d)));
    }

    _toLint(uri, diagnostic) {
        return {
            uri,
            range: diagnostic.range,
            message: diagnostic.message ?? "",
            code: typeof diagnostic.code === "string" ? diagnostic.code : String(diagnostic.code ?? ""),
            severity: diagnostic.severity ?? 4,
        };
    }

    /**
     * Lints `text` and resolves with the diagnostics Harper publishes for it.
     * @param {string} uri Stable file:// URI for the note.
     * @param {string} text Masked plain text for the note.
     * @param {number} timeoutMs
     * @returns {Promise<Lint[]>}
     */
    async lint(uri, text, timeoutMs = 30_000) {
        const client = await this._readyClient();

        // Only the newest request for a URI is interesting; earlier waiters get
        // the same result so nothing hangs.
        const previous = this._waiting.get(uri);
        if (previous) this._waiting.delete(uri);

        const state = this._docs.get(uri);
        if (state === undefined) {
            client.notify("textDocument/didOpen", {
                textDocument: { uri, languageId: "plaintext", version: 1, text },
            });
            this._docs.set(uri, { version: 1 });
        } else {
            state.version += 1;
            client.notify("textDocument/didChange", {
                textDocument: { uri, version: state.version },
                contentChanges: [{ text }],
            });
        }

        const lints = await new Promise((resolve) => {
            this._waiting.set(uri, resolve);
            setTimeout(() => {
                if (this._waiting.get(uri) === resolve) {
                    this._waiting.delete(uri);
                    resolve([]);
                }
            }, timeoutMs).unref();
        });

        // Keep the superseded waiter in the loop so it settles too.
        if (previous) previous(lints);

        return lints;
    }

    /**
     * Requests quick fixes and commands covering `range` in an open document.
     * @param {string} uri
     * @param {object} range LSP Range
     * @returns {Promise<object[]>} Raw CodeAction / Command objects.
     */
    async codeAction(uri, range) {
        const client = await this._readyClient();

        const result = await client.request(
            "textDocument/codeAction",
            {
                textDocument: { uri },
                range,
                // `only` is deliberately left empty. Harper's actions are a mix
                // of CodeActions and Commands (dictionary and ignore helpers),
                // and restricting the set risks filtering out the commands the
                // UI needs.
                context: { diagnostics: [] },
            },
            CODE_ACTION_TIMEOUT_MS,
        );

        if (!Array.isArray(result)) return [];

        const actions = result.map((action) => {
            // Harper returns two shapes that are easy to confuse.
            //
            // A replacement is a CodeAction: it has an `edit` (the actual text
            // change) *and* a `command` recording that the lint was acted on.
            // A dictionary or ignore helper is a bare Command, whose `command`
            // is a string.
            //
            // Testing `action.command` for truthiness conflates the two and
            // throws away every quick fix, so the presence of an edit decides.
            const edits = action.edit?.changes?.[uri];
            if (Array.isArray(edits) && edits.length > 0) {
                return {
                    kind: "edit",
                    title: action.title,
                    // `range`/`newText` mirror the first edit because a single
                    // replacement is the overwhelmingly common case; the full
                    // list is kept so multi-range fixes stay correct.
                    range: edits[0].range ?? range,
                    newText: edits[0].newText ?? "",
                    edits: edits.map((e) => ({ range: e.range ?? range, newText: e.newText ?? "" })),
                    // Sent back to Harper after the edit lands, for statistics.
                    then: normaliseCommand(action.command),
                };
            }

            const command = normaliseCommand(action.command ?? action);
            if (!command) return null;
            return { kind: "command", title: action.title, ...command };
        }).filter(Boolean);

        // Edits are already in Harper's best-first order; only the command
        // group needs repositioning.
        const edits = actions.filter((a) => a.kind === "edit");
        const commands = actions.filter((a) => a.kind === "command");
        const rank = (a) => COMMAND_ORDER.get(a.command) ?? COMMAND_ORDER.size;
        // Stable: commands outside the map hold their relative position.
        commands.sort((a, b) => rank(a) - rank(b));

        return [...edits, ...commands];
    }

    /**
     * Runs a server command such as HarperIgnoreLint or HarperAddToUserDict.
     * @param {string} command
     * @param {unknown[]} args
     */
    async executeCommand(command, args) {
        const client = await this._readyClient();
        return client.request("workspace/executeCommand", { command, arguments: args });
    }

    /** Closes a document so the server can release its state. */
    close(uri) {
        if (!this._docs.has(uri)) return;
        this._docs.delete(uri);
        this._client?.notify("textDocument/didClose", { textDocument: { uri } });
    }

    async _readyClient() {
        if (this._stopping) throw new Error("bridge is shutting down");
        await this.ready();
        if (!this._client) throw new Error("harper-ls is not available");
        return this._client;
    }

    async stop() {
        this._stopping = true;

        // Teardown first: it detaches listeners and nulls `_child`, so capture
        // the handle we actually need to signal.
        const child = this._child;
        this._teardown();

        if (this._client && !this._client.closed) {
            // Best effort. Harper should answer `shutdown`, but a wedged or
            // already-dying process must not be able to block teardown, so the
            // response is given a short leash and the kill happens regardless.
            try {
                await this._client.request("shutdown", null, SHUTDOWN_TIMEOUT_MS);
                this._client.notify("exit", null);
            } catch {
                // Ignored; the SIGTERM below is the backstop.
            }
        }

        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise((resolve) => {
            const done = () => resolve(undefined);
            child.once("exit", done);
            child.kill("SIGTERM");
            // Escalate if it ignores SIGTERM.
            const escalate = setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATION_MS);
            escalate.unref();
        });
    }
}

/**
 * Resolves the harper-ls executable.
 * @param {string} [explicit]
 * @returns {string}
 */
export function resolveBinary(explicit) {
    const candidate = explicit ?? process.env.HARPER_LS_BIN ?? "harper-ls";
    if (candidate.includes("/") && !existsSync(candidate)) {
        throw new Error(`harper-ls not found at ${candidate}`);
    }
    return candidate;
}

/** Ensures the workspace directory tree exists. */
export function ensureWorkspace(workspaceDir) {
    mkdirSync(join(workspaceDir, "file-dictionaries"), { recursive: true });
    mkdirSync(join(workspaceDir, "ignored-lints"), { recursive: true });
}
