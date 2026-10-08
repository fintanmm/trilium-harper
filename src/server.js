/**
 * Harper bridge for Trilium.
 *
 * Terminates a WebSocket connection from the Trilium frontend script, keeps a
 * `harper-ls` child process alive behind it, and translates between the two.
 * Listens on loopback only: the grammar engine should never be reachable off-box.
 *
 *   Trilium editor  ──ws://127.0.0.1:4000──▶  bridge  ──stdio──▶  harper-ls
 */

import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

import { HarperLs, ensureWorkspace, resolveBinary } from "./harper-ls.js";
import {
    ClientMessage,
    PROTOCOL_VERSION,
    ServerMessage,
    noteUri,
    parseClientMessage,
} from "./protocol.js";

/**
 * `http(s)` origins permitted to connect. Loopback and private ranges, since
 * Trilium is typically reached either directly or over a LAN address.
 */
const ORIGIN_ALLOWED =
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?(\/.*)?$/;

/**
 * Non-http origins permitted verbatim. The Trilium desktop app serves its UI
 * from the privileged custom scheme `trilium-app://app`, so there is no
 * `http(s)://` for `ORIGIN_ALLOWED` to match — and TriliumNext itself treats
 * that exact origin as the app shell, so nothing broader is needed here.
 */
const ORIGINS_EXACT = new Set(["trilium-app://app"]);

/**
 * Whether an incoming `Origin` header may connect.
 *
 * A missing header is allowed: browsers always stamp `Origin` on a WebSocket
 * handshake, so absence means a non-browser client, which still has to
 * present the token.
 *
 * @param {string | undefined} origin
 * @returns {boolean}
 */
export function isOriginAllowed(origin) {
    if (!origin) return true;
    return ORIGINS_EXACT.has(origin) || ORIGIN_ALLOWED.test(origin);
}

const LINT_TIMEOUT_MS = 30_000;
/** Upper bound on notes tracked at once, to bound bridge memory. */
const MAX_OPEN_NOTES = 64;

/**
 * Verbosity levels, most talkative last.
 *
 * `debug` is the default so a first run explains itself end to end; once the
 * squiggles work, `HARPER_BRIDGE_LOG=info` quiets it back down to lifecycle
 * events only. `HARPER_BRIDGE_LOG=warn` goes quieter still.
 */
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * A one-line summary of a client message, for logging. Never includes `text`:
 * note contents should not end up in the journal.
 *
 * @param {object} msg
 * @returns {string}
 */
function describeMessage(msg) {
    const bits = [];
    if (msg.noteId) bits.push(`note=${msg.noteId}`);
    if (msg.uri) bits.push(`uri=${msg.uri}`);
    if (typeof msg.text === "string") bits.push(`chars=${msg.text.length}`);
    if (msg.range) {
        const { start, end } = msg.range;
        bits.push(`range=${start.line}:${start.character}-${end.line}:${end.character}`);
    }
    if (msg.name) bits.push(`name=${msg.name}`);
    if (msg.type === "close") bits.push("closing");
    return bits.join(" ");
}

/** Findings condensed to `message @line:col` so a lint result stays one line. */
function describeLints(lints, max = 5) {
    const shown = lints.slice(0, max).map((lint) => {
        const start = lint?.range?.start;
        const where = start ? ` @${start.line}:${start.character}` : "";
        return `${lint?.message ?? "?"}${where}`;
    });
    const more = lints.length > max ? ` (+${lints.length - max} more)` : "";
    return shown.join(" | ") + more;
}

/**
 * Starts the bridge.
 *
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port] Use 0 to let the OS pick a free port.
 * @param {string} [options.workspaceDir]
 * @param {string} [options.token]
 * @param {string} [options.binary]
 * @param {object} [options.config] Extra `harper-ls` config overrides, layered
 *   over the defaults in `buildConfig`.
 * @param {(...args: unknown[]) => void} [options.onLog]
 * @param {string} [options.logLevel] `error` | `warn` | `info` | `debug`.
 *   Defaults to `$HARPER_BRIDGE_LOG`, then `debug`.
 */
