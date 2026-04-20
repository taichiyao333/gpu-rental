"""
full_link_check.py - 全ページ・全リンクの詳細チェック
"""
import re, os, sys

BASE = os.path.dirname(os.path.abspath(__file__))

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

# Server-side routes (don't need static files)
SERVER_ROUTES = {
    "/", "/portal", "/portal/", "/workspace", "/workspace/",
    "/admin", "/admin/", "/provider", "/provider/",
    "/mypage", "/mypage/", "/lobby", "/lobby/",
    "/pricing", "/pricing.html",
    "/terms", "/terms.html", "/privacy", "/privacy.html",
    "/password-gate.js",
}

pat = re.compile(r'''(?:href|src|action)\s*=\s*["']([^"'>\s]+)["']''')
skip_prefix = re.compile(r'^(mailto:|javascript:|data:|\{|\$\{)')

def classify(link, page_path):
    raw = link
    link_clean = link.split("?")[0].split("#")[0]
    if not link_clean or link_clean == "#":
        return "OK_anchor"
    if skip_prefix.search(link_clean):
        return "OK_special"
    if link_clean.startswith("http://") or link_clean.startswith("https://"):
        return "OK_external"
    if link_clean.startswith("//"):
        # protocol-relative (e.g. //translate.google.com)
        return "OK_external_proto_relative"
    if link_clean.startswith("/api/"):
        return "OK_api"
    if link_clean in SERVER_ROUTES:
        return "OK_route"

    # Resolve path
    if link_clean.startswith("/"):
        rel = link_clean.lstrip("/")
        if not rel or rel.endswith("/"):
            rel = rel + "index.html"
        candidate = os.path.join(BASE, "public", rel)
    else:
        page_dir = os.path.dirname(os.path.join(BASE, page_path))
        candidate = os.path.normpath(os.path.join(page_dir, link_clean))

    if os.path.exists(candidate):
        return "OK_file"
    else:
        return f"BROKEN:{candidate}"

results = {}

for page in PAGES:
    full = os.path.join(BASE, page)
    if not os.path.exists(full):
        results[page] = [("PAGE_MISSING", page)]
        continue
    with open(full, encoding="utf-8", errors="ignore") as f:
        content = f.read()
    broken = []
    seen = set()
    for m in pat.finditer(content):
        link = m.group(1)
        if link in seen:
            continue
        seen.add(link)
        status = classify(link, page)
        if status.startswith("BROKEN"):
            broken.append((link, status))
    if broken:
        results[page] = broken

print("=" * 65)
print("  GPURental Comprehensive Link Check")
print("=" * 65)

if not results:
    print("\n  ✅ All links OK!")
else:
    for page, issues in sorted(results.items()):
        print(f"\n{'─'*65}")
        print(f"  📄 {page}")
        print(f"{'─'*65}")
        for link, status in issues:
            target = status.replace("BROKEN:", "")
            print(f"  ❌ {link}")
            print(f"       → {target}")

total = sum(len(v) for v in results.values())
print(f"\n{'='*65}")
print(f"  Pages with broken links: {len(results)}")
print(f"  Total broken links:      {total}")
print("=" * 65)
