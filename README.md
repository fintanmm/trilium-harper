# trilium-harper

Live grammar and spell checking for [Trilium Notes](https://github.com/TriliumNext/Trilium),
powered by [`harper-ls`](https://github.com/Automattic/harper-ls). Mistakes get a red
squiggle in the editor; click one to see a fix, add the word to a dictionary, or
ignore it.

That covers spelling (`SpellCheck`) and grammar rules such as `AnA` for article
choice ("a engineer" → "an engineer") and `PronounVerbAgreement` ("he work" →
"he works"). All rules are surfaced the same way — the rule name is carried
through as the lint `code` — so grammar fixes appear in the same click-to-fix
menu as spelling ones.

```
Trilium browser tab
      │  WebSocket (ws://127.0.0.1:4000, token in the query string)
      ▼
src/server.js  ──stdio──▶  harper-ls  ──▶  ~/.local/share/harper-trilium/*.txt
```

The browser never talks to `harper-ls` directly. A small Node bridge owns the
language-server process, keeps its per-note state, and translates LSP into a
message shape the editor can render.

## Requirements

|           |                                                      |
| --------- | ---------------------------------------------------- |
| Trilium   | Any recent version. No server-side plugin is needed. |
| Node      | 20 or newer                                          |
| harper-ls | On `PATH`, or set `HARPER_LS_BIN`                    |

## Install

```sh
npm install
npm test          # 42 tests: protocol, bridge, frontend, and a real harper-ls
```

`npm test` starts an actual `harper-ls`, so it also confirms the binary is
installed and the version is compatible.

## Run

```sh
npm start
```

It prints the port, the token, and the workspace path:

```
bridge listening on ws://127.0.0.1:4000
token: xK3...
workspace: /home/you/.local/share/harper-trilium
```

Then attach the frontend to a note:

1. Create a note in Trilium, e.g. `Harper`.
2. Attach `trilium/harper-frontend.js` to it.
3. Add `#run=frontendStartup` to the note title so the script starts on load.
4. Edit the `CONFIG` block at the top of the file: paste in `TOKEN`, and set
   `HOST`/`PORT` to match the bridge.
5. Reload Trilium. Type in any note to see squiggles.

The `TOKEN` is the only required edit. `HOST` defaults to `127.0.0.1:4000`.

### Adjusting the frontend

`CONFIG` in `trilium/harper-frontend.js`:

| Key             | Default              | Meaning                                                         |
| --------------- | -------------------- | --------------------------------------------------------------- |
| `HOST` / `PORT` | `127.0.0.1` / `4000` | Where the bridge is listening.                                  |
| `TOKEN`         | —                    | The token from bridge startup.                                  |
| `DEBOUNCE_MS`   | `600`                | Idle time after the last keystroke before re-linting.           |
| `MIN_LENGTH`    | `24`                 | Don't bother linting notes shorter than this.                   |
| `MAX_LENGTH`    | `200000`             | Skip anything larger.                                           |
| `SHOW_STATUS`   | `true`               | Show a status dot in the corner when the bridge is unreachable. |

## Run as a service

`deploy/trilium-harper.service` is a systemd **user** unit. Set a stable token
first — otherwise the bridge invents a new one on every restart:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/trilium-harper.service ~/.config/systemd/user/

# Generate a token and uncomment the Environment= line in the copied unit.
openssl rand -base64 32
$EDITOR ~/.config/systemd/user/trilium-harper.service

systemctl --user daemon-reload
systemctl --user enable --now trilium-harper
systemctl --user status trilium-harper
journalctl --user -u trilium-harper -f
```

Pin the token to the `Environment=HARPER_BRIDGE_TOKEN=…` line in the unit. If
`harper-ls` is not on systemd's `PATH` — common for Homebrew on Linux — also set
`Environment=HARPER_LS_BIN=/path/to/harper-ls`. The unit ships a commented
`Environment=HARPER_DIALECT=…` line for non-American English (see
[Dialect](#dialect)).

For the service to start without a login shell, also run
`sudo loginctl enable-linger $USER`.

### Environment variables

| Variable                  | Default                         | Purpose                              |
| ------------------------- | ------------------------------- | ------------------------------------ |
| `HARPER_BRIDGE_PORT`      | `4000`                          | Listening port.                      |
| `HARPER_BRIDGE_TOKEN`     | random per start                | Shared secret. Set it in production. |
| `HARPER_BRIDGE_WORKSPACE` | `~/.local/share/harper-trilium` | Dictionaries and ignored lints.      |
| `HARPER_LS_BIN`           | `harper-ls`                     | Path to the language server.         |
| `HARPER_DIALECT`          | `American`                      | `American`, `Canadian` or `British`. |

### Dialect

Harper only ships an American dictionary. Setting `HARPER_DIALECT=British` or
`Canadian` stops it flagging the `-our`/`-re` words (`colour`, `centre`,
`organize`) as misspellings; it does not load a different dictionary. Leave it
alone if you write American English, where flagging those words is the point.

## Security

The bridge binds to `127.0.0.1` only, so it is not reachable from the network.
It also:

- requires the token on every connection (`?token=…`);
- accepts only loopback, LAN, and private-range `Origin` headers;
- allows **one** editor client at a time, since two tabs would fight over the
  language server's document state.

`ws://` is fine when Trilium is served over plain HTTP, which is the normal local
setup. If your Trilium is served over HTTPS, the browser will block a `ws://`
connection as mixed content — either use a reverse proxy for the bridge or
`mkcert` to give Trilium a trusted certificate.

### Reaching it from another machine

The bridge only listens on loopback, so a browser elsewhere needs a tunnel:

```sh
ssh -L 4000:127.0.0.1:4000 you@trilium-host
```

Then point the frontend's `HOST` at `127.0.0.1` in your local browser — the
tunnel lands on the bridge. Do not bind the bridge to `0.0.0.0` on a shared
network unless you also add TLS and a firewall rule.

## Dictionaries

All state lives in the bridge workspace, one file per purpose:

| File                       | Scope                                     |
| -------------------------- | ----------------------------------------- |
| `user-dictionary.txt`      | Words you add anywhere, across all notes. |
| `workspace-dictionary.txt` | Per-workspace words, shared across notes. |
| `file-dictionaries/`       | Per-note dictionaries.                    |
| `ignored-lints/`           | Lints you've told Harper to ignore.       |

The bridge deliberately overrides Harper's `userDictPath` default, which would
otherwise write into your real `~/.config/harper-ls/`. Everything stays
contained in one directory you can inspect or delete.

## How it works

`buildWireText()` in the frontend walks the CKEditor view tree and produces the
plain text sent to Harper, plus a table mapping offsets back to editor
positions. Two details matter:

- **Code is masked, not removed.** Replacing a run of characters with spaces of
  the same length keeps every subsequent offset identical to the editor's, so
  lint ranges need no correction. Newlines inside code blocks are preserved so
  line numbers still line up.
- **Positions are UTF-16 code units**, which is both what LSP specifies and what
  a JavaScript string index is, so no conversion is needed.

Those two functions are the only non-obvious logic, so they are unit tested
against a fake view tree in `test/frontend.test.js` — including code masking,
soft breaks, and astral characters.

### Harper behaviour worth knowing

- Harper re-requests `workspace/configuration` on **every** document update. The
  bridge must answer promptly or linting stalls; this was a real bug.
- Its `Spaces` and `NoFrenchSpaces` rules flag the masking itself, so the bridge
  disables both.
- `Dashes` is also disabled: it wants markdown table separators (`| --- |`) and
  thematic breaks (`---`) rewritten as em dashes, which is wrong for every
  markdown note.
- Passing a partial `linters` map merges with Harper's curated defaults rather
  than replacing them, so you only list what you want changed.
- A lint is only worth suggesting an edit if the code action actually carries
  one; Harper also returns bare commands like `HarperAddToUserDict`, which are
  classified separately.
- Harper rejects its **entire** config if the workspace directory does not exist,
  silently falling back to defaults. The bridge creates the directory first.

### Known false positives

Two upstream quirks, confirmed against 2.11.0 and left unfixed on purpose —
each would need a whole rule disabled to avoid, which costs more real coverage
than the false positive costs you:

- `AnA` flags the "A" in `A [link](https://…)`, but not in `A **bold** …`.
- `SentenceCapitalization` flags "second" in `1. first` / `2. second`, but not
  in `1. apples` / `2. bananas`.

## Layout

```
src/protocol.js   message validation, note URIs
src/lsp.js        LSP framing, dispatch, request timeouts
src/harper-ls.js  harper-ls process, config, diagnostics, code actions
src/server.js     WebSocket bridge, note lifecycle
trilium/harper-frontend.js   the file you attach to a note
deploy/trilium-harper.service
test/bridge.test.js          7 tests   WebSocket protocol and note lifecycle
test/frontend.test.js       18 tests   editor text extraction, via node:vm
test/lsp-integration.test.js 17 tests   against a real harper-ls process
```

## Troubleshooting

**No squiggles.** Open the browser console. `SHOW_STATUS` puts a dot in the
corner when the bridge is unreachable. Check the token matches, and confirm
with `journalctl --user -u trilium-harper`.

**Squiggles but no suggestions.** The bridge has the text but not the fixes;
that is a `harper-ls` version issue. This was developed and tested against
**harper-ls 2.11.0** — check yours with `harper-ls --version`. The integration
relies on behavior that is not part of the LSP spec (see
[Harper behaviour worth knowing](#harper-behaviour-worth-knowing), which is the
first thing to re-check after a version bump.

**Duplicate squiggles after typing.** The frontend discards results for stale
revisions; if you see them, the session's `revision` counter is not advancing on
`change:data`.

**Bridge won't start.** It exits with a message if `harper-ls` is missing. Set
`HARPER_LS_BIN` to its full path.
