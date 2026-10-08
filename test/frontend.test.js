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
            addEventListener(type, listener, options) {
                (sandbox.documentListeners ??= []).push({ type, listener, options });
            },
            createElement(tag) {
                return {
                    tagName: String(tag).toUpperCase(),
                    style: {},
                    dataset: {},
                    children: [],
                    parentElement: null,
                    className: "",
                    title: "",
                    get childElementCount() {
                        return this.children.length;
                    },
                    appendChild(child) {
                        child.parentElement = this;
                        this.children.push(child);
                        return child;
                    },
                    remove() {
                        if (!this.parentElement) return;
                        const siblings = this.parentElement.children;
                        siblings.splice(siblings.indexOf(this), 1);
                        this.parentElement = null;
                    },
                    addEventListener() {},
                };
            },
            getElementById: () => null,
            head: { appendChild() {} },
            body: null,
            contains(node) {
                for (let current = node; current; current = current.parentElement) {
                    if (current === sandbox.document.body) return true;
                }
                return false;
            },
        },
        window: { innerWidth: 1280, innerHeight: 800, addEventListener() {} },
        getComputedStyle: (node) => ({ backgroundColor: node.style?.backgroundColor ?? "rgba(0, 0, 0, 0)" }),
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
    sandbox.document.body = sandbox.document.createElement("body");
    return sandbox;
}

/* ── a stand-in for CKEditor's view tree, mirroring the real API ────────────
 * Elements expose `name`, `is` and `getChildren`; every node exposes `parent`.
 * View elements have no `index` and no `offset`, so the fake must not invent
 * either — a child index has to be counted from `getChildren()`.
 */
function el(name, children = []) {
    const node = {
        name,
        is: (n) => n === "element" || n === name,
        getChildren: () => children,
    };
    children.forEach((child) => {
        child.parent = node;
    });
    return node;
}

function text(data) {
    return { data };
}

/**
 * Builds a paragraph. Each part may be:
 *   "some text"            a text run
 *   ["t", "some text"]     the same, explicit
 *   el("br")               a prebuilt element (soft break)
 *   el("code", [text(…)])  a prebuilt element with children
 */
function para(...parts) {
    const children = parts.map((part) => {
        if (part && typeof part.is === "function") return part;
        return text(typeof part === "string" ? part : part[1]);
    });
    return el("paragraph", children);
}

function doc(...blocks) {
    return el("root", blocks);
}

