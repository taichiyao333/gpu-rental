"""add_favicon.py - workspace, admin, lobby に favicon を追加"""
import os, re

BASE = os.path.dirname(os.path.abspath(__file__))

targets = [
    "public/workspace/index.html",
    "public/admin/index.html",
    "public/lobby/index.html",
]

FAVICON_TAG = '    <link rel="icon" href="/favicon.ico">\n'

for p in targets:
    full = os.path.join(BASE, p)
    if not os.path.exists(full):
        print(f"MISSING: {p}")
        continue
    with open(full, encoding="utf-8", errors="ignore") as f:
        content = f.read()

    if "favicon" in content.lower():
        print(f"SKIP (already has favicon): {p}")
        continue

    # Insert after <head> or <meta charset=
    if '<meta charset' in content:
        # Insert after first <meta charset> line
        content = re.sub(
            r'(<meta\s+charset[^>]+>)',
            r'\1\n' + FAVICON_TAG.rstrip('\n'),
            content,
            count=1
        )
    elif '<head>' in content:
        content = content.replace('<head>', '<head>\n' + FAVICON_TAG.rstrip('\n'), 1)
    else:
        print(f"WARN: Could not find insertion point in {p}")
        continue

    with open(full, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"ADDED favicon: {p}")
