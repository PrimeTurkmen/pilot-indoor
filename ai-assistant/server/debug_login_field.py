#!/usr/bin/env python3
"""Sample account rows to find the user login field. Prints NO passwords."""
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
    await adm.login()
    lst = await adm.list_accounts("", 0, 30)
    rows = lst.get("rows") or []
    nonnull = 0
    for r in rows:
        if r.get("login"):
            nonnull += 1
        print("id=%s login=%r owner_user=%r coden=%r codea=%r code=%r prefix=%r suffix=%r org=%s"
              % (r.get("id"), r.get("login"), r.get("owner_user"),
                 r.get("coden"), r.get("codea"), r.get("code"),
                 r.get("prefix"), r.get("suffix"),
                 (r.get("org_name") or "")[:30]))
    print("non-null login:", nonnull, "/", len(rows))


asyncio.run(main())