const frontend = loadFrontend();
const { buildWireText, positionToOffset, offsetToPosition } = frontend.HarperTrilium.pure;

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

    it("reads the element name through getName() when name is absent", () => {
        const p = para(["t", "a"], el("br"), ["t", "b"]);
        const br = p.getChildren()[1];
        delete br.name;
        br.getName = () => "br";

        const { text: wire, segments } = buildWireText(doc(p));
        assert.equal(wire, "a\nb");
        assert.equal(segments[1].break, true, "a resolved name keeps the br a soft break");
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
        // The parent must be the text node itself, not the paragraph: a view
        // position whose parent is an element is a child index, not a column.
        assert.equal(at.parent.data, "hello world");
        assert.equal(at.parent.parent.name, "paragraph");
    });

    it("resolves offsets in the second block to that block's text node", () => {
        const root = doc(para(["t", "hello"]), para(["t", "world"]));
        const { text: wire, segments } = buildWireText(root);

        // "world" starts at wire offset 6.
        const at = offsetToPosition(segments, 8);
        assert.ok(at);
        assert.equal(at.offset, 2, "'r' is the third character of 'world'");
        assert.equal(at.parent.data, "world");
        assert.equal(at.parent.parent.name, "paragraph");
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

        // The <br> is child index 1 of the paragraph, so a position around it
        // has the paragraph as parent and a child index as offset.
        const on = offsetToPosition(segments, 1);
        assert.equal(on.parent.name, "paragraph", "the br segment resolves to the element");
        assert.equal(on.offset, 1, "offset on the newline is before the br");

        const past = offsetToPosition(segments, 2);
        assert.equal(past.parent.data, "b", "past the newline we are inside the next text node");
        assert.equal(past.offset, 0, "which begins immediately after the br");
    });

    it("returns null for an empty document", () => {
        assert.equal(offsetToPosition([], 0), null);
    });

    it("parks an offset on the block-joining newline at the end of the previous block", () => {
        const root = doc(para(["t", "hello"]), para(["t", "world"]));
        const { text: wire, segments } = buildWireText(root);

        // Offset 5 is the newline the builder inserts between the two blocks.
        // It belongs to no segment, so a naive lookup would place it inside
        // "world" at column -1 and the DOM converter would reject the range.
        assert.equal(wire[5], "\n");
        const at = offsetToPosition(segments, 5);
        assert.ok(at, "expected a position");
        assert.ok(at.offset >= 0, `offset must not be negative, got ${at.offset}`);
        assert.equal(at.parent.data, "hello");
        assert.equal(at.offset, 5, "the end of the first block");
    });

    it("clamps an offset past the last segment to the end of that segment", () => {
        const root = doc(para(["t", "a"]), para([]));
        const { text: wire, segments } = buildWireText(root);

        // The trailing synthetic newline sits beyond every segment.
        assert.equal(wire, "a\n");
        const at = offsetToPosition(segments, wire.length);
        assert.ok(at);
        assert.equal(at.parent.data, "a");
        assert.equal(at.offset, 1, "the end of the text node, not one past it");
    });

    it("counts a soft break's child index instead of assuming zero", () => {
        const root = doc(para(["t", "a"], ["t", "b"], el("br")));
        const { segments } = buildWireText(root);

        // The <br> is the paragraph's third child, not its first.
        const at = offsetToPosition(segments, 2);
        assert.equal(at.parent.name, "paragraph");
        assert.equal(at.offset, 2);
    });

    it("maps every offset in the wire text to a position inside its parent", () => {
        const root = doc(
            para(["t", "First line"], el("br"), ["t", "second"]),
            para(["t", "Third"]),
            el("pre", [text("const x = 1;", 0)]),
            para([]),
            para(["t", "Last"]),
        );
        const { text: wire, segments } = buildWireText(root);

        for (let offset = 0; offset <= wire.length; offset++) {
            const at = offsetToPosition(segments, offset);
            assert.ok(at, `no position for wire offset ${offset} in ${JSON.stringify(wire)}`);
            assert.ok(at.offset >= 0, `offset ${at.offset} is negative at wire offset ${offset}`);

            const length =
                typeof at.parent.data === "string" ? at.parent.data.length : [...at.parent.getChildren()].length;
            assert.ok(
                at.offset <= length,
                `offset ${at.offset} is past length ${length} at wire offset ${offset} in ${JSON.stringify(wire)}`,
            );
        }
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

describe("frontend: stylesheet", () => {
    const source = readFileSync(SCRIPT, "utf8");

    it("paints a mark whatever severity arrives", () => {
        // harper-ls stamps every diagnostic with one severity (hint by default),
        // so visibility must not hinge on a data-severity selector matching.
        const bare = source.match(/\.harper-overlay \.harper-mark \{[^}]*\}/);
        assert.ok(bare, "expected a bare .harper-mark rule");
        assert.match(bare[0], /background-image/);
    });

    it("styles every LSP severity, including hint", () => {
        for (const severity of [1, 2, 3, 4]) {
            assert.match(
                source,
                new RegExp(`\\.harper-mark\\[data-severity="${severity}"\\]`),
                `no rule for severity ${severity}`,
            );
        }
    });

    it("fixes the overlay to the viewport", () => {
        // CKEditor owns its editable subtree and evicts foreign children, so
        // the overlay lives on the body and must not scroll with the host.
        const overlay = source.match(/\.harper-overlay \{[^}]*\}/);
        assert.ok(overlay, "expected a .harper-overlay rule");
        assert.match(overlay[0], /position: fixed/);
        assert.match(source, /document\.body\.appendChild\(this\.overlay\)/);
    });

    it("styles the suggestion box as a floating card", () => {
        const popover = source.match(/\.harper-popover \{[^}]*\}/);
        assert.ok(popover, "expected a .harper-popover rule");
        assert.match(popover[0], /border-radius: 10px/);
        assert.match(popover[0], /box-shadow/);
        assert.match(popover[0], /var\(--hp-surface/, "the box should take its colours from the sampled theme");
        assert.match(source, /\.harper-popover button:focus-visible/);
        assert.match(source, /\.harper-popover \.harper-empty \{/);
        assert.match(source, /No suggestions for this finding\./);
    });
});

describe("frontend: render", () => {
    it("draws marks on a body-level overlay in viewport coordinates", async () => {
        const sandbox = loadFrontend();
        const root = doc(para(["t", "hello world"]));
        const { text: wire, segments } = buildWireText(root);
        const clientRect = { left: 100, right: 160, top: 188, bottom: 200, width: 60, height: 12 };

        const editor = {
            model: { document: { on() {}, off() {} } },
            editing: {
                view: {
                    document: { getRoot: () => root },
                    createPositionAt: (parent, offset) => ({ parent, offset }),
                    createRange: (start, end) => ({ start, end }),
                    domConverter: { viewRangeToDom: () => ({ getClientRects: () => [clientRect] }) },
                },
            },
        };

        sandbox.api.getNoteContexts = () => [
            { note: { noteId: "note-render", type: "text" }, getTextEditor: async () => editor },
        ];
        await sandbox.HarperTrilium.sync();

        const session = sandbox.HarperTrilium.sessions.get("note-render");
        assert.ok(session, "a session should attach to the open note");

        session.render(
            [{ message: "a finding", severity: 4, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }],
            { text: wire, segments },
        );

        assert.equal(session.overlay.parentElement, sandbox.document.body, "the overlay belongs to the body, not CKEditor's editable");
        assert.equal(session.overlay.childElementCount, 1, "one mark was drawn");

        const mark = session.overlay.children[0];
        assert.equal(mark.dataset.severity, "4");
        assert.equal(mark.style.left, "100px", "marks use the client rect's viewport x");
        assert.equal(mark.style.top, "197px", "marks use the client rect's viewport y");
    });
});

describe("frontend: suggestion box", () => {
    async function attachSession(sandbox) {
        const root = doc(para(["t", "hello world"]));
        const editor = {
            model: { document: { on() {}, off() {} } },
            editing: { view: { document: { getRoot: () => root } } },
        };
        sandbox.api.getNoteContexts = () => [
            { note: { noteId: "note-box", type: "text" }, getTextEditor: async () => editor },
        ];
        await sandbox.HarperTrilium.sync();
        const session = sandbox.HarperTrilium.sessions.get("note-box");
        assert.ok(session, "a session should attach to the open note");
        return session;
    }

    it("dismisses an open box on Escape and leaves Escape alone otherwise", async () => {
        const sandbox = loadFrontend();
        const session = await attachSession(sandbox);

        const keydown = sandbox.documentListeners.filter((entry) => entry.type === "keydown");
        assert.ok(keydown.length > 0, "the script should listen for keys");
        for (const { options } of keydown) {
            assert.ok(options === true || options?.capture, "keys must be handled in the capture phase, before CKEditor");
        }

        const handler = keydown[0].listener;
        const press = () => {
            const calls = { prevented: false, stopped: false };
            handler({
                key: "Escape",
                preventDefault: () => { calls.prevented = true; },
                stopPropagation: () => { calls.stopped = true; },
            });
            return calls;
        };

        // Nothing open: Escape still belongs to the editor.
        assert.deepEqual(press(), { prevented: false, stopped: false });

        session.popover = sandbox.document.createElement("div");
        assert.deepEqual(press(), { prevented: true, stopped: true });
        assert.equal(session.popover, null, "Escape should close the box");
    });

    it("picks a palette from the background it floats over", () => {
        const { paletteFor } = loadFrontend().HarperTrilium.pure;
        const light = paletteFor(255, 255, 255);
        const dark = paletteFor(18, 20, 26);

        assert.equal(light["--hp-surface"], "#ffffff", "a white page gets the light palette");
        assert.notEqual(dark["--hp-surface"], light["--hp-surface"], "a dark page gets the dark palette");
        assert.deepEqual(Object.keys(light), Object.keys(dark), "both palettes set every property");
    });
});
