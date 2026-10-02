/**
 * End-to-end check against a real `harper-ls` process.
 *
 * This is the test that matters most: it proves the framing, the handshake, the
 * configuration pull, diagnostics, and code actions all work against the actual
 * engine rather than a mock.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { HarperLs } from "../src/harper-ls.js";

const HAS_HARPER_LS = await (async () => {
    try {
        const { execFileSync } = await import("node:child_process");
        execFileSync("harper-ls", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();

describe("harper-ls integration", { skip: HAS_HARPER_LS ? false : "harper-ls not installed" }, () => {
    /** @type {HarperLs} */
    let harper;
    let uri;

    before(async () => {
        const workspace = mkdtempSync(join(tmpdir(), "harper-bridge-test-"));
        harper = new HarperLs({ workspaceDir: workspace, onLog: () => {} });
        await harper.ready();
        uri = pathToFileURL(join(workspace, "note.md")).href;
    });

    after(async () => {
        await harper?.stop();
    });

    it("reports diagnostics for a misspelled sentence", async () => {
        const lints = await harper.lint(uri, MISSPELLED);

        assert.ok(lints.length > 0, "expected at least one lint");

        for (const lint of lints) {
            assert.equal(lint.uri, uri);
            assert.equal(typeof lint.message, "string");
            assert.ok(lint.range.start.line >= 0);
            assert.ok(lint.range.end.line >= 0);
            assert.ok(lint.range.end.character >= lint.range.start.character || lint.range.end.line > lint.range.start.line);
        }
    });

    it("returns no lints for correct prose", async () => {
        const clean = await harper.lint(uri, "The quick brown fox jumps over the lazy dog.");
        assert.deepEqual(clean, [], "clean sentence should produce no lints");
    });

    it("locates the misspelling at the expected offsets", async () => {
        const lints = await harper.lint(uri, MISSPELLED);

        // "Zorbulax" is the first word: 8 characters, starting at offset 0.
        const span = lints.find((l) => l.message.includes("Zorbulax"));
        assert.ok(span, `expected a lint mentioning "Zorbulax", got: ${JSON.stringify(lints.map((l) => l.message))}`);

        assert.equal(span.range.start.line, 0);
        assert.equal(span.range.start.character, 0);
        assert.equal(span.range.end.character, 8);
        assert.equal(MISSPELLED.slice(0, 8), "Zorbulax");
    });

    it("reports line and character across multiple lines", async () => {
        const lints = await harper.lint(uri, "First line is fine.\nZorbulax is here.\nThird is fine.");

        const span = lints.find((l) => l.range.start.line === 1);
        assert.ok(span, `expected a lint on line 1, got: ${JSON.stringify(lints)}`);
        assert.equal(span.range.start.character, 0, "'Zorbulax' is the first word of line 1");
    });

    it("produces a text edit for a quick fix", async () => {
        const lints = await harper.lint(uri, MISSPELLED);
        const target = lints.find((l) => l.message.includes("Zorbulax"));
        assert.ok(target, "expected a fixable lint");

        const actions = await harper.codeAction(uri, target.range);
        const edits = actions.filter((a) => a.kind === "edit");

        assert.ok(edits.length > 0, `expected quick fixes, got: ${JSON.stringify(actions)}`);
        for (const edit of edits) {
            assert.equal(typeof edit.newText, "string");
            assert.ok(edit.newText.length > 0);
            assert.ok(edit.title.length > 0);

            // The frontend applies `edits` as a batch, so it must always be
            // present and self-contained: every entry carries its own range
            // and text, with no dependency on `range`/`newText`.
            assert.ok(Array.isArray(edit.edits) && edit.edits.length > 0, "missing edits array");
            for (const entry of edit.edits) {
                assert.ok(entry.range, "each edit needs a range");
                assert.equal(typeof entry.range.start.line, "number");
                assert.equal(typeof entry.range.end.character, "number");
                assert.equal(typeof entry.newText, "string");
            }
            // The legacy single-edit fields mirror the first entry.
            assert.deepEqual(edit.range, edit.edits[0].range);
            assert.equal(edit.newText, edit.edits[0].newText);
        }
    });

    it("offers dictionary and ignore commands for spelling errors", async () => {
        const lints = await harper.lint(uri, "Zorbulax is wibbly.");
        assert.ok(lints.length > 0, "expected a spelling lint");

        const actions = await harper.codeAction(uri, lints[0].range);
        const commands = actions.filter((a) => a.kind === "command").map((a) => a.command);

        assert.ok(commands.includes("HarperIgnoreLint"), `expected HarperIgnoreLint, got: ${commands}`);
        assert.ok(
            commands.some((c) => c.startsWith("HarperAddTo")),
            `expected a dictionary command, got: ${commands}`,
        );
    });

    it("stays silent on whitespace-only masked text", async () => {
        // Mirrors how the editor masks code blocks: same length, spaces only.
        const code = "const x = 1;";
        const masked = code.replace(/[^\n]/g, " ");
        assert.equal(masked.length, code.length);

        const lints = await harper.lint(uri, `Some prose here.\n\n${masked}\n\nMore prose.`);
        assert.deepEqual(lints, [], `masked code should be invisible, got: ${JSON.stringify(lints)}`);
    });

    it("keeps offsets stable when text is masked", async () => {
        // Both paragraphs carry a deliberate misspelling so the assertion
        // below is not vacuous: a run of spaces on its own produces no lints,
        // which would make an empty `lints` array look like a pass.
        const before = "The befor paragrph comes first.";
        const code = "let value = compute(1, 2);";
        const after = "The afterr paragrph comes second.";

        const maskedCode = code.replace(/[^\n]/g, " ");
        const plain = `${before}\n\n${code}\n\n${after}`;
        const masked = `${before}\n\n${maskedCode}\n\n${after}`;

        assert.equal(plain.length, masked.length, "masking must preserve length");

        const codeStart = offsetOf(masked, { line: 2, character: 0 });
        const codeEnd = codeStart + maskedCode.length;

        const lints = await harper.lint(uri, masked);
        assert.ok(lints.length > 0, "expected the misspellings to be caught either side of the mask");

        for (const lint of lints) {
            const start = offsetOf(masked, lint.range.start);
            const end = offsetOf(masked, lint.range.end);
            const overlapsMask = start < codeEnd && end > codeStart;
            assert.ok(
                !overlapsMask,
                `lint ${JSON.stringify(lint)} overlaps the masked region ` +
                    `[${codeStart}, ${codeEnd})`,
            );
        }
    });
});