export async function createBridge({
    host = "127.0.0.1",
    port = Number(process.env.HARPER_BRIDGE_PORT ?? 4000),
    workspaceDir = process.env.HARPER_BRIDGE_WORKSPACE ?? `${process.env.HOME}/.local/share/harper-trilium`,
    token = process.env.HARPER_BRIDGE_TOKEN ?? randomBytes(24).toString("base64url"),
    binary,
    config = {},
    logLevel = process.env.HARPER_BRIDGE_LOG ?? "debug",
    onLog = (...args) => console.log(`[${new Date().toISOString()}]`, ...args),
} = {}) {
    const log = (...args) => onLog(...args);
    const level = LOG_LEVELS[String(logLevel).toLowerCase()] ?? LOG_LEVELS.debug;
    /** Every request in, every result out — the level you debug with. */
    const debug = (...args) => {
        if (level >= LOG_LEVELS.debug) onLog(...args);
    };
    const warn = (...args) => {
        if (level >= LOG_LEVELS.warn) onLog("WARN", ...args);
    };
    const error = (...args) => {
        if (level >= LOG_LEVELS.error) onLog("ERROR", ...args);
    };

    ensureWorkspace(workspaceDir);

    const harper = new HarperLs({
        binary: binary ? resolveBinary(binary) : resolveBinary(),
        workspaceDir,
        config,
        onLog: (msg) => log("harper-ls:", msg),
    });

    await harper.ready();

    const wss = new WebSocketServer({
        host,
        port,
        maxPayload: 8_000_000,
        // Only loopback is bound, so permessage-deflate is not worth the memory.
        perMessageDeflate: false,
    });

    /** @type {Set<WebSocket>} */
    const clients = new Set();
    /**
     * Monotonic per-connection id. Two Trilium windows run their own copy of
     * the frontend, and without an id the journal cannot tell them apart.
     */
    let clientSeq = 0;
    /** noteId -> uri, so `close` can work without the client resending the uri. */
    const noteUris = new Map();

    wss.on("error", (err) => {
        error("server error:", err.message);
    });

    wss.on("connection", (socket, req) => {
        const origin = req.headers.origin;
        const from = `${req.socket.remoteAddress}:${req.socket.remotePort}`;

        if (!isOriginAllowed(origin)) {
            warn(`rejected connection from ${from}: origin ${origin ?? "none"} not allowed`);
            socket.close(1008, "origin not allowed");
            return;
        }

        if (!isAuthorized(req.url, token)) {
            warn(`rejected unauthorized connection from ${from}`);
            socket.close(1008, "unauthorized");
            return;
        }

        const clientId = ++clientSeq;
        log(`client #${clientId} connected (origin=${origin ?? "none"} from=${from})`);

        // Several clients are allowed: a second Trilium window runs its own
        // frontend, and evicting the previous socket made the two of them kick
        // each other off every retry interval, so neither ever held the
        // connection long enough to lint. Document state cannot diverge
        // because every lint pushes the whole text for its own URI first.
        clients.add(socket);
        socket.harperClientId = clientId;

        socket.send(
            JSON.stringify({
                type: ServerMessage.WELCOME,
                protocolVersion: PROTOCOL_VERSION,
                token,
                host,
                // Read back from the server, not the requested port: with
                // `port: 0` the OS picks a different one and the requested value
                // would be a lie.
                port: boundPortOf(wss, port),
            }),
        );

        socket.on("message", (raw) => {
            const body = raw.toString();
            const msg = parseClientMessage(body);
            if (!msg) {
                warn("ignoring malformed message:", body.slice(0, 200));
                return;
            }
            debug("←", msg.type, `id=${msg.id ?? "-"}`, describeMessage(msg));
            handle(socket, msg).catch((err) => {
                error(`${msg.type} failed:`, err.stack ?? err.message);
                if (msg.id !== undefined) {
                    send(socket, { type: ServerMessage.ERROR, id: msg.id, message: err.message });
                }
            });
        });

        socket.on("close", (code, reason) => {
            clients.delete(socket);
            const why = String(reason ?? "").trim();
            log(
                `client #${socket.harperClientId} disconnected ` +
                    `(code=${code}${why ? ` reason=${why}` : ""}; ${clients.size} total)`,
            );
        });

        socket.on("error", (err) => error("socket error:", err.message));
    });

    async function handle(socket, msg) {
        switch (msg.type) {
            case ClientMessage.PING:
                send(socket, { type: "status", ok: true, harperAvailable: !harper.closed });
                return;

            case ClientMessage.LINT: {
                const uri = resolveUri(msg);
                noteUris.set(msg.noteId, uri);
                evictStaleNotes();

                const startedAt = Date.now();
                const lints = await harper.lint(uri, msg.text, LINT_TIMEOUT_MS);
                const durationMs = Date.now() - startedAt;

                debug(
                    `→ lint note=${msg.noteId} chars=${msg.text.length}`,
                    `in ${durationMs}ms:`,
                    `${lints.length} finding${lints.length === 1 ? "" : "s"}`,
                );
                if (lints.length > 0) debug("  ", describeLints(lints));

                send(socket, {
                    type: ServerMessage.LINT_RESULT,
                    id: msg.id,
                    noteId: msg.noteId,
                    uri,
                    lints,
                    durationMs,
                });
                return;
            }

            case ClientMessage.CODE_ACTION: {
                const uri = resolveUri(msg);
                const startedAt = Date.now();
                const actions = await harper.codeAction(uri, msg.range);
                debug(
                    `→ codeAction note=${msg.noteId} in ${Date.now() - startedAt}ms:`,
                    `${actions.length} action${actions.length === 1 ? "" : "s"}`,
                );
                send(socket, {
                    type: ServerMessage.CODE_ACTION_RESULT,
                    id: msg.id,
                    noteId: msg.noteId,
                    uri,
                    actions,
                });
                return;
            }

            case ClientMessage.COMMAND: {
                await harper.executeCommand(msg.name, msg.args);
                debug(`→ command name=${msg.name} done`);
                send(socket, { type: ServerMessage.COMMAND_RESULT, id: msg.id, name: msg.name });
                return;
            }

            case ClientMessage.CLOSE:
                debug(`→ close note=${msg.noteId}`);
                harper.close(noteUris.get(msg.noteId) ?? noteUri(msg.noteId, workspaceDir));
                noteUris.delete(msg.noteId);
                return;

            default:
                warn("unhandled message type:", msg.type);
                return;
        }
    }

    /** The document URI for a request: client-supplied, else derived from the note id. */
    function resolveUri(msg) {
        return msg.uri ?? noteUri(msg.noteId, workspaceDir);
    }

    /** Closes the least recently linted notes once the cap is exceeded. */
    function evictStaleNotes() {
        if (noteUris.size <= MAX_OPEN_NOTES) return;
        const before = noteUris.size;
        for (const [noteId, uri] of noteUris) {
            if (noteUris.size <= MAX_OPEN_NOTES) break;
            harper.close(uri);
            noteUris.delete(noteId);
        }
        debug(`evicted ${before - noteUris.size} note(s), ${noteUris.size} still open`);
    }

    await new Promise((resolve, reject) => {
        wss.once("listening", resolve);
        wss.once("error", reject);
    });

    const boundPort = boundPortOf(wss, port);

    return {
        wss,
        harper,
        host,
        port: boundPort,
        token,
        workspaceDir,
        url: `ws://${host}:${boundPort}`,
        noteUri: (noteId) => noteUri(noteId, workspaceDir),
        async close() {
            for (const socket of clients) socket.close(1001, "server shutting down");
            clients.clear();
            await new Promise((resolve) => wss.close(resolve));
            await harper.stop();
        },
    };
}

