/* eslint-env browser */
/**
 * Harper grammar checking for Trilium Notes.
 *
 * Attach this file to a note and run it as a frontend script
 * (`#run=frontendStartup`). It connects to the local bridge
 * (`src/server.js`), which owns a `harper-ls` process, and renders inline
 * squiggles plus a click-to-fix menu.
 *
 * ── Setup ────────────────────────────────────────────────────────────────────
 * 1. Start the bridge:  npm start      (or the systemd user unit)
 * 2. Copy the token it prints into CONFIG below.
 * 3. Reload Trilium.
 *
 * The bridge binds to loopback only. If you browse Trilium from another
 * machine, point HOST at an address the bridge can actually be reached on, or
 * tunnel it:  ssh -L 4000:127.0.0.1:4000 you@trilium-host
 * ─────────────────────────────────────────────────────────────────────────────
 */

const CONFIG = {
    HOST: "127.0.0.1",
    PORT: 4000,
    // Printed by the bridge on startup.
    TOKEN: "PASTE-YOUR-BRIDGE-TOKEN-HERE",

    /** Idle time in ms after the last keystroke before re-linting. */
    DEBOUNCE_MS: 600,
    /** Shortest document worth linting. */
    MIN_LENGTH: 24,
    /** Above this, skip linting entirely; Harper's own limit is lower. */
    MAX_LENGTH: 200_000,
    /** Show a dot in the toolbar when the bridge is unreachable. */
    SHOW_STATUS: true,
    /** Console output in the Trilium devtools. Set false once it all works. */
    DEBUG: true,
};

