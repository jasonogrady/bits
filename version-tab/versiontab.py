"""version-tab, server-side flavor — VERSION + CHANGELOG.md → JSON payload.

For apps that already serve their own data endpoint: parse once on the
server, ship the result inside your payload, and let the client renderer
draw it (load vanilla.js with data-auto="off", then call
window.__versionTab.render(version, entries)).

    from versiontab import payload
    data.update(payload(ROOT))        # adds "version" + "changelog"

Or run it as a build step — prints the payload as JSON:

    python3 versiontab.py [project-root]

Zero dependencies (stdlib only). The parser is the source of truth for the
changelog format and is mirrored line-for-line by vanilla.js's parse():

    # Changelog                       ← title line, ignored
    ## v8.0 — 2026-07-10              ← one entry per "## version — date"
    ### Optional subhead
    Paragraph text with **bold** and `code`.
    - bullets
      with wrapped continuation lines
"""

import html
import json
import re
import sys
from pathlib import Path


def load_version(root=".") -> str:
    """Current build version from the VERSION file (e.g. '8.0'); '' if absent."""
    try:
        return (Path(root) / "VERSION").read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def _inline(s: str) -> str:
    """Inline markdown → HTML on an HTML-escaped string: **bold**, `code`."""
    s = html.escape(s, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`(.+?)`", r"<code>\1</code>", s)
    return s


def _body_html(lines: list) -> str:
    """Render one changelog entry's body — `### ` subheads, `- ` bullets (with
    wrapped continuation lines), and plain paragraphs — into an HTML fragment."""
    out, para, li, items = [], [], [], []

    def flush_para():
        if para:
            out.append('<p class="vt-p">' + _inline(" ".join(para)) + "</p>")
            para.clear()

    def flush_item():
        if li:
            items.append("<li>" + _inline(" ".join(li)) + "</li>")
            li.clear()

    def flush_list():
        flush_item()
        if items:
            out.append('<ul class="vt-list">' + "".join(items) + "</ul>")
            items.clear()

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            flush_para(); flush_list(); continue
        if line.startswith("### "):
            flush_para(); flush_list()
            out.append('<h4 class="vt-sub">' + _inline(line[4:].strip()) + "</h4>")
        elif line.startswith("- "):
            flush_para(); flush_item()
            li.append(line[2:].strip())
        elif line[:1] in (" ", "\t") and (li or items):
            li.append(line.strip())                    # wrapped bullet continuation
        else:
            if li or items:
                flush_list()
            para.append(line.strip())
    flush_para(); flush_list()
    return "".join(out)


def load_changelog(root=".") -> list:
    """Parse CHANGELOG.md → [{version, date, html}], newest first (file order)."""
    try:
        text = (Path(root) / "CHANGELOG.md").read_text(encoding="utf-8")
    except Exception:
        return []
    entries, cur, body = [], None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if cur:
                cur["html"] = _body_html(body); entries.append(cur)
            head = line[3:].strip()                    # e.g. 'v8.0 — 2026-07-10'
            parts = re.split(r"\s+[—–-]\s+", head, maxsplit=1)
            cur = {"version": parts[0].strip(),
                   "date": parts[1].strip() if len(parts) > 1 else ""}
            body = []
        elif line.startswith("# "):
            continue                                   # the '# Changelog' title
        elif cur is not None:
            body.append(line)
    if cur:
        cur["html"] = _body_html(body); entries.append(cur)
    return entries


def payload(root=".") -> dict:
    """{'version': ..., 'changelog': [...]} — merge into your app's payload.
    version falls back to the newest changelog entry when VERSION is absent."""
    version = load_version(root)
    changelog = load_changelog(root)
    if not version and changelog:
        version = changelog[0]["version"]
    return {"version": version, "changelog": changelog}


if __name__ == "__main__":
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    print(json.dumps(payload(root), ensure_ascii=False, indent=2))
