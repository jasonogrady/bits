# version-tab

"What build am I looking at?" — a compact **version chip** (🏷️ v8.0) showing
the live version; click it and the **release notes** open: every version with
its date and notes, newest first. Born on the
[chip.ogrady.golf](https://chip.ogrady.golf) live leaderboard, where the server
auto-deploys itself: the page shows which build is actually serving, so a
deploy is verifiable from the browser — no shelling in.

Two flavors, one renderer:

| File | Use when |
|---|---|
| `vanilla.js` | Any page. Static mode fetches `CHANGELOG.md` + `VERSION` as plain files and parses them client-side — zero backend. Also exposes the renderer for server-fed mode. |
| `versiontab.py` | Python-served apps: parse once server-side, ship `{version, changelog}` inside your existing data payload, call the renderer. Also runs standalone as a build step (`python3 versiontab.py` → JSON). |
| `version-tab.css` | The same skin `vanilla.js` injects, as a standalone file — for reference or framework re-implementations. |

## The changelog contract

Both parsers (they mirror each other line-for-line) read ordinary
`CHANGELOG.md` markdown, newest entry first:

```markdown
# Changelog

## v8.0 — 2026-07-10

### Optional subhead

Paragraph text with **bold** and `code`.

- bullets
  with wrapped continuation lines
```

Each `## version — date` heading starts an entry (em/en dash or hyphen all
work; the date is optional). Only `###` subheads, paragraphs, bullets,
`**bold**` and `` `code` `` are rendered — everything is HTML-escaped first.
`VERSION` is a one-line file with the current build (e.g. `8.0`); if it's
missing, the newest changelog entry's version is used.

## Vanilla usage (static site)

One script tag, one empty div. Configuration rides on `data-*` attributes of
the script tag (works inlined too); all are optional.

```html
<script src="vanilla.js"
        data-changelog="CHANGELOG.md"
        data-version="VERSION"
        data-icon="🏷️"
        data-loaded-text="loaded on this server"></script>

<div data-version-tab></div>   <!-- becomes the 🏷️ v8.0 chip -->
```

That's the whole integration: the chip shows a braille spinner (⠋⠙⠹…) while
fetching, then the live version. Clicking it opens the release notes in an
auto-created modal (Esc, ×, or a backdrop click closes it; the dialog
background uses the system `Canvas` color, so it follows the page's
`color-scheme`).

`data-version` takes either a URL to fetch (`VERSION`, `/api/version.txt`) or
a literal — values starting with a digit (optionally `v`) are used as-is
(`data-version="8.0"`).

### Inline panel instead of the modal

If you'd rather show the notes in your own layout (a settings page, a tab
pane), add a panel mount — the chip then toggles it instead of opening the
modal:

```html
<div data-version-tab></div>     <!-- chip -->
<div data-version-panel></div>   <!-- notes render here, start hidden -->
```

A `data-version-panel` with no chip on the page just renders in place,
always visible.

### Your own tab system

If the trigger is already a tab button you own (like the leaderboard's
Version tab), skip the chip and use a label stamp — it only sets
`textContent`, no click wiring:

```html
<button onclick="switchTab('version')">🏷️ <span data-version-label>Version</span></button>
<div id="tab-version" data-version-panel hidden></div>
```

## Server-fed usage (Python)

When your app already serves a JSON payload (and you want the notes read off
the *server's* disk — the point on an auto-deployed box), parse server-side
and hand the result to the renderer:

```python
from versiontab import payload

data = build_my_payload()
data.update(payload(ROOT))     # adds "version" + "changelog"
```

```html
<script src="vanilla.js" data-auto="off"></script>
<div data-version-tab></div>
```

```js
// wherever you consume your payload:
window.__versionTab.render(data.version, data.changelog);
```

`render()` updates every chip, panel, label, and an open modal, so the wiring
is the same in both modes — call it again on each poll and the chip bumps
when a deploy lands.

## Skinning

Everything ships with neutral defaults (translucent grays, inherits the
surrounding text color) so it looks right on any background. To skin it, set
custom properties — no CSS of your own to write:

```css
.vt-tab {                        /* the chip */
  --vt-tab-bg: #21262d;
  --vt-tab-border: #30363d;
  --vt-tab-hover-bg: #30363d;
}
.version-tab {                   /* the notes */
  --vt-accent: gold;             /* version badge background */
  --vt-accent-contrast: #1a1a1a; /* badge text */
  --vt-heading: gold;            /* ### subheads + inline code tint */
  --vt-dim: #8b949e;             /* dates, captions */
  --vt-border: #30363d;          /* rule under the header */
  --vt-border-subtle: #21262d;   /* rules between entries */
}
.vt-dialog {                     /* the modal */
  --vt-panel-bg: #0d1117;
  --vt-panel-color: #c9d1d9;
}
.vt-entry.latest .vt-ver { color: #fff; }  /* newest entry hook */
```

## API

`window.__versionTab`:

- `parse(text)` — CHANGELOG.md text → `[{version, date, html}]`
- `render(version, entries)` — feed data in: updates chips, panels, labels,
  and an open modal
- `open()` / `close()` / `toggle()` — drive the notes programmatically
- `refresh()` — re-run the static-mode fetch

`versiontab.py`: `load_version(root)`, `load_changelog(root)`,
`payload(root)`.

## Caveats

- Static mode fetches with `cache: "no-cache"`, but a CDN can still serve a
  stale `CHANGELOG.md`; on an auto-deployed origin, prefer the server-fed
  flavor — it reads the running server's own disk, which is the version that
  matters.
- Entry bodies from `versiontab.py` arrive pre-rendered and are injected as
  HTML — that's fine because both parsers escape their input, but don't feed
  `render()` entry HTML from an untrusted source.
