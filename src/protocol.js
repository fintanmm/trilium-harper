/**
 * Wire protocol between the Trilium frontend script and this bridge.
 *
 * The browser speaks WebSocket JSON here; the bridge translates to LSP. Keeping
 * the two vocabularies separate means a Harper API change is absorbed in one
 * place instead of rippling into the editor script.
 *
 * Every request carries a client-generated `id`; the reply echoes it. The
 * editor script also stamps `version` on lint results so it can discard
 * diagnostics computed against text it has already moved past.
 */

export const PROTOCOL_VERSION = 1;

export const ClientMessage = {
    LINT: "lint",
    CODE_ACTION: "codeAction",
    COMMAND: "command",
    CLOSE: "close",
    PING: "ping",
};

export const ServerMessage = {
    WELCOME: "welcome",
    LINT_RESULT: "lintResult",
    CODE_ACTION_RESULT: "codeActionResult",
    COMMAND_RESULT: "commandResult",
    STATUS: "status",
    ERROR: "error",
};

/**
 * @param {unknown} raw
 * @returns {{ type: string, id: number, noteId?: string, uri?: string, text?: string, range?: object, name?: string, args?: unknown[] } | null}
 */
export function parseClientMessage(raw) {
    if (typeof raw !== "string" || raw.length > 8_000_000) return null;

    let msg;
    try {
        msg = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return null;

    switch (msg.type) {
        case ClientMessage.LINT:
            // `uri` is derived from `noteId` by the bridge so the path scheme
            // lives in exactly one place; a client may still override it.
            if (typeof msg.id !== "number" || typeof msg.noteId !== "string" || typeof msg.text !== "string") {
                return null;
            }
            return {
                type: msg.type,
                id: msg.id,
                noteId: msg.noteId,
                uri: typeof msg.uri === "string" ? msg.uri : undefined,
                text: msg.text,
            };
        case ClientMessage.CODE_ACTION:
            if (typeof msg.id !== "number" || typeof msg.noteId !== "string" || !isRange(msg.range)) {
                return null;
            }
            return {
                type: msg.type,
                id: msg.id,
                noteId: msg.noteId,
                uri: typeof msg.uri === "string" ? msg.uri : undefined,
                range: msg.range,
            };
        case ClientMessage.COMMAND:
            if (typeof msg.id !== "number" || typeof msg.name !== "string") return null;
            return { type: msg.type, id: msg.id, name: msg.name, args: Array.isArray(msg.args) ? msg.args : [] };
        case ClientMessage.CLOSE:
            if (typeof msg.noteId !== "string") return null;
            return { type: msg.type, noteId: msg.noteId };
        case ClientMessage.PING:
            return { type: msg.type };
        default:
            return null;
    }
}

function isRange(range) {
    return (
        range &&
        typeof range === "object" &&
        isPosition(range.start) &&
        isPosition(range.end)
    );
}

function isPosition(pos) {
    return (
        pos &&
        typeof pos === "object" &&
        Number.isInteger(pos.line) &&
        pos.line >= 0 &&
        Number.isInteger(pos.character) &&
        pos.character >= 0
    );
}

/**
 * Maps a Trilium noteId to a stable file:// URI.
 *
 * Harper derives per-note dictionary and ignore-list paths from the URI via
 * `Uri::to_file_path()`, which fails for non-file schemes. Real-looking file
 * URIs are what make "ignore" and "add word to this note" persist per note.
 *
 * @param {string} noteId
 * @param {string} workspaceDir Absolute path to the bridge workspace.
 * @returns {string}
 */
export function noteUri(noteId, workspaceDir) {
    const safe = String(noteId).replace(/[^A-Za-z0-9_-]/g, "_");
    return `file://${workspaceDir.replace(/\/+$/, "")}/notes/${safe}.md`;
}
