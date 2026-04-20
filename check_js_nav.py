"""
check_js_nav.py - JS ファイル内の画面遷移リンクをチェック
"""
import re, os

BASE = os.path.dirname(os.path.abspath(__file__))

JS_FILES = [
    "public/portal/app.js",
    "public/workspace/app.js",
    "public/admin/app.js",
    "public/lobby/app.js",
]

nav_pat = re.compile(
    r'location\.(?:href|replace|assign)\s*=\s*["\']([^"\'#?\s]+)'
    r"|window\.open\([\"']([^\"'#?\s]+)"
)
skip = re.compile(r'^(#|mailto:|https?://|javascript:|data:)')

ROUTES_OK = {
    "/", "/portal", "/portal/", "/workspace", "/workspace/",
    "/admin", "/admin/", "/provider", "/provider/",
    "/mypage", "/mypage/", "/lobby", "/lobby/",
    "/pricing", "/pricing.html",
    "/terms", "/terms.html", "/privacy", "/privacy.html",
    "/404.html", "/maintenance.html",
    "/api/docs",
}

def path_exists_or_route(link):
    """Check if link resolves to a file or is a known server route."""
    if link in ROUTES_OK:
        return True
    # Check if it starts with /api/ (server handles it)
    if link.startswith("/api/"):
        return True
    # Try as static file
    rel = link.lstrip("/").split("?")[0].split("#")[0]
    if rel.endswith("/"):
        rel += "index.html"
    candidate = os.path.join(BASE, "public", rel)
    return os.path.exists(candidate)

all_broken = {}
for js in JS_FILES:
    full = os.path.join(BASE, js)
    if not os.path.exists(full):
        print(f"[MISSING] {js}")
        continue
    with open(full, encoding="utf-8", errors="ignore") as f:
        content = f.read()
    broken = []
    seen = set()
    for m in nav_pat.finditer(content):
        link = m.group(1) or m.group(2)
        if not link or skip.search(link):
            continue
        link = link.split("?")[0].split("#")[0]
        if link in seen:
            continue
        seen.add(link)
        if not path_exists_or_route(link):
            broken.append(link)
    if broken:
        all_broken[js] = broken

print("\n=== JS Navigation Broken Links ===")
if not all_broken:
    print("  (none)")
else:
    for js, links in all_broken.items():
        print(f"\n  {js}:")
        for l in sorted(set(links)):
            print(f"    ❌ {l}")
