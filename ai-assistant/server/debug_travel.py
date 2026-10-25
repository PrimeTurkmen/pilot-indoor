#!/usr/bin/env python3
"""Debug getUsersFormAuth raw response shape. READ ONLY."""
import asyncio
import re
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pilot_admin import PilotAdmin


def grab(name, src):
    m = re.search(r"\b%s\s*=\s*['\"]([^'\"]+)['\"]" % name, src, re.I)
    return m.group(1) if m else ""


async def main():
    src = open("/Users/ceo/brownie/hub/deploy/p18_debug_pilot_lookup.py").read()
    adm = PilotAdmin(username=grab("USERNAME", src), password=grab("PASSWORD", src),
                     partner_email=grab("PARTNER_EMAIL", src))
    res = await adm.login()
    print("login:", res)

    lst = await adm.list_accounts("", 0, 3)
    r0 = (lst.get("rows") or [{}])[0]
    print("row0 id:", r0.get("id"))
    print("row0 FULL keys:", sorted(r0.keys()))
    print("row0 login-ish:", {k: r0[k] for k in r0 if "login" in k.lower() or "user" in k.lower() or "name" in k.lower()})

    raw = await adm._accounts_request({"cmd": "getUsersFormAuth", "account_id": str(r0.get("id"))})
    print("raw type:", type(raw).__name__)
    if isinstance(raw, dict):
        print("raw keys:", sorted(raw.keys()))
        for k, v in raw.items():
            s = str(v)
            print("  ", k, "=", s[:120] + ("…" if len(s) > 120 else ""))
    else:
        print("raw:", str(raw)[:200])


asyncio.run(main())
