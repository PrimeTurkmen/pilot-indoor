#!/usr/bin/env python3
"""Fetch admin frontend, find JS bundles, locate getUsersFormAuth usage."""
import re
import httpx

with httpx.Client(verify=False, timeout=30, follow_redirects=True) as c:
    r = c.get("https://adm.pilot-gps.com/")
    print("status", r.status_code, "len", len(r.text))
    scripts = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', r.text)
    links = re.findall(r'<link[^>]+href=["\']([^"\']+)["\']', r.text)
    print("scripts:", scripts)
    print("links:", links[:10])
    for s in scripts:
        if s.startswith("/"):
            s = "https://adm.pilot-gps.com" + s
        rr = c.get(s)
        print("---", s, rr.status_code, len(rr.text))
        idx = rr.text.find("getUsersFormAuth")
        if idx >= 0:
            print("FOUND at", idx)
            print(rr.text[max(0, idx - 600):idx + 600])
