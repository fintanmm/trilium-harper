/**
 * Unit tests for the bridge's `Origin` gate.
 *
 * The gate is exported rather than tested through a live socket so it can be
 * pinned down without starting a bridge (and therefore without harper-ls).
 * The `trilium-app://app` case is the regression that matters: the desktop app
 * serves its UI from a custom scheme with no `http(s)://`, so an http-only
 * allow-list rejects it before the token is ever checked.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isOriginAllowed } from "../src/server.js";

describe("isOriginAllowed", () => {
    it("accepts the Trilium desktop app origin", () => {
        assert.equal(isOriginAllowed("trilium-app://app"), true);
    });

    it("rejects other hosts under the desktop app's scheme", () => {
        assert.equal(isOriginAllowed("trilium-app://evil"), false);
        assert.equal(isOriginAllowed("trilium-app://app.evil.example"), false);
        assert.equal(isOriginAllowed("trilium-app://app/"), false, "must match the origin exactly");
    });

    it("accepts loopback origins in either case", () => {
        assert.equal(isOriginAllowed("http://localhost:8080"), true);
        assert.equal(isOriginAllowed("http://127.0.0.1:4000"), true);
        assert.equal(isOriginAllowed("http://[::1]:8080"), true);
        assert.equal(isOriginAllowed("http://127.0.0.1:8080/login"), true);
    });

    it("accepts private-range origins, since Trilium is often reached over LAN", () => {
        assert.equal(isOriginAllowed("http://10.0.0.5"), true);
        assert.equal(isOriginAllowed("https://192.168.1.9:22434"), true);
        assert.equal(isOriginAllowed("http://172.16.0.1"), true);
        assert.equal(isOriginAllowed("http://172.31.255.255"), true);
    });

    it("rejects foreign origins", () => {
        assert.equal(isOriginAllowed("https://evil.example"), false);
        assert.equal(isOriginAllowed("http://evil.example"), false);
        assert.equal(isOriginAllowed("https://169.254.169.254"), false, "link-local is not a private range");
        assert.equal(isOriginAllowed("http://172.32.0.1"), false, "just past the private range");
    });

    it("rejects a non-http scheme other than the desktop app's", () => {
        assert.equal(isOriginAllowed("file://"), false);
        assert.equal(isOriginAllowed("chrome-extension://abcdefghijklmnop"), false);
    });

    it("rejects the literal string \"null\", as sent by opaque sandboxed frames", () => {
        assert.equal(isOriginAllowed("null"), false);
    });

    it("allows an absent origin, where the token is the only gate", () => {
        assert.equal(isOriginAllowed(undefined), true);
        assert.equal(isOriginAllowed(""), true);
    });
});
