#!/usr/bin/env python3
"""Find the user login for travel: try users.php grid + probe travel POST.
READ ONLY (admin session only, no writes)."""
import asyncio
import json
import re
import sys
import os
import httpx
import ssl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pilot_admin import PilotAdmin

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def grab(name, src):
    m = re.search(r"\b%s\s*=\s*['\"]([^'\"]+)['\"]" % name, src, re.I)
    return m.group(1) if m else ""


async def main():
    src = open("/Users/ceo/brownie/hub/deploy/p18_debug_pilot_lookup.py").read()
    adm = PilotAdmin(username=grab("USERNAME", src), password=grab("PASSWORD", src),
                     partner_email=grab("PARTNER_EMAIL", src))
    await adm.login()

    async with httpx.AsyncClient(verify=False, timeout=30) as c:
        h = {"Authorization": "Bearer " + adm._jwt}

        # 1. users grid for account 17590
        for path in ["backend/app/users.php", "backend/app/users2.php"]:
            r = await c.get("https://adm.pilot-gps.com/" + path, headers=h,
                            params={"cmd": "read", "filter": json.dumps(
                                [{"property": "account_id", "value": "17590", "operator": "eq"}])})
            print(path, r.status_code, str(r.text)[:150].replace("\n", " "))

        # 2. travel POST probe: which username works?
        fa = await adm._accounts_request({"cmd": "getUsersFormAuth", "account_id": "17590"})
        print("formauth keys:", sorted(fa.keys()))
        url = fa["url"].rstrip("/") + "/"
        candidates = {
            "numeric_id": "17590",
            "partner": fa.get("partner", ""),
            "org_lower": "rollsstar",
        }
        for label, uname in candidates.items():
            r = await c.post(url, data={
                "username": uname, "role": fa.get("role", "partner"),
                "id": str(fa.get("id", "")), "token": fa.get("token", ""),
                "sec_token": fa.get("sec_token", "")})
            ct = r.headers.get("content-type", "")
            body = r.text[:120].replace("\n", " ")
            print(f"[{label}] status={r.status_code} ct={ct[:30]} body={body}")
            print(f"    set-cookie: {r.headers.get('set-cookie', '')[:80]}")


asyncio.run(main())
