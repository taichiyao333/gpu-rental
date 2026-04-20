"""
check_api_calls.py - JS ファイル内の fetch/axios API 呼び出しを抽出・確認

サーバー側で定義されていない /api/xxx を検出する
"""
import re, os, json

BASE = os.path.dirname(os.path.abspath(__file__))

JS_FILES = [
    "public/portal/app.js",
    "public/workspace/app.js",
    "public/admin/app.js",
    "public/lobby/app.js",
]

FETCH_PAT = re.compile(
    r'(?:fetch|axios\.(?:get|post|put|patch|delete))\s*\(\s*[`"\']([^`"\']+)[`"\']'
)
API_CONST_PAT = re.compile(r'''(?:API\s*\+\s*['"`]|`\$\{API\})(\/[^'"`\s)]+)''')

# Known server routes from index.js
KNOWN_API = {
    "/api/auth/login", "/api/auth/register", "/api/auth/me",
    "/api/auth/forgot-password", "/api/auth/reset-password",
    "/api/auth/agent-token", "/api/auth/agent-token/regenerate",
    "/api/gpus", "/api/gpus/detect", "/api/gpus/register",
    "/api/reservations", "/api/pods", "/api/pods/active",
    "/api/files", "/api/payments", "/api/providers",
    "/api/bank-accounts", "/api/points", "/api/outage",
    "/api/prices", "/api/coupons", "/api/user/apikeys",
    "/api/diagnose", "/api/render", "/api/stripe",
    "/api/admin", "/api/agent",
    "/api/health", "/api/maintenance/status",
    "/api/config/recaptcha", "/api/bench/download", "/api/bench/upload",
    "/api/docs", "/api/docs.json",
    "/api/blender",
    # SF routes
    "/api/sf/nodes", "/api/sf/nodes/heartbeat",
    "/api/sf/matches", "/api/sf/matches/confirm",
    "/api/sf/raid", "/api/sf/raid/confirm", "/api/sf/raid/status",
    "/api/sf/settings", "/api/sf/stats/public",
    # payments - SF
    "/api/payments/sf-raid/pay-with-points",
    "/api/payments/sf-raid/create-stripe-session",
    "/api/payments/pay-with-points",
    # admin SF
    "/api/admin/sf/nodes", "/api/admin/sf/raid-jobs",
    # points
    "/api/points/purchase", "/api/points/balance",
    "/api/points/epsilon/callback",
    # inference
    "/api/inference",
}

print("=" * 65)
print("  GPURental API Call Checker")
print("=" * 65)

all_issues = {}

for js_path in JS_FILES:
    full = os.path.join(BASE, js_path)
    if not os.path.exists(full):
        print(f"\n  [MISSING FILE] {js_path}")
        continue
    with open(full, encoding="utf-8", errors="ignore") as f:
        content = f.read()

    found_apis = set()
    for m in FETCH_PAT.finditer(content):
        url = m.group(1)
        if url.startswith("/api/") or "${API}" in url or "`${" in url:
            # strip variable interpolation
            url_clean = re.sub(r'\$\{[^}]+\}', ':id', url)
            if url_clean.startswith("/api/"):
                found_apis.add(url_clean)

    # Also look for API + '/...' patterns
    for m in API_CONST_PAT.finditer(content):
        url = m.group(1).split("?")[0].split("`")[0]
        url_full = "/api" + url
        found_apis.add(url_full)

    # Check which are not in known routes (prefix match)
    unknown = []
    for api in sorted(found_apis):
        # prefix match: /api/admin/xxx matches /api/admin
        matched = any(api == known or api.startswith(known + "/") or api.startswith(known + "?")
                      for known in KNOWN_API)
        if not matched:
            unknown.append(api)

    if unknown:
        all_issues[js_path] = unknown
        print(f"\n  📄 {js_path}:")
        for u in unknown:
            print(f"    ⚠️  {u}")

if not all_issues:
    print("\n  ✅ All API calls match known routes!")

print(f"\n{'='*65}")
