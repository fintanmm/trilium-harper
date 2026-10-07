/**
 * End-to-end test of the WebSocket bridge, exercising the exact message shapes
 * the Trilium frontend script sends and consumes.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";

import { ClientMessage, PROTOCOL_VERSION, ServerMessage } from "../src/protocol.js";
import { createBridge } from "../src/server.js";

const HAS_HARPER_LS = ["harper-ls", "/home/linuxbrew/.linuxbrew/bin/harper-ls"].some(
    (bin) => bin === "harper-ls" || existsSync(bin),
);

describe("bridge", { skip: HAS_HARPER_LS ? false : "harper-ls not installed" }, () => {
    /** @type {Awaited<ReturnType<typeof createBridge>>} */
    let bridge;
    let workspace;
    /** @type {WebSocket} */
    let socket;
    /** Messages received but not yet claimed by a waiter. */
    const inbox = [];
    let nextRequestId = 1;

    /**
     * Opens a socket with its message handler already attached.
     *
     * The bridge greets a client the moment the socket opens, so waiting for
     * `open` before subscribing can lose the welcome.
     *
     * @param {string} url
     * @param {object} [options] Passed to `ws` — used to fake an `Origin`.
     */
    const open = (url, options) =>
        new Promise((resolve, reject) => {
            const ws = new WebSocket(url, [], options);
            ws.on("message", (raw) => {
                const msg = JSON.parse(raw.toString());
                const waiter = inbox.find((w) => w.match(msg));
                if (waiter) {
                    inbox.splice(inbox.indexOf(waiter), 1);
                    waiter.resolve(msg);
                } else {
                    inbox.push(msg);
                }
            });
            ws.once("open", () => resolve(ws));
            ws.once("error", reject);
        });

    /**
     * Resolves with the first buffered or future message satisfying `match`.
     *
     * Messages are buffered rather than dropped when no waiter is registered:
     * the bridge greets a client the instant the socket opens, which can easily
     * beat the first `it()` block.
     */
    const waitFor = (match, timeoutMs = 20_000) => {
        const buffered = inbox.findIndex((m) => match(m));
        if (buffered !== -1) return Promise.resolve(inbox.splice(buffered, 1)[0]);

        return new Promise((resolve, reject) => {
            const waiter = { match, resolve };
            inbox.push(waiter);
            setTimeout(() => {
                const i = inbox.indexOf(waiter);
                if (i !== -1) {
                    inbox.splice(i, 1);
                    reject(new Error("timed out waiting for bridge message"));
                }
            }, timeoutMs).unref();
        });
    };

    before(async () => {
        workspace = mkdtempSync(join(tmpdir(), "harper-bridge-ws-"));
        bridge = await createBridge({
            port: 0,
            workspaceDir: workspace,
            token: "test-token",
            onLog: () => {},
        });

        socket = await open(`${bridge.url}?token=test-token`);
    });

    after(async () => {
        socket?.close();
        await bridge?.close();
        rmSync(workspace, { recursive: true, force: true });
    });

    const request = (type, payload) => {
        const id = nextRequestId++;
        const reply = waitFor((m) => m.type !== ServerMessage.WELCOME && m.id === id);
        socket.send(JSON.stringify({ type, id, ...payload }));
        return reply;
    };

    it("greets an authorized client with the protocol version", async () => {
        const welcome = await waitFor((m) => m.type === ServerMessage.WELCOME);
        assert.equal(welcome.protocolVersion, PROTOCOL_VERSION);
        assert.equal(welcome.host, "127.0.0.1");
        assert.equal(welcome.port, bridge.port, "must report the port actually bound");
        assert.ok(welcome.port > 0);
    });

    it("rejects a client with a wrong token", async () => {
        const bad = await open(`${bridge.url}?token=wrong`);
        const code = await new Promise((resolve) => {
            bad.once("close", resolve);
            bad.once("error", () => resolve("error"));
        });
        assert.equal(code, 1008, "should be closed as a policy violation");
    });

    it("round-trips a lint request and returns offsets", async () => {
        const noteId = "note-round-trip";
        // No `uri` is sent: the bridge must derive it from the note id.
        const reply = await request(ClientMessage.LINT, { noteId, text: "Zorbulax is wibbly." });

        assert.equal(reply.type, ServerMessage.LINT_RESULT);
        assert.equal(reply.noteId, noteId);
        assert.equal(reply.uri, bridge.noteUri(noteId));
        assert.ok(reply.lints.length > 0, "expected at least one lint");
        assert.equal(reply.lints[0].range.start.line, 0);
        assert.equal(typeof reply.durationMs, "number");
    });

    it("returns a usable fix and helper commands for a lint", async () => {
        const noteId = "note-fixes";

        const linted = await request(ClientMessage.LINT, { noteId, text: "Zorbulax is wibbly." });
        const target = linted.lints.find((l) => l.message.includes("Zorbulax"));
        assert.ok(target, "expected a lint on Zorbulax");

        const reply = await request(ClientMessage.CODE_ACTION, { noteId, range: target.range });
        assert.equal(reply.type, ServerMessage.CODE_ACTION_RESULT);
        assert.equal(reply.noteId, noteId);

        const edits = reply.actions.filter((a) => a.kind === "edit");
        assert.ok(edits.length > 0, "expected at least one replacement");
        for (const edit of edits) {
            assert.equal(typeof edit.title, "string");
            assert.equal(typeof edit.newText, "string");
            assert.ok(edit.newText.length > 0, `empty replacement in ${edit.title}`);
            // Ranges must be addressable, not collapsed onto the request range.
            assert.equal(typeof edit.range.start.line, "number");
            assert.equal(typeof edit.range.start.character, "number");
        }

        const commands = reply.actions.filter((a) => a.kind === "command").map((a) => a.command);
        assert.ok(commands.includes("HarperIgnoreLint"), `got ${JSON.stringify(commands)}`);
        assert.ok(commands.some((c) => c.startsWith("HarperAddTo")), `got ${JSON.stringify(commands)}`);
    });

    it("applies a dictionary command that is visible to later lints", async () => {
        const noteId = "note-dict";
        const word = "Zorbulax";

        const before = await request(ClientMessage.LINT, { noteId, text: `${word} is wibbly.` });
        assert.ok(before.lints.some((l) => l.message.includes(word)), "precondition: word is unknown");

        const result = await request(ClientMessage.COMMAND, {
            name: "HarperAddToUserDict",
            args: [word, before.uri],
        });
        assert.equal(result.type, ServerMessage.COMMAND_RESULT);
        assert.equal(result.name, "HarperAddToUserDict");

        // The bridge pins every dictionary inside its own workspace, so this
        // must not touch the real ~/.config/harper-ls.
        const userDict = join(workspace, "user-dictionary.txt");
        assert.ok(existsSync(userDict), `expected Harper to have written ${userDict}`);
        assert.match(readFileSync(userDict, "utf8"), new RegExp(word));
        assert.ok(
            !existsSync(join(homedir(), ".config", "harper-ls", "dictionary.txt")),
            "the bridge must not write to the user's global Harper config",
        );

        const after = await request(ClientMessage.LINT, { noteId, text: `${word} is wibbly.` });
        assert.ok(
            !after.lints.some((l) => l.message.includes(word)),
            "the word should no longer be flagged after being added",
        );
    });

    it("ignores malformed frames instead of dropping the connection", async () => {
        socket.send("not json at all");
        socket.send(JSON.stringify({ type: "nonsense" }));
        socket.send(JSON.stringify({ type: ClientMessage.LINT, id: "not-a-number" }));

        // The connection must still work afterwards. A fresh word is used
        // because an earlier test deliberately added one to the dictionary.
        const reply = await request(ClientMessage.LINT, {
            noteId: "note-after-garbage",
            text: "Wibblyflarn.",
        });
        assert.equal(reply.type, ServerMessage.LINT_RESULT);
        assert.ok(reply.lints.length > 0, "expected the unknown word to be flagged");
    });

    it("maps note ids to stable file URIs", () => {
        const a = bridge.noteUri("abc123");
        const b = bridge.noteUri("abc123");
        assert.equal(a, b, "same note id must map to the same uri");
        assert.match(a, /^file:\/\/.*\/notes\/abc123\.md$/);
        assert.notEqual(bridge.noteUri("abc123"), bridge.noteUri("def456"));
        // Path separators and traversal must not escape the notes directory.
        assert.match(bridge.noteUri("../../etc/passwd"), /\/notes\/______etc_passwd\.md$/);
    });

    it("rejects a foreign origin", async () => {
        const foreign = await open(`${bridge.url}?token=test-token`, { origin: "https://evil.example" });
        const code = await new Promise((resolve) => {
            foreign.once("close", resolve);
            foreign.once("error", () => resolve("error"));
        });
        assert.equal(code, 1008, "should be closed as a policy violation");
    });

    // Last: connecting a new client replaces the shared `socket` above.
    it("accepts the Trilium desktop app's custom-scheme origin", async () => {
        const desktop = await open(`${bridge.url}?token=test-token`, { origin: "trilium-app://app" });
        const welcome = await waitFor((m) => m.type === ServerMessage.WELCOME);
        assert.equal(welcome.protocolVersion, PROTOCOL_VERSION);
        desktop.close();
    });
});
