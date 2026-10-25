#!/usr/bin/env python3
"""Inspect login response cookies + retry shell with cookies."""
import asyncio
import re
import sys
import json
import httpx

sys.path.insert(0, "/home/ceo/pilot-ai/server")
from pilot_admin import PilotAdmin


def grab(name, src):
    m = re.search(r"\b%s\s*=\s*['\"]([^'\"]+)['\"]" % name, src, re.I)
    return m.group(1) if m else ""


async def main():
    src = open("/tmp/p18_creds.py").read()
    u, p = grab("USERNAME", src), grab("PASSWORD", src)
    async with httpx.AsyncClient(verify=False, timeout=30, follow_redirects=False) as c:
        r = await c.post("https://adm.pilot-gps.com/backend/login.php",
                         data={"cmd": "login", "username": u, "password": p})
        print("login:", r.status_code, str(r.text)[:120])
        print("cookies:", [(k, str(v)[:30]) for k, v in r.cookies.items()])
        print("set-cookie:", r.headers.get("set-cookie", "")[:200])
        for path in ["/backend/app/", "/backend/"]:
            rr = await c.get("https://adm.pilot-gps.com" + path)
            print("===", path, rr.status_code, len(rr.text))
            if rr.status_code == 200:
                open("/tmp/admin_shell.html", "w").write(rr.text)
                js = sorted(set(re.findall(r'["\']([^"\']+\.js[^"\']*)["\']', rr.text)))
                print("js files:", js[:40])
                # look for module registry
                mods = re.findall(r"['\"]([a-z0-9_]+\.php)['\"]", rr.text)
                print("php refs:", sorted(set(mods))[:60])


asyncio.run(main())