(function bootstrap(global) {
    "use strict";

    /* ───────────────────────── logging ───────────────────────── */

    /** Everything the script does, gated on `CONFIG.DEBUG`. */
    const log = (...args) => {
        if (CONFIG.DEBUG) console.log("[harper]", ...args);
    };
    /** Genuine failures — still printed with `DEBUG` off. */
    const logError = (...args) => console.error("[harper]", ...args);
    /** Log only the first time something happens for a given note. */
    const once = (key, ...args) => {
        if (once.seen.has(key)) return;
        once.seen.add(key);
        log(...args);
    };
    once.seen = new Set();

    /* ───────────────────────── pure helpers ───────────────────────── */

    /**
     * Turns the editor's view tree into the plain text sent to Harper, plus a
     * table that maps offsets in that text back to editor positions.
     *
     * Code is masked rather than removed: replacing a run of characters with
     * spaces keeps every later offset identical to the editor's, so a lint
     * range needs no correction when it is turned into a squiggle. Newlines
     * inside code blocks are preserved so line numbers still line up.
     *
     * @param {object} root CKEditor view root element.
     * @returns {{text: string, segments: Array<object>}}
     */
    function buildWireText(root) {
        const segments = [];
        let text = "";

        const emitText = (node, masked) => {
            const data = typeof node.data === "string" ? node.data : "";
            if (data === "") return;
            segments.push({
                wireStart: text.length,
                wireEnd: text.length + data.length,
                parent: node,
                nodeOffset: 0,
                masked,
            });
            text += masked ? data.replace(/[^\n]/g, " ") : data;
        };

        const visit = (node, inCode) => {
            if (node.is && node.is("element")) {
                // View elements carry `name`; older builds expose `getName()`.
                const name = typeof node.getName === "function" ? node.getName() : node.name;
                // `pre` is a code block, `code` is inline code.
                const nowCode = inCode || name === "pre" || name === "code";

                if (name === "br") {
                    // A soft break occupies one character in our text but no
                    // text node in the view, so it is recorded as a boundary.
                    segments.push({
                        wireStart: text.length,
                        wireEnd: text.length + 1,
                        parent: node.parent,
                        nodeOffset: childIndexOf(node),
                        break: true,
                    });
                    text += "\n";
                    return;
                }

                for (const child of node.getChildren()) visit(child, nowCode);
                return;
            }

            emitText(node, inCode);
        };

        // `getChildren()` is iterable-only, so materialise it before indexing.
        const blocks = [...root.getChildren()];
        blocks.forEach((block, index) => {
            visit(block, false);
            if (index < blocks.length - 1) text += "\n";
        });

        return { text, segments };
    }

    /**
     * Converts an LSP `Position` into an offset in the wire text.
     *
     * `character` is a UTF-16 code unit index, which is exactly what a
     * JavaScript string offset is, so no conversion is needed.
     *
     * @param {string} text
     * @param {{line: number, character: number}} position
     * @returns {number} Offset, clamped to the text.
     */
    function positionToOffset(text, position) {
        let line = 0;
        let offset = 0;
        while (line < position.line) {
            const next = text.indexOf("\n", offset);
            if (next === -1) return text.length;
            offset = next + 1;
            line += 1;
        }
        // Clamp to the end of this line rather than the end of the document, so
        // an out-of-range character cannot leak into the following line.
        const lineEnd = text.indexOf("\n", offset);
        const limit = lineEnd === -1 ? text.length : lineEnd;
        return offset + Math.min(position.character, Math.max(0, limit - offset));
    }

    /**
     * Position just past the last character a segment stands for.
     *
     * @param {object} segment
     * @returns {{parent: object, offset: number}}
     */
    function endOf(segment) {
        return { parent: segment.parent, offset: segment.nodeOffset + (segment.wireEnd - segment.wireStart) };
    }

    /**
     * The index of `node` among its parent's children.
     *
     * View elements carry neither `.index` nor `.offset`, so the index has to
     * be counted; otherwise a `<br>` would always claim to be the parent's
     * first child.
     *
     * @param {object} node
     * @returns {number}
     */
    function childIndexOf(node) {
        const parent = node.parent;
        if (!parent || typeof parent.getChildren !== "function") return 0;

        let index = 0;
        for (const child of parent.getChildren()) {
            if (child === node) return index;
            index += 1;
        }
        return 0;
    }

    /**
     * Resolves a wire offset to the view position it corresponds to.
     *
     * @param {Array<object>} segments
     * @param {number} offset
     * @returns {{parent: object, offset: number} | null}
     */
    function offsetToPosition(segments, offset) {
        if (segments.length === 0) return null;

        // An offset at the very end of the document follows the last segment.
        let segment = segments[segments.length - 1];
        for (const candidate of segments) {
            if (offset < candidate.wireEnd) {
                segment = candidate;
                break;
            }
        }

        if (segment.break) {
            // Before or after the <br>, depending on which side we landed.
            return { parent: segment.parent, offset: segment.nodeOffset + (offset > segment.wireStart ? 1 : 0) };
        }

        // The newline joining two blocks is in no segment: an offset landing on
        // it would produce a negative column, and the resulting view range is
        // rejected by the DOM converter. Park on the end of the block before it.
        if (offset < segment.wireStart) {
            const previous = segments[segments.indexOf(segment) - 1];
            return previous ? endOf(previous) : { parent: segment.parent, offset: segment.nodeOffset };
        }

        // An offset past the last segment (the document's trailing newline)
        // would overshoot the text node and be rejected as an invalid range.
        const local = Math.min(offset - segment.wireStart, segment.wireEnd - segment.wireStart);
        return { parent: segment.parent, offset: segment.nodeOffset + local };
    }

    /**
     * Builds a view range for an LSP range over the given document snapshot.
     * @returns {object | null} A CKEditor ViewRange, or null if unmappable.
     */
    function toViewRange(view, segments, text, range) {
        const start = offsetToPosition(segments, positionToOffset(text, range.start));
        const end = offsetToPosition(segments, positionToOffset(text, range.end));
        if (!start || !end) return null;

        return view.createRange(
            view.createPositionAt(start.parent, start.offset),
            view.createPositionAt(end.parent, end.offset),
        );
    }

    /**
     * Suggestion-box colours that match the page underneath.
     *
     * Trilium ships light and dark themes and the script cannot know which one
     * is active, so the box samples the background it floats over and picks a
     * palette from its luminance.
     *
     * @param {number} r 0-255
     * @param {number} g 0-255
     * @param {number} b 0-255
     * @returns {object} CSS custom properties, ready to assign on the popover.
     */
    function paletteFor(r, g, b) {
        // Rec. 709 relative luminance over the sRGB values computed styles give.
        const channel = (c) => {
            const v = c / 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

        return luminance > 0.4
            ? {
                  "--hp-surface": "#ffffff",
                  "--hp-text": "#1c1f26",
                  "--hp-muted": "#5b6470",
                  "--hp-border": "rgba(15, 23, 42, .12)",
                  "--hp-hover": "rgba(41, 128, 185, .14)",
              }
            : {
                  "--hp-surface": "#1f2430",
                  "--hp-text": "#e8ecf3",
                  "--hp-muted": "#a7b0be",
                  "--hp-border": "rgba(255, 255, 255, .14)",
                  "--hp-hover": "rgba(96, 165, 250, .18)",
              };
    }

    /**
     * The first opaque background colour above `element`, because the editor
     * itself is usually transparent and the theme lives on an ancestor.
     *
     * @param {Element} element
     * @returns {[number, number, number]}
     */
    function backgroundOf(element) {
        for (let node = element; node; node = node.parentElement) {
            const raw = getComputedStyle(node).backgroundColor;
            const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(raw ?? "");
            if (!match) continue;
            if (match[4] !== undefined && Number(match[4]) === 0) continue;
            return [Number(match[1]), Number(match[2]), Number(match[3])];
        }
        return [255, 255, 255];
    }

    /** Exposed for the unit tests, which drive these against a fake view tree. */
    const pure = { buildWireText, positionToOffset, offsetToPosition, paletteFor };

    /**
     * Orders two model positions, deepest path first, so a batch of edits can
     * be applied in reverse document order without invalidating each other.
     */
    function comparePositions(a, b) {
        const pathA = a.path ?? [];
        const pathB = b.path ?? [];
        const shared = Math.min(pathA.length, pathB.length);
        for (let i = 0; i < shared; i += 1) {
            if (pathA[i] !== pathB[i]) return pathA[i] - pathB[i];
        }
        if (pathA.length !== pathB.length) return pathA.length - pathB.length;
        return a.offset - b.offset;
    }

    /* ───────────────────────── websocket client ───────────────────────── */

    class Bridge {
        constructor(config) {
            this.config = config;
            this.socket = null;
            this.nextId = 1;
            this.pending = new Map();
            this.connected = false;
            this.onStatus = () => {};
        }

        connect() {
            const origin = `ws://${this.config.HOST}:${this.config.PORT}`;
            const url = `${origin}?token=${encodeURIComponent(this.config.TOKEN)}`;
            log("connecting to", origin);

            let socket;
            try {
                socket = new WebSocket(url);
            } catch (err) {
                logError("could not create WebSocket:", err.message);
                this.onStatus("unreachable");
                return;
            }

            socket.onopen = () => {
                this.connected = true;
                log("connected to", origin);
                this.onStatus("connected");
            };
            socket.onclose = (event) => {
                this.connected = false;
                log(`closed (code=${event.code}); retrying in 3s`);
                this.onStatus("disconnected");
                // A note switch can leave the bridge holding our document.
                for (const { reject } of this.pending.values()) reject(new Error("bridge closed"));
                this.pending.clear();
                setTimeout(() => this.connect(), 3000);
            };
            socket.onerror = () => {
                logError(`socket error talking to ${origin} — is the bridge running?`);
                this.onStatus("error");
            };
            socket.onmessage = (event) => this._onMessage(event.data);

            this.socket = socket;
        }

        _onMessage(raw) {
            let msg;
            try {
                msg = JSON.parse(raw);
            } catch {
                logError("could not parse a message from the bridge");
                return;
            }
            if (typeof msg.id !== "number") {
                log("ignoring a message with no id:", msg.type);
                return;
            }
            const entry = this.pending.get(msg.id);
            if (!entry) {
                log(`no pending request for id=${msg.id} (${msg.type})`);
                return;
            }
            this.pending.delete(msg.id);
            if (msg.type === "error") {
                logError(`bridge error for ${entry.type} id=${msg.id}:`, msg.message);
                entry.reject(new Error(msg.message));
            } else {
                log(`← ${entry.type} id=${msg.id}`);
                entry.resolve(msg);
            }
        }

        request(type, payload, timeoutMs = 30_000) {
            return new Promise((resolve, reject) => {
                if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                    logError(`cannot send ${type}: bridge not connected`);
                    reject(new Error("bridge not connected"));
                    return;
                }
                const id = this.nextId++;
                const chars = typeof payload?.text === "string" ? ` chars=${payload.text.length}` : "";
                const note = payload?.noteId ? ` note=${payload.noteId}` : "";
                log(`→ ${type} id=${id}${note}${chars}`);
                this.pending.set(id, { resolve, reject, type });
                this.socket.send(JSON.stringify({ type, id, ...payload }));
                setTimeout(() => {
                    if (this.pending.delete(id)) {
                        logError(`${type} id=${id} timed out after ${timeoutMs}ms`);
                        reject(new Error(`${type} timed out`));
                    }
                }, timeoutMs).unref?.();
            });
        }
    }

    /* ───────────────────────── per-note session ───────────────────────── */

    /** @type {Map<string, object>} noteId -> session */
    const sessions = new Map();

    function overlayStyle() {
        if (document.getElementById("harper-overlay-style")) return;
        const style = document.createElement("style");
        style.id = "harper-overlay-style";
        style.textContent = `
            .harper-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 20; overflow: hidden; }
            .harper-overlay .harper-mark {
                position: absolute; pointer-events: auto; cursor: pointer;
                background-repeat: repeat-x; background-size: 6px 3px; border-radius: 1px;
                /* Fallback: harper-ls labels every diagnostic with one severity
                   (hint by default), and an unmatched value must still paint. */
                background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='M0 2 q 1.5 -2 3 0 t 3 0' fill='none' stroke='%23c0392b' stroke-width='1'/></svg>");
            }
            .harper-overlay .harper-mark[data-severity="1"] { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='M0 2 q 1.5 -2 3 0 t 3 0' fill='none' stroke='%23c0392b' stroke-width='1'/></svg>"); }
            .harper-overlay .harper-mark[data-severity="2"] { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='M0 2 q 1.5 -2 3 0 t 3 0' fill='none' stroke='%23d35400' stroke-width='1'/></svg>"); }
            .harper-overlay .harper-mark[data-severity="3"] { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='M0 2 q 1.5 -2 3 0 t 3 0' fill='none' stroke='%238e44ad' stroke-width='1'/></svg>"); }
            .harper-overlay .harper-mark[data-severity="4"] { background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='M0 2 q 1.5 -2 3 0 t 3 0' fill='none' stroke='%232980b9' stroke-width='1'/></svg>"); }
            .harper-popover {
                position: fixed; z-index: 1000; min-width: 200px; max-width: 360px;
                background: var(--hp-surface, #fff); color: var(--hp-text, #1c1f26);
                border: 1px solid var(--hp-border, rgba(15, 23, 42, .12)); border-radius: 10px;
                box-shadow: 0 12px 32px rgba(0,0,0,.24), 0 2px 8px rgba(0,0,0,.1);
                padding: 6px; font-size: 13px; line-height: 1.45;
            }
            .harper-popover .harper-msg {
                padding: 6px 10px 8px; margin-bottom: 4px; font-size: 12px;
                color: var(--hp-muted, #5b6470);
                border-bottom: 1px solid var(--hp-border, rgba(15, 23, 42, .1));
            }
            .harper-popover .harper-empty {
                padding: 8px 10px; font-size: 12px; color: var(--hp-muted, #5b6470);
            }
            .harper-popover button {
                display: block; width: 100%; text-align: left; background: none; border: 0;
                border-radius: 6px; padding: 7px 10px; cursor: pointer; font: inherit; color: inherit;
            }
            .harper-popover button:hover, .harper-popover button:focus-visible {
                background: var(--hp-hover, rgba(41, 128, 185, .14)); outline: none;
            }
            .harper-popover .harper-sep { height: 1px; background: var(--hp-border, rgba(15, 23, 42, .1)); margin: 4px 8px; }
        `;
        document.head.appendChild(style);
    }

    class Session {
        constructor(noteId, noteContext, editor) {
            this.noteId = noteId;
            this.noteContext = noteContext;
            this.editor = editor;
            this.revision = 0;
            this.lints = [];
            this.debounceTimer = null;
            this.popover = null;

            overlayStyle();
            this.overlay = document.createElement("div");
            this.overlay.className = "harper-overlay";

            this._onModelChange = () => {
                this.revision += 1;
                this.scheduleLint();
            };
            editor.model.document.on("change:data", this._onModelChange);
            log(`session attached: note=${noteId}`);
        }

        dispose() {
            this.editor.model.document.off("change:data", this._onModelChange);
            clearTimeout(this.debounceTimer);
            this.overlay.remove();
            this.hidePopover();
            log(`session disposed: note=${this.noteId}`);
        }

        /**
         * Keeps the overlay parked on `document.body`.
         *
         * It used to live inside CKEditor's editable, which owns that subtree
         * and evicts foreign children on its next render — the marks survived
         * in the overlay but the overlay itself was no longer in the document,
         * so nothing could be seen. Body-level marks use viewport coordinates
         * directly, like the popover already does.
         */
        attachOverlay() {
            if (!document.body) return;
            if (this.overlay.parentElement !== document.body) document.body.appendChild(this.overlay);
            if (!document.contains(this.overlay)) {
                once(`overlay:${this.noteId}`, `overlay for note=${this.noteId} is not in the document`);
            }
        }

        scheduleLint() {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => this.lint(), CONFIG.DEBOUNCE_MS);
        }

        async lint() {
            const snapshot = buildWireText(this.editor.editing.view.document.getRoot());

            if (
                snapshot.text.trim().length < CONFIG.MIN_LENGTH ||
                snapshot.text.length > CONFIG.MAX_LENGTH
            ) {
                log(
                    `lint skipped for note=${this.noteId}: ` +
                        `${snapshot.text.length} chars (min ${CONFIG.MIN_LENGTH}, max ${CONFIG.MAX_LENGTH})`,
                );
                this.render([], snapshot);
                return;
            }

            // Anything that comes back was computed against this revision. If
            // the note changed while we were waiting, the ranges are stale and
            // must not be drawn or applied.
            const requestedRevision = this.revision;

            let reply;
            try {
                reply = await bridge.request("lint", {
                    noteId: this.noteId,
                    text: snapshot.text,
                });
            } catch (err) {
                logError(`lint failed for note=${this.noteId}:`, err.message);
                if (CONFIG.SHOW_STATUS) api.showError(`Harper: ${err.message}`);
                return;
            }

            if (this.revision !== requestedRevision) {
                log(`dropping stale lint for note=${this.noteId} (revision ${requestedRevision} != ${this.revision})`);
                return;
            }

            const lints = reply.lints ?? [];
            log(
                `lint note=${this.noteId}: ${lints.length} finding${lints.length === 1 ? "" : "s"}` +
                    `${reply.durationMs !== undefined ? ` in ${reply.durationMs}ms` : ""}`,
            );
            this.snapshot = snapshot;
            this.render(lints, snapshot);
        }

        render(lints, snapshot) {
            const current = snapshot ?? this.snapshot;
            this.lints = lints;
            this.overlay.textContent = "";
            this.attachOverlay();

            // Scroll and resize redraw too; only report a fresh lint result.
            const fresh = this._lastRendered !== lints;
            this._lastRendered = lints;

            if (!current) {
                if (fresh && lints.length > 0) {
                    log(`render: ${lints.length} finding(s) but no snapshot — nothing drawn`);
                }
                return;
            }

            // The overlay is fixed to the viewport, so client rects are used as
            // they come — no host to subtract.
            const view = this.editor.editing.view;

            let marks = 0;
            let unmapped = 0;

            for (const [index, lint] of lints.entries()) {
                // One unmappable finding must not cost the rest their squiggles.
                let domRange;
                try {
                    const range = toViewRange(view, current.segments, current.text, lint.range);
                    if (!range) throw new Error("no view range");
                    domRange = view.domConverter.viewRangeToDom(range);
                } catch (err) {
                    unmapped += 1;
                    if (fresh) {
                        log(
                            `no DOM range for: ${lint.message} ` +
                                `@${lint.range.start.line}:${lint.range.start.character} (${err.message})`,
                        );
                    }
                    continue;
                }

                if (!domRange) {
                    unmapped += 1;
                    if (fresh) log(`view range with no DOM range for: ${lint.message}`);
                    continue;
                }

                let drawn = 0;
                for (const rect of domRange.getClientRects()) {
                    // A collapsed range yields a rect with no width: it would
                    // otherwise be counted as drawn while painting nothing.
                    if (rect.width <= 0 || rect.height <= 0) {
                        if (fresh) {
                            log(`empty rect for: ${lint.message} (w=${rect.width} h=${rect.height})`);
                        }
                        continue;
                    }
                    const mark = document.createElement("div");
                    mark.className = "harper-mark";
                    mark.dataset.severity = String(lint.severity ?? 3);
                    mark.title = lint.message;
                    mark.style.left = `${rect.left}px`;
                    mark.style.top = `${rect.bottom - 3}px`;
                    mark.style.width = `${rect.width}px`;
                    mark.style.height = "3px";
                    mark.addEventListener("mousedown", (event) => {
                        event.preventDefault();
                        this.showFixes(index, rect);
                    });
                    this.overlay.appendChild(mark);
                    drawn += 1;
                }
                if (fresh && drawn === 0) {
                    log(`finding drew no squiggle (no client rects): ${lint.message}`);
                }
                marks += drawn;
            }

            if (fresh) {
                log(
                    `render note=${this.noteId}: ${lints.length} finding(s) → ${marks} mark(s)` +
                        (unmapped ? `, ${unmapped} unmapped` : ""),
                );
            }
        }

        async showFixes(index, anchorRect) {
            const lint = this.lints[index];
            if (!lint) return;

            let reply;
            try {
                reply = await bridge.request("codeAction", {
                    noteId: this.noteId,
                    range: lint.range,
                });
            } catch (err) {
                logError(`codeAction failed for note=${this.noteId}:`, err.message);
                api.showError(`Harper: ${err.message}`);
                return;
            }

            this.hidePopover();
            const popover = document.createElement("div");
            popover.className = "harper-popover";
            // Match the theme Trilium is actually running, not a hardcoded one.
            for (const [name, value] of Object.entries(paletteFor(...backgroundOf(document.body)))) {
                popover.style.setProperty(name, value);
            }

            const message = document.createElement("div");
            message.className = "harper-msg";
            message.textContent = lint.message;
            popover.appendChild(message);

            const separator = () => {
                const sep = document.createElement("div");
                sep.className = "harper-sep";
                popover.appendChild(sep);
            };

            const edits = reply.actions.filter((a) => a.kind === "edit");
            const commands = reply.actions.filter((a) => a.kind === "command");
            log(`code actions note=${this.noteId}: ${edits.length} edit(s), ${commands.length} command(s)`);

            for (const action of edits) {
                popover.appendChild(this.menuItem(action.title, () => this.applyEdit(action)));
            }
            if (edits.length > 0 && commands.length > 0) separator();

            for (const action of commands) {
                popover.appendChild(
                    this.menuItem(action.title, async () => {
                        this.hidePopover();
                        try {
                            await bridge.request("command", {
                                name: action.command,
                                args: action.arguments ?? [],
                            });
                            this.scheduleLint();
                        } catch (err) {
                            logError(`command ${action.command} failed:`, err.message);
                            api.showError(`Harper: ${err.message}`);
                        }
                    }),
                );
            }

            if (edits.length === 0 && commands.length === 0) {
                const empty = document.createElement("div");
                empty.className = "harper-empty";
                empty.textContent = "No suggestions for this finding.";
                popover.appendChild(empty);
            }

            document.body.appendChild(popover);

            // Keep the menu on screen.
            const box = popover.getBoundingClientRect();
            const left = Math.min(anchorRect.left, window.innerWidth - box.width - 8);
            const top =
                anchorRect.bottom + box.height + 8 > window.innerHeight
                    ? anchorRect.top - box.height - 4
                    : anchorRect.bottom + 4;
            popover.style.left = `${Math.max(8, left)}px`;
            popover.style.top = `${Math.max(8, top)}px`;

            this.popover = popover;
        }

        menuItem(label, onClick) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.addEventListener("click", onClick);
            return button;
        }

        async applyEdit(action) {
            this.hidePopover();
            const snapshot = this.snapshot;
            if (!snapshot) return;

            const view = this.editor.editing.view;
            const mapper = this.editor.editing.mapper;

            // Every edit carries its own range and text, so a multi-range fix is
            // just several of them.
            const edits = (action.edits ?? [{ range: action.range, newText: action.newText }])
                .map((edit) => {
                    const range = toViewRange(view, snapshot.segments, snapshot.text, edit.range);
                    if (!range) return null;
                    const modelRange = mapper.toModelRange(range);
                    if (!modelRange) return null;
                    return { modelRange, newText: edit.newText ?? "" };
                })
                .filter(Boolean);

            if (edits.length === 0) {
                log(`fix "${action.title}" mapped to no edits for note=${this.noteId}`);
                return;
            }

            // Back to front, so replacing an earlier range cannot shift a later
            // one out from under us.
            edits.sort((a, b) => comparePositions(b.modelRange.start, a.modelRange.start));

            this.editor.model.change((writer) => {
                for (const edit of edits) {
                    writer.remove(edit.modelRange);
                    writer.insertText(edit.newText, edit.modelRange.start);
                }
            });
            log(`applied ${edits.length} edit(s): ${JSON.stringify(edits.map((e) => e.newText))}`);

            // Tell Harper the lint was acted on, for its statistics.
            if (action.then) {
                bridge
                    .request("command", { name: action.then.command, args: action.then.arguments })
                    .catch(() => {});
            }
        }

        hidePopover() {
            this.popover?.remove();
            this.popover = null;
        }
    }

    /* ───────────────────────── lifecycle ───────────────────────── */

    const bridge = new Bridge(CONFIG);
    let statusDot = null;

    function setStatus(state) {
        if (!CONFIG.SHOW_STATUS) return;
        if (!statusDot) {
            statusDot = document.createElement("div");
            statusDot.style.cssText =
                "position:fixed;bottom:10px;right:10px;z-index:9999;width:10px;height:10px;border-radius:50%;background:#bbb;pointer-events:none;";
            document.body.appendChild(statusDot);
        }
        statusDot.style.background =
            state === "connected" ? "#2ecc71" : state === "error" ? "#e74c3c" : "#f39c12";
    }

    /**
     * Walks the open note contexts, attaching a session to each text editor and
     * dropping sessions whose note has closed.
     */
    async function sync() {
        try {
            const contexts = api.getNoteContexts();
            const seen = new Set();

            for (const noteContext of contexts) {
                const note = noteContext.note;
                if (!note || !note.noteId) continue;
                if (note.type !== "text" && note.type !== "textAndHtml") continue;
                seen.add(note.noteId);

                if (sessions.has(note.noteId)) continue;

                const editor = await noteContext.getTextEditor();
                if (!editor || !editor.model) {
                    once(`editor:${note.noteId}`, `waiting for a text editor on note=${note.noteId}`);
                    continue;
                }

                sessions.set(note.noteId, new Session(note.noteId, noteContext, editor));
            }

            for (const [noteId, session] of sessions) {
                if (seen.has(noteId)) continue;
                session.dispose();
                sessions.delete(noteId);
            }
        } catch (err) {
            // The API is unavailable during Trilium's own teardown; ignore.
            log("sync skipped:", err?.message ?? err);
        }
    }

    bridge.onStatus = setStatus;
    log(
        `frontend starting: bridge=ws://${CONFIG.HOST}:${CONFIG.PORT} ` +
            `debounce=${CONFIG.DEBOUNCE_MS}ms min=${CONFIG.MIN_LENGTH} chars debug=${CONFIG.DEBUG}`,
    );
    bridge.connect();

    // Attach to whatever is open now, and keep up as tabs come and go.
    sync();
    const poll = setInterval(sync, 2000);

    // Redraw on scroll and resize; the overlay is absolutely positioned.
    const reposition = () => {
        for (const session of sessions.values()) session.render(session.lints, session.snapshot);
    };
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    // Capture phase: CKEditor handles keys inside the editable first and stops
    // propagation, so a bubble-phase listener would never see Escape.
    // Escape dismisses the suggestion box; Ctrl/Cmd-. toggles squiggles.
    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key === "Escape") {
                const open = [...sessions.values()].filter((session) => session.popover);
                if (open.length === 0) return;
                for (const session of open) session.hidePopover();
                event.preventDefault();
                event.stopPropagation();
                log(`suggestion box dismissed with Escape (${open.length} open)`);
                return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key === ".") {
                event.preventDefault();
                for (const session of sessions.values()) {
                    session.overlay.style.display = session.overlay.style.display === "none" ? "" : "none";
                }
            }
        },
        true,
    );

    global.HarperTrilium = { CONFIG, pure, bridge, sessions, sync, log, dispose: () => clearInterval(poll) };
})(typeof window !== "undefined" ? window : globalThis);
