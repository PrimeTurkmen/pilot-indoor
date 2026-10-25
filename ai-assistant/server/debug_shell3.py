#!/usr/bin/env python3
"""GET adm root WITH auth; find app shell + module registry."""
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
        r = await c.get("https://adm.pilot-gps.com/", headers=h)
        print("root:", r.status_code, len(r.text))
        hits = [m.start() for m in re.finditer(r"FormAuth|travel|app\.js|modules", r.text)]
        print("hits:", hits[:15])
        open("/tmp/admin_root.html", "w").write(r.text)
        js = sorted(set(re.findall(r'["\']([^"\']+\.js[^"\']*)["\']', r.text)))
        print("js:", js[:50])
        # if ExtJS, app.js defines controllers; find file that has 'FormAuth'
        for s in js:
            if not s.startswith("http"):
                s = "https://adm.pilot-gps.com/" + s.lstrip("/")
            try:
                rr = await c.get(s, headers=h)
            except Exception as e:
                print("ERR", s, e)
                continue
            if "FormAuth" in rr.text or "travel" in rr.text.lower():
                i = rr.text.find("FormAuth")
                print(">>> FOUND in", s, "len", len(rr.text))
                print(rr.text[max(0, i - 500):i + 700])
                open("/tmp/found_js.txt", "w").write(rr.text)


asyncio.run(main())
