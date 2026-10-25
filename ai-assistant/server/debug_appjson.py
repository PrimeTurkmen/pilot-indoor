#!/usr/bin/env python3
"""Fetch app.json manifest, download app JS, find travel/FormAuth handler."""
import asyncio
import json
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
    async with httpx.AsyncClient(verify=False, timeout=30) as c:
        h = {"Authorization": "Bearer " + adm._jwt}
        man = await c.get("https://adm.pilot-gps.com/app.json", headers=h)
        print("app.json:", man.status_code, len(man.text))
        if man.status_code != 200:
            print(man.text[:300])
            return
        m = json.loads(man.text)
        js = m.get("js") or []
        print("js count:", len(js))
        for e in js:
            path = e.get("path")
            if not path:
                continue
            url = "https://adm.pilot-gps.com/" + path.lstrip("/")
            try:
                rr = await c.get(url, headers=h)
            except Exception as ex:
                print("ERR", path, ex)
                continue
            if "FormAuth" in rr.text or "travel" in rr.text.lower():
                print(">>> HIT", path, len(rr.text))
                open("/tmp/hit_js.txt", "w").write(rr.text)
                i = rr.text.find("FormAuth")
                j = rr.text.lower().find("travel")
                if i >= 0:
                    print(rr.text[max(0, i - 400):i + 600])


asyncio.run(main())
