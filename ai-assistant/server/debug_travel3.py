#!/usr/bin/env python3
"""Probe admin module names + fresh getUsersFormAuth per travel candidate."""
import asyncio
import json
import re
import sys
import os
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
    print("login ok, jwt len", len(adm._jwt or ""))

    async with httpx.AsyncClient(verify=False, timeout=20) as c:
        h = {"Authorization": "Bearer " + adm._jwt}
        for name in ["user.php", "users.php", "clients.php", "operators.php",
                     "webusers.php", "accounts2.php", "drivers.php", "objects.php",
                     "vehicles.php", "units.php", "cars.php"]:
            r = await c.get("https://adm.pilot-gps.com/backend/app/" + name, headers=h)
            print("MODULE", name, "->", r.status_code, str(r.text)[:60].replace("\n", " "))

        # fresh formauth per candidate
        for cand_label, uname in [("partner", "tsc")]:
            fa = await adm._accounts_request({"cmd": "getUsersFormAuth", "account_id": "17590"})
            print("\nformauth url:", fa.get("url"))
            print("formauth test_url:", fa.get("test_url"))
            print("formauth server:", fa.get("server"))
            print("formauth partner/role/id:", fa.get("partner"), fa.get("role"), fa.get("id"))
            r = await c.post(fa["url"].rstrip("/") + "/", data={
                "username": uname, "role": fa.get("role", "partner"),
                "id": str(fa.get("id", "")), "token": fa.get("token", ""),
                "sec_token": fa.get("sec_token", "")})
            print("TRAVEL [%s] %s -> %s" % (cand_label, fa["url"].rstrip("/") + "/", r.text[:150]))


asyncio.run(main())
