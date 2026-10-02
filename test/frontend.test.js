/**
 * Unit tests for the editor-side logic in the Trilium frontend script.
 *
 * The script is a browser classic script, so it is evaluated in a `vm` sandbox
 * with the minimum globals it touches at load time. That keeps these tests
 * running against the exact file that ships, with no build step and no copy of
 * the logic to drift out of sync.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "trilium", "harper-frontend.js");

/** Loads the frontend script far enough to expose its pure helpers. */
function loadFrontend() {
    const sandbox = {
        console,
        // The script wires up listeners and starts a poll on load; stub the
        // surface it reaches for so loading has no side effects.
        document: {
            addEventListener() {},
            createElement: () => ({ style: {}, dataset: {}, appendChild() {}, remove() {}, addEventListener() {} }),
            getElementById: () => null,
            head: { appendChild() {} },
            body: { appendChild() {} },
        },
        window: { innerWidth: 1280, innerHeight: 800, addEventListener() {} },
        setTimeout,
        setInterval: () => 0,
        clearInterval() {},
        clearTimeout,
        addEventListener() {},
        api: {
            getNoteContexts: () => [],
            showError() {},
            showMessage() {},
        },
        WebSocket: function WebSocket() {},
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    createContext(sandbox);
    runInContext(readFileSync(SCRIPT, "utf8"), sandbox, { filename: SCRIPT });
    return sandbox.HarperTrilium.pure;
}

/* ── a minimal stand-in for CKEditor's view tree ────────────────────────────
 * Only the four members the script touches are needed: `is`, `getName`,
 * `getChildren` on elements, and `data`/`offset` on text nodes.
 */
function el(name, children = []) {
    const node = {
        getName: () => name,
        is: (n) => n === "element" || n === name,
        getChildren: () => children,
    };
    for (const child of children) child.parent = node;
    return node;
}

function text(data, offset = 0) {
    return { data, offset };
}

/**
 * Builds a paragraph. Each part may be:
 *   "some text"            a text run
 *   ["t", "some text"]     the same, explicit
 *   el("br")               a prebuilt element (soft break)
 *   el("code", [text(…)])  a prebuilt element with children
 */
function para(...parts) {
    let offset = 0;
    const children = parts.map((part) => {
        // A prebuilt element: keep it, but it still consumes one child slot.
        // Real CKEditor view nodes carry their index within the parent as
        // `offset`, so the fake must too.
        if (part && typeof part.getName === "function") {
            part.offset = offset;
            offset += 1;
            return part;
        }
        const data = typeof part === "string" ? part : part[1];
        const node = text(data, offset);
        offset += data.length;
        return node;
    });
    return el("paragraph", children);
}

function doc(...blocks) {
    return el("root", blocks);
}

const { buildWireText, positionToOffset, offsetToPosition } = loadFrontend();

describe("frontend: buildWireText", () => {
    it("joins blocks with newlines and records no offset drift", () => {
        const root = doc(para(["t", "First"]), para(["t", "Second"]), para(["t", "Third"]));
        const { text: wire, segments } = buildWireText(root);

        assert.equal(wire, "First\nSecond\nThird");
        // Every character is accounted for by a segment, so any offset in the
        // wire text can be mapped back to the editor.
        for (const segment of segments) {
            assert.equal(
                wire.slice(segment.wireStart, segment.wireEnd),
                segment.masked ? " ".repeat(segment.wireEnd - segment.wireStart) : wire.slice(segment.wireStart, segment.wireEnd),
            );
        }
    });

    it("masks a code block to spaces while preserving length and newlines", () => {
        const code = "const x = 1;";
        const root = doc(para(["t", "Prose before."]), el("pre", [text(code, 0)]), para(["t", "Prose after."]));

        const { text: wire } = buildWireText(root);
        const masked = " ".repeat(code.length);

        assert.equal(wire, `Prose before.\n${masked}\nProse after.`);
        assert.equal(wire.length, `Prose before.\n${code}\nProse after.`.length);
    });

    it("preserves newlines inside a code block so line numbers stay aligned", () => {
        const code = "line one\nline two";
        const root = doc(el("pre", [text(code, 0)]), para(["t", "After."]));

        const { text: wire } = buildWireText(root);
        // "line one" and "line two" are 8 characters each.
        assert.equal(wire, "        \n        \nAfter.");
        assert.equal(wire.split("\n").length, 3, "line count must be unchanged");
    });

    it("masks inline code without touching the surrounding words", () => {
        const root = doc(para(["t", "Call "], el("code", [text("foo()", 0)]), ["t", " now"]));
        const { text: wire } = buildWireText(root);

        assert.equal(wire, "Call       now");
        assert.equal(wire.length, "Call foo() now".length);
        assert.ok(!wire.includes("foo"), "the identifier must not reach the grammar engine");
    });

    it("records a soft break as a one-character boundary", () => {
        const root = doc(para(["t", "a"], el("br"), ["t", "b"]));
        const { text: wire, segments } = buildWireText(root);

        assert.equal(wire, "a\nb");
        const br = segments.find((s) => s.break);
        assert.ok(br, "expected a break segment");
        assert.equal(br.wireStart, 1);
        assert.equal(br.wireEnd, 2);
    });

    it("handles an empty note", () => {
        assert.equal(buildWireText(doc()).text, "");
        assert.equal(buildWireText(doc(para())).text, "");
    });

    it("keeps astral characters intact for UTF-16 offset maths", () => {
        const emoji = "🙂";
        const root = doc(para(["t", `a${emoji}b`]));
        const { text: wire } = buildWireText(root);

        // The emoji is two UTF-16 code units, which is what LSP expects too.
        assert.equal(wire, `a${emoji}b`);
        assert.equal(wire.length, 4);
    });
});

describe("frontend: positionToOffset", () => {
    const wire = "alpha beta\ngamma delta\nepsilon";

    it("maps a position on the first line", () => {
        assert.equal(positionToOffset(wire, { line: 0, character: 0 }), 0);
        assert.equal(positionToOffset(wire, { line: 0, character: 6 }), 6);
    });

    it("maps positions on later lines, accounting for the newline", () => {
        assert.equal(positionToOffset(wire, { line: 1, character: 0 }), 11);
        assert.equal(positionToOffset(wire, { line: 1, character: 6 }), 17);
        assert.equal(positionToOffset(wire, { line: 2, character: 0 }), 23);
    });

    it("clamps a character past the end of its line", () => {
        assert.equal(positionToOffset(wire, { line: 0, character: 999 }), 10);
    });

    it("clamps a line past the end of the document", () => {
        assert.equal(positionToOffset(wire, { line: 99, character: 0 }), wire.length);
    });

    it("round-trips every offset of a simple document", () => {
        const root = doc(para(["t", "alpha beta"]), para(["t", "gamma"]));
        const { text: sent } = buildWireText(root);
        for (let i = 0; i <= sent.length; i += 1) {
            const line = sent.slice(0, i).split("\n");
            const l = line.length - 1;
            const c = line[l].length;
            assert.equal(
                positionToOffset(sent, { line: l, character: c }),
                i,
                `offset ${i} should round-trip`,
            );
        }
    });
});

describe("frontend: offsetToPosition", () => {
    it("resolves an offset to the offset within its text node", () => {
        const root = doc(para(["t", "hello world"]));
        const { text: wire, segments } = buildWireText(root);

        const at = offsetToPosition(segments, 6);
        assert.ok(at, "expected a position");
        assert.equal(at.offset, 6);
    });

    it("resolves offsets in the second block to that block's text node", () => {
        const root = doc(para(["t", "hello"]), para(["t", "world"]));
        const { text: wire, segments } = buildWireText(root);

        // "world" starts at wire offset 6.
        const at = offsetToPosition(segments, 8);
        assert.ok(at);
        assert.equal(at.offset, 2, "'r' is the third character of 'world'");
    });

    it("resolves an offset at the very end of the document", () => {
        const root = doc(para(["t", "hello"]));
        const { segments } = buildWireText(root);
        const at = offsetToPosition(segments, 5);
        assert.ok(at);
        assert.equal(at.offset, 5);
    });

    it("places a soft break on the correct side", () => {
        const root = doc(para(["t", "a"], el("br"), ["t", "b"]));
        const { segments } = buildWireText(root);

        // The <br> is child index 1 of the paragraph.
        assert.equal(offsetToPosition(segments, 1).offset, 1, "offset on the newline is before the br");
        assert.equal(offsetToPosition(segments, 2).offset, 2, "offset after the newline is after the br");
    });

    it("returns null for an empty document", () => {
        assert.equal(offsetToPosition([], 0), null);
    });
});

describe("frontend: offset round-trip through masking", () => {
    it("maps a lint after a code block to the right editor offset", () => {
        const prose = "Prose before.";
        const code = "let x = 1;";
        const after = "A mispelled word here.";

        const root = doc(
            para(["t", prose]),
            el("pre", [text(code, 0)]),
            para(["t", after]),
        );
        const { text: wire, segments } = buildWireText(root);

        assert.equal(wire, `${prose}\n${" ".repeat(code.length)}\n${after}`);

        // A lint on the first 9 characters of the last block.
        const start = positionToOffset(wire, { line: 2, character: 0 });
        const end = positionToOffset(wire, { line: 2, character: 9 });

        assert.equal(wire.slice(start, end), "A mispell");

        // Both ends must land inside the last block's text node.
        assert.equal(offsetToPosition(segments, start).offset, 0);
        assert.equal(offsetToPosition(segments, end).offset, 9);
    });
});
