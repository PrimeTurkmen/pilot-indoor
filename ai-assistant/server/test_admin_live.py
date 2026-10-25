#!/usr/bin/env python3
"""Live smoke test for PilotAdmin: login -> list accounts -> travel_auth.

Reads the admin password from brownie hub p18 debug file on disk, prints
only non-sensitive summary fields. READ ONLY: no Pilot writes.
"""
import asyncio
import re
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pilot_admin import PilotAdmin


def find_creds():
    cand = "/Users/ceo/brownie/hub/deploy/p18_debug_pilot_lookup.py"
    src = open(cand).read()
    def grab(name):
        m = re.search(r"\b%s\s*=\s*['\"]([^'\"]+)['\"]" % name, src, re.I)
        return m.group(1) if m else ""
    return {
        "username": grab("USERNAME"),
        "password": grab("PASSWORD"),
        "email": grab("PARTNER_EMAIL"),
    }


async def main():
    c = find_creds()
    if not c["username"] or not c["password"]:
        print("FAIL: creds not found in p18 file")
        return
    adm = PilotAdmin(username=c["username"], password=c["password"],
                     partner_email=c["email"])
    res = await adm.login()
    print("login ok:", res.get("ok"), "| user:", c["username"],
          "| partner_id:", res.get("partner_id"),
          "| jwt len:", len(adm._jwt or ""))
    if not res.get("ok"):
        print("login error:", res.get("error"))
        return

    lst = await adm.list_accounts("", 0, 10)
    print("accounts ok:", lst["ok"], "| total:", lst.get("total"), "| rows:", len(lst.get("rows") or []))
    if lst.get("rows"):
        r0 = lst["rows"][0]
        print("row0 keys:", sorted(r0.keys())[:20])
        print("row0 id:", r0.get("id"), "| login:", r0.get("login"),
              "| org:", (r0.get("org_name") or r0.get("name") or "")[:40])

        tid = r0.get("id")
        if tid:
            trav = await adm.travel_auth(int(tid))
            f = trav.get("form") or {}
            print("travel ok:", trav["ok"], "| err:", trav.get("error"),
                  "| url:", (f.get("url") or "")[:60],
                  "| username len:", len(f.get("username") or ""),
                  "| token len:", len(f.get("token") or ""),
                  "| sec len:", len(f.get("sec_token") or ""),
                  "| id:", f.get("id"), "| role:", f.get("role"))
    print("DONE")


asyncio.run(main())
