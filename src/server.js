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
 */
export async function createBridge({
    host = "127.0.0.1",
    port = Number(process.env.HARPER_BRIDGE_PORT ?? 4000),
    workspaceDir = process.env.HARPER_BRIDGE_WORKSPACE ?? `${process.env.HOME}/.local/share/harper-trilium`,
    token = process.env.HARPER_BRIDGE_TOKEN ?? randomBytes(24).toString("base64url"),
    binary,
    config = {},
    onLog = (...args) => console.log(`[${new Date().toISOString()}]`, ...args),
} = {}) {
    const log = (...args) => onLog(...args);

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
    /** noteId -> uri, so `close` can work without the client resending the uri. */
    const noteUris = new Map();

    wss.on("error", (err) => {
        log("server error:", err.message);
    });

    wss.on("connection", (socket, req) => {
        const origin = req.headers.origin;

        if (!isOriginAllowed(origin)) {
            log("rejected connection from origin", origin);
            socket.close(1008, "origin not allowed");
            return;
        }

        if (!isAuthorized(req.url, token)) {
            log("rejected unauthorized connection");
            socket.close(1008, "unauthorized");
            return;
        }

        log(`client connected (origin=${origin ?? "none"})`);

        // One editor at a time: two clients would fight over harper-ls document state.
        for (const other of clients) {
            other.close(1000, "replaced by a newer client");
        }
        clients.add(socket);

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
            const msg = parseClientMessage(raw.toString());
            if (!msg) {
                log("ignoring malformed message");
                return;
            }
            handle(socket, msg).catch((err) => {
                log("handler error:", err);
                if (msg.id !== undefined) {
                    send(socket, { type: ServerMessage.ERROR, id: msg.id, message: err.message });
                }
            });
        });

        socket.on("close", () => {
            clients.delete(socket);
            log(`client disconnected (${clients.size} remaining)`);
        });

        socket.on("error", (err) => log("socket error:", err.message));
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

                send(socket, {
                    type: ServerMessage.LINT_RESULT,
                    id: msg.id,
                    noteId: msg.noteId,
                    uri,
                    lints,
                    durationMs: Date.now() - startedAt,
                });
                return;
            }

            case ClientMessage.CODE_ACTION: {
                const uri = resolveUri(msg);
                const actions = await harper.codeAction(uri, msg.range);
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
                send(socket, { type: ServerMessage.COMMAND_RESULT, id: msg.id, name: msg.name });
                return;
            }

            case ClientMessage.CLOSE:
                harper.close(noteUris.get(msg.noteId) ?? noteUri(msg.noteId, workspaceDir));
                noteUris.delete(msg.noteId);
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
        for (const [noteId, uri] of noteUris) {
            if (noteUris.size <= MAX_OPEN_NOTES) break;
            harper.close(uri);
            noteUris.delete(noteId);
        }
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
    log("token:", bridge.token);
    log("workspace:", bridge.workspaceDir);
    log("paste the token into the Trilium script's CONFIG block");
}

// Only start when run directly, so tests can import createBridge.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
