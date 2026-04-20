"""
check_links.py -- GPURental HTML 内部リンク網羅チェック
"""
import re, os, sys

BASE = os.path.dirname(__file__)

PAGES = [
    "public/landing/index.html",
    "public/portal/index.html",
    "public/workspace/index.html",
    "public/admin/index.html",
    "public/provider/index.html",
    "public/mypage/index.html",
    "public/lobby/index.html",
    "public/pricing.html",
    "public/404.html",
    "public/maintenance.html",
]

# JS ファイル内の window.location / href 参照も抽出
JS_FILES = [
    "public/landing/app.js",
    "public/portal/app.js",
    "public/workspace/app.js",
    "public/admin/app.js",
    "public/provider/app.js",
    "public/mypage/app.js",
    "public/lobby/app.js",
]

SKIP = re.compile(r'^(#|mailto:|https?://|javascript:|data:|\{|\$)')
HTML_PAT = re.compile(r'''(?:href|src|action)\s*=\s*["']([^"'>\s]+)["']''')
JS_PAT   = re.compile(r'''(?:location\.(?:href|replace|assign)\s*=\s*["']|window\.open\(["'])([^"')\s]+)["'\)]''')

results = {}  # page -> broken links

def resolve(link, page_path):
    """Resolve a relative link against a page path, return filesystem path."""
    if link.startswith('/'):
        # absolute from root
        # strip query/hash
        clean = link.split('?')[0].split('#')[0]
        if clean.endswith('/'):
            clean += 'index.html'
        return os.path.join(BASE, 'public', clean.lstrip('/'))
    else:
        page_dir = os.path.dirname(os.path.join(BASE, page_path))
        clean = link.split('?')[0].split('#')[0]
        return os.path.join(page_dir, clean)

def check_file(page_path, pattern, label):
    full = os.path.join(BASE, page_path)
    if not os.path.exists(full):
        print(f"  [MISSING PAGE] {page_path}")
        return []
    with open(full, encoding='utf-8', errors='ignore') as f:
        content = f.read()

    broken = []
    seen = set()
    for m in pattern.finditer(content):
        link = m.group(1)
        if SKIP.search(link): continue
        if link in seen: continue
        seen.add(link)

        target = resolve(link, page_path)
        exists = os.path.exists(target)
        if not exists:
            broken.append(link)

    return broken

print("=" * 60)
print("  GPURental Link Checker")
print("=" * 60)

all_broken = {}

# HTML pages
for page in PAGES:
    b = check_file(page, HTML_PAT, "HTML")
    if b:
        all_broken[page] = b

# JS files
for js in JS_FILES:
    b = check_file(js, JS_PAT, "JS")
    if b:
        all_broken.setdefault(js, []).extend(b)

# Also check landing page explicitly for common nav links
if not all_broken:
    print("\n✅ No broken links found!")
else:
    for page, links in sorted(all_broken.items()):
        print(f"\n{'='*50}")
        print(f"  {page}")
        print(f"{'='*50}")
        for l in sorted(set(links)):
            print(f"  ❌ {l}")

print("\n" + "=" * 60)
print(f"  Total pages/files with broken links: {len(all_broken)}")
print("=" * 60)
