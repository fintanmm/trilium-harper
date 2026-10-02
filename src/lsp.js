/**
 * Minimal Language Server Protocol client over a byte stream.
 *
 * Speaks LSP base protocol (Content-Length framed JSON-RPC 2.0). Only the
 * subset Harper's `harper-ls` actually uses is implemented.
 */

import { EventEmitter } from "node:events";

const CONTENT_LENGTH = "Content-Length:";

export class LspClient extends EventEmitter {
    /**
     * @param {import("node:stream").Readable} input Stream carrying server -> client bytes.
     * @param {import("node:stream").Writable} output Stream for client -> server bytes.
     */
    constructor(input, output) {
        super();

        this._input = input;
        this._output = output;
        this._buffer = Buffer.alloc(0);
        this._nextId = 1;
        this._pending = new Map();
        this._closed = false;

        input.on("data", (chunk) => this._onData(chunk));
        input.on("close", () => this._onClose(new Error("LSP stream closed")));
        input.on("error", (err) => this._onClose(err));
    }

    /**
     * Sends a JSON-RPC request and resolves with its result.
     *
     * A `timeoutMs` is enforced per request. Without one, a server that never
     * answers leaves the promise pending forever, which keeps the process (or
     * a test runner) alive with no error to show for it.
     *
     * @template T
     * @param {string} method
     * @param {object} [params]
     * @param {number} [timeoutMs] Omit to wait indefinitely.
     * @returns {Promise<T>}
     */
    request(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (this._closed) {
                reject(new Error(`LSP client is closed, cannot request ${method}`));
                return;
            }

            const id = this._nextId++;
            /** @type {NodeJS.Timeout | undefined} */
            let timer;
            const settle = (fn, value) => {
                if (timer) clearTimeout(timer);
                fn(value);
            };

            if (timeoutMs !== undefined) {
                timer = setTimeout(() => {
                    // Drop the entry so a late reply is ignored rather than
                    // resolving an already-settled promise.
                    this._pending.delete(id);
                    reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                timer.unref();
            }

            this._pending.set(id, {
                resolve: (v) => settle(resolve, v),
                reject: (e) => settle(reject, e),
                method,
            });
            this._write({ jsonrpc: "2.0", id, method, params: params ?? null });
        });
    }

    /**
     * Sends a JSON-RPC notification (no response expected).
     * @param {string} method
     * @param {object} [params]
     */
    notify(method, params) {
        if (this._closed) return;
        this._write({ jsonrpc: "2.0", method, params: params ?? null });
    }

    /**
     * Answers a request the server sent to us. Harper pulls configuration on
     * every document update, so failing to answer stalls linting entirely.
     * @param {string|number} id
     * @param {*} result
     */
    respond(id, result) {
        if (this._closed) return;
        this._write({ jsonrpc: "2.0", id, result });
    }

    get closed() {
        return this._closed;
    }

    /** Rejects all in-flight requests; used when the process dies. */
    dispose(reason) {
        this._onClose(reason);
    }

    _write(message) {
        const json = JSON.stringify(message);
        const payload = Buffer.from(json, "utf8");
        this._output.write(`${CONTENT_LENGTH} ${payload.length}\r\n\r\n`);
        this._output.write(payload);
    }

    _onData(chunk) {
        this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
        this._drain();
    }

    _drain() {
        for (;;) {
            const headerEnd = this._buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;

            const header = this._buffer.subarray(0, headerEnd).toString("ascii");
            const match = /content-length:\s*(\d+)/i.exec(header);
            if (!match) {
                // Unrecoverable framing error: drop what we have rather than spin.
                this._buffer = Buffer.alloc(0);
                this._onClose(new Error(`Malformed LSP header: ${JSON.stringify(header)}`));
                return;
            }

            const length = Number.parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            if (this._buffer.length < bodyStart + length) return;

            const body = this._buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
            this._buffer = this._buffer.subarray(bodyStart + length);

            try {
                this._dispatch(JSON.parse(body));
            } catch (err) {
                this.emit("error", new Error(`Bad JSON-RPC payload: ${err.message}`));
            }
        }
    }

    _dispatch(message) {
        if (message.id !== undefined && message.method === undefined) {
            // Response to one of our requests.
            const pending = this._pending.get(message.id);
            if (!pending) return;
            this._pending.delete(message.id);

            if (message.error) {
                const { code, message: text } = message.error;
                pending.reject(new Error(`${pending.method} failed (${code}): ${text}`));
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        if (message.id !== undefined && message.method !== undefined) {
            // Server -> client request. Callers install an onRequest handler.
            this.emit("request", message);
            return;
        }

        // Server -> client notification.
        this.emit("notification", message);
    }

    _onClose(reason) {
        if (this._closed) return;
        this._closed = true;

        for (const pending of this._pending.values()) {
            pending.reject(reason);
        }
        this._pending.clear();

        this.emit("close", reason);
    }
}
