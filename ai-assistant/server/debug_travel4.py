#!/usr/bin/env python3
"""Travel the REAL way: getUsers -> formauth(host/protocol) -> POST 5 fields."""
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
    print("login ok")

    acc_id = "17590"
    # 1. users of the account
    users = await adm._accounts_request({"cmd": "getUsers", "account_id": acc_id})
    print("getUsers type:", type(users).__name__, "keys:", list(users.keys())[:8]
          if isinstance(users, dict) else "")
    rows = users.get("rows") or users.get("data") or []
    print("users count:", len(rows))
    for u in rows[:3]:
        print("  user id=%r login=%r name=%r status=%r" % (
            u.get("id"), u.get("login"), u.get("name"), u.get("status")))

    # 2. formauth with host/protocol
    fa = await adm._accounts_request({
        "cmd": "getUsersFormAuth", "account_id": acc_id,
        "host": "adm.pilot-gps.com", "protocol": "https:"})
    print("formauth url:", fa.get("url"), "| role:", fa.get("role"),
          "| id:", fa.get("id"), "| partner:", fa.get("partner"))

    # 3. travel POST with first user's login
    login = rows[0].get("login") if rows else None
    async with httpx.AsyncClient(verify=False, timeout=30, follow_redirects=False) as c:
        r = await c.post(fa["url"], data={
            "username": login, "role": fa.get("role", "partner"),
            "id": str(fa.get("id", "")), "token": fa.get("token", ""),
            "sec_token": fa.get("sec_token", "")})
        print("TRAVEL status:", r.status_code)
        print("TRAVEL body:", str(r.text)[:200])
        print("TRAVEL set-cookie:", r.headers.get("set-cookie", "")[:200])
        print("TRAVEL location:", r.headers.get("location", ""))


asyncio.run(main())