function send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** The port actually in use, which differs from `requested` when it was 0. */
function boundPortOf(wss, requested) {
    const address = wss.address();
    return typeof address === "object" && address ? address.port : requested;
}

function isAuthorized(url, token) {
    try {
        const parsed = new URL(url ?? "/", "ws://127.0.0.1");
        return parsed.searchParams.get("token") === token;
    } catch {
        return false;
    }
}

async function main() {
    const bridge = await createBridge().catch((err) => {
        console.error("bridge failed to start:", err.message);
        console.error("Install harper with `brew install harper`, or set HARPER_LS_BIN.");
        process.exit(1);
    });

    const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

    const shutdown = (signal) => {
        log(`received ${signal}, shutting down`);
        // Don't hang on a wedged child or socket.
        const bail = setTimeout(() => process.exit(0), 3000);
        bail.unref();
        bridge.close().finally(() => process.exit(0));
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    log("bridge listening on", bridge.url);
    log("log level:", process.env.HARPER_BRIDGE_LOG ?? "debug", "(set HARPER_BRIDGE_LOG=info to quieten)");
    log("token:", bridge.token);
    log("workspace:", bridge.workspaceDir);
    log("paste the token into the Trilium script's CONFIG block");
}

// Only start when run directly, so tests can import createBridge.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
