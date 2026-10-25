#!/usr/bin/env python3
"""Discover tracking backend endpoints reachable with the travel PILOTID cookie."""
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
    users = await adm._accounts_request({"cmd": "getUsers", "account_id": "17590"})
    login = users["data"][0]["login"]
    fa = await adm._accounts_request({"cmd": "getUsersFormAuth", "account_id": "17590",
                                      "host": "adm.pilot-gps.com", "protocol": "https:"})
    async with httpx.AsyncClient(verify=False, timeout=25, follow_redirects=False) as c:
        r = await c.post(fa["url"], data={"username": login, "role": fa["role"],
                                          "id": str(fa["id"]), "token": fa["token"],
                                          "sec_token": fa["sec_token"]})
        cookie = r.headers.get("set-cookie", "").split(";")[0]
        print("cookie ok:", bool(cookie))
        h = {"Cookie": cookie}
        for path in [
            "backend/main.php", "backend/init.php", "backend/data.php",
            "backend/app/units.php", "backend/app/vehicles.php", "backend/app/map.php",
            "backend/get_data.php?cmd=getVehicles", "backend/command.php",
            "backend/app.php", "backend/index.php", "backend/user/get.php",
            "api/v3/vehicles", "api/v3/user/me", "api/v3/account",
        ]:
            try:
                rr = await c.get("https://pilot-gps.com/" + path, headers=h)
            except Exception as e:
                print("ERR", path, e)
                continue
            body = str(rr.text)[:100].replace("\n", " ")
            print(rr.status_code, path, "len", len(rr.text), "|", body)


asyncio.run(main())