/**
 * Harper is a grammar checker, not merely a spell checker: `AnA` (article
 * choice) and `PronounVerbAgreement` are the rules that carry most of its
 * value in prose. They behave differently from `SpellCheck` in ways worth
 * locking down — they match on word pairs, span multi-word ranges, and the
 * editor's code masking rewrites the sentence around them.
 *
 * Every fixture and offset below was confirmed against harper-ls 2.11.0 rather
 * than assumed, which matters: unlike a misspelling, it is not obvious which
 * phrasings a given rule will accept.
 */
describe("grammar rules", { skip: HAS_HARPER_LS ? false : "harper-ls not installed" }, () => {
    /** @type {HarperLs} */
    let harper;
    let uri;
    let workspace;

    before(async () => {
        workspace = mkdtempSync(join(tmpdir(), "harper-grammar-test-"));
        harper = new HarperLs({ workspaceDir: workspace, onLog: () => {} });
        await harper.ready();
        uri = pathToFileURL(join(workspace, "note.md")).href;
    });

    after(async () => {
        await harper?.stop();
    });

    /**
     * Lints with a specific `HARPER_DIALECT`, on a separate process so the
     * shared `harper` keeps its own settings.
     */
    async function lintWithDialect(dialect, text) {
        const previous = process.env.HARPER_DIALECT;
        process.env.HARPER_DIALECT = dialect;
        const scoped = new HarperLs({ workspaceDir: workspace, onLog: () => {} });
        try {
            await scoped.ready();
            return await scoped.lint(uri, text);
        } finally {
            await scoped.stop();
            if (previous === undefined) delete process.env.HARPER_DIALECT;
            else process.env.HARPER_DIALECT = previous;
        }
    }

    it("flags article choice and pronoun-verb agreement", async () => {
        const lints = await harper.lint(uri, GRAMMAR);
        const codes = lints.map((l) => l.code);

        assert.ok(codes.includes("AnA"), `expected AnA, got: ${JSON.stringify(codes)}`);
        assert.ok(
            codes.includes("PronounVerbAgreement"),
            `expected PronounVerbAgreement, got: ${JSON.stringify(codes)}`,
        );
        // Nothing here is misspelled, so this proves the grammar rules fired on
        // their own rather than riding along on a SpellCheck.
        assert.ok(!codes.includes("SpellCheck"), "fixture is spelled correctly");
    });

    it("locates grammar lints at the expected offsets", async () => {
        const lints = await harper.lint(uri, GRAMMAR);

        const article = lints.find((l) => l.code === "AnA");
        assert.ok(article, "expected an AnA lint");
        assert.equal(article.range.start.line, 0);
        assert.equal(article.range.start.character, 7);
        assert.equal(article.range.end.character, 8);
        assert.equal(GRAMMAR.slice(7, 8), "a", "'a' is the wrong article in 'a engineer'");

        const agreement = lints.find((l) => l.code === "PronounVerbAgreement");
        assert.ok(agreement, "expected a PronounVerbAgreement lint");
        assert.equal(agreement.range.start.character, 25);
        assert.equal(agreement.range.end.character, 29);
        assert.equal(GRAMMAR.slice(25, 29), "work", "'work' should be 'works' after 'he'");
    });

    it("offers an applicable text edit for each grammar lint", async () => {
        const lints = await harper.lint(uri, GRAMMAR);
        assert.ok(lints.length > 0, "expected grammar lints");

        for (const lint of lints) {
            const actions = await harper.codeAction(uri, lint.range);
            const edits = actions.filter((a) => a.kind === "edit");

            assert.ok(
                edits.length > 0,
                `no fix offered for ${JSON.stringify(lint)}: ${JSON.stringify(actions)}`,
            );
            for (const edit of edits) {
                assert.ok(edit.title.length > 0, "a fix needs a title for the menu");
                assert.ok(edit.edits.length > 0, "a fix needs at least one edit");
                // A grammar fix replaces a word, so the replacement must be
                // non-empty; an empty one would silently delete text in the
                // editor.
                assert.ok(
                    edit.edits[0].newText.length > 0,
                    `fix ${JSON.stringify(edit.title)} would delete text`,
                );
            }
        }
    });

    it("suggests the corrected word for an agreement error", async () => {
        const lints = await harper.lint(uri, GRAMMAR);
        const agreement = lints.find((l) => l.code === "PronounVerbAgreement");
        assert.ok(agreement);

        const actions = await harper.codeAction(uri, agreement.range);
        const texts = actions.filter((a) => a.kind === "edit").map((a) => a.edits[0].newText);

        assert.ok(texts.includes("works"), `expected a 'works' fix, got: ${JSON.stringify(texts)}`);
    });

    it("still detects grammar around masked code", async () => {
        // Masking replaces a code span with spaces of equal length, which
        // silently rewrites the sentence the grammar rules are matching over.
        // The article error sits immediately after the mask, so if masking broke
        // the surrounding clause this would come back clean.
        const code = "compute(x)";
        const unmasked = `She is a ${code} engineer and he work here.`;
        const masked = `She is a ${code.replace(/[^\n]/g, " ")} engineer and he work here.`;
        assert.equal(masked.length, unmasked.length, "masking must preserve length");

        const lints = await harper.lint(uri, masked);
        const codes = lints.map((l) => l.code);

        assert.ok(codes.includes("AnA"), `expected AnA after the mask, got: ${JSON.stringify(codes)}`);
        assert.ok(
            codes.includes("PronounVerbAgreement"),
            `expected PronounVerbAgreement after the mask, got: ${JSON.stringify(codes)}`,
        );
    });

    it("keeps grammar lint offsets aligned with the masked text", async () => {
        const code = "compute(x)";
        const unmasked = `She is a ${code} engineer and he work here.`;
        const masked = `She is a ${code.replace(/[^\n]/g, " ")} engineer and he work here.`;

        const lints = await harper.lint(uri, masked);
        const agreement = lints.find((l) => l.code === "PronounVerbAgreement");
        assert.ok(agreement, "expected an agreement lint");

        // The word "work" must still be exactly where it was before masking,
        // otherwise the squiggle would be drawn over the wrong characters.
        const start = offsetOf(masked, agreement.range.start);
        const end = offsetOf(masked, agreement.range.end);
        assert.equal(masked.slice(start, end), "work");
    });

    it("leaves correct prose alone", async () => {
        const lints = await harper.lint(uri, "She is an engineer and he works here.");
        assert.deepEqual(lints, [], `correct grammar should be clean, got: ${JSON.stringify(lints)}`);
    });

    it("honours a HARPER_DIALECT override", async () => {
        // Harper ships one American dictionary, so a non-American dialect works
        // by *not* flagging -our/-re spellings rather than by swapping the
        // dictionary out.
        const british = await lintWithDialect("British", "The colour of the centre is nice.");
        assert.deepEqual(british, [], `British should accept -our/-re, got: ${JSON.stringify(british)}`);

        const american = await lintWithDialect("American", "The colour of the centre is nice.");
        assert.ok(
            american.length > 0,
            "American dialect should still flag British spellings, so this test is not vacuous",
        );
    });

    it("does not flag markdown tables as em-dash candidates", async () => {
        // `Dashes` would otherwise rewrite every `| --- |` separator.
        const table = ["| col | col |", "| --- | --- |", "| a | b |", ""].join("\n");
        const lints = await harper.lint(uri, table);
        const codes = lints.map((l) => l.code);

        assert.ok(!codes.includes("Dashes"), `expected no Dashes lint, got: ${JSON.stringify(codes)}`);
    });
});

/** A sentence with no misspellings but two definite grammar errors. */
const GRAMMAR = "She is a engineer and he work here.";

/**
 * A sentence with a guaranteed spelling miss.
 *
 * The obvious fixture, "This are a test of the system.", is a trap: every word
 * in it is spelled correctly and Harper has no subject-verb agreement rule, so
 * it legitimately produces zero diagnostics.
 */
const MISSPELLED = "Zorbulax is wibbly.";

/** Converts an LSP Position into a JS string offset. */function offsetOf(text, position) {
    let line = 0;
    let index = 0;
    while (line < position.line) {
        const next = text.indexOf("\n", index);
        if (next === -1) return text.length;
        index = next + 1;
        line += 1;
    }
    return index + position.character;
}
