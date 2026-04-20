"""check_scripts.py"""
import re, os
BASE = os.path.dirname(os.path.abspath(__file__))
pages = [
    "public/portal/index.html",
    "public/workspace/index.html",
    "public/lobby/index.html",
    "public/admin/index.html",
    "public/mypage/index.html",
    "public/provider/index.html",
]
script_pat = re.compile(r'<script[^>]+src=["\']([^"\']+)["\']', re.IGNORECASE)
for p in pages:
    full = os.path.join(BASE, p)
    if not os.path.exists(full):
        continue
    with open(full, encoding="utf-8", errors="ignore") as f:
        c = f.read()
    scripts = script_pat.findall(c)
    if scripts:
        print(f"\n{p}:")
        for s in scripts:
            print(f"  {s}")
