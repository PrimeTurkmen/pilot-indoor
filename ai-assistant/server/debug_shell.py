#!/usr/bin/env python3
"""Fetch authenticated admin app shell + ExtJS bootstrap, find travel handler."""
import asyncio
import re
import sys
import httpx

sys.path.insert(0, "/home/ceo/pilot-ai/server")
from pilot_admin import PilotAdmin


def grab(name, src):
    m = re.search(r"\b%s\s*=\s*['\"]([^'\"]+)['\"]" % name, src, re.I)
    return m.group(1) if m else ""


async def main():
    src = open("/tmp/p18_creds.py").read()
    adm = PilotAdmin(username=grab("USERNAME", src), password=grab("PASSWORD", src),
                     partner_email=grab("PARTNER_EMAIL", src))
    await adm.login()

    async with httpx.AsyncClient(verify=False, timeout=30, follow_redirects=True) as c:
        h = {"Authorization": "Bearer " + adm._jwt}
        for path in ["/backend/app/", "/backend/app/index.php", "/backend/", "/backend/index.php"]:
            try:
                r = await c.get("https://adm.pilot-gps.com" + path, headers=h)
            except Exception as e:
                print(path, "ERR", e)
                continue
            print("===", path, r.status_code, len(r.text),
                  r.headers.get("content-type", "")[:40])
            hits = [m.start() for m in re.finditer(r"FormAuth|travel|app\.js|Ext\.application", r.text)]
            print("   hits:", hits[:10])
            if r.status_code == 200 and len(r.text) > 500:
                open("/tmp/admin_shell.html", "w").write(r.text)
                js = set(re.findall(r'["\']([^"\']+\.js[^"\']*)["\']', r.text))
                print("   js files:", sorted(js)[:40])
                break


asyncio.run(main())
