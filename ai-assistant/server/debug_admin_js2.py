#!/usr/bin/env python3
"""Find getUsersFormAuth usage in admin frontend inline JS + bundles."""
import re
import httpx

with httpx.Client(verify=False, timeout=30, follow_redirects=True) as c:
    r = c.get("https://adm.pilot-gps.com/")
    html = r.text
    for m in re.finditer(r"getUsersFormAuth", html):
        i = m.start()
        print("=== HTML hit at", i)
        print(html[max(0, i - 800):i + 800].replace("\\n", "\n"))
        print()
    # find more script srcs (js files)
    srcs = set(re.findall(r'["\']((?:js|app|build)[^"\']*\.js)["\']', html))
    print("candidate js:", sorted(srcs)[:30])
    for s in sorted(srcs):
        url = "https://adm.pilot-gps.com/" + s
        try:
            rr = c.get(url)
        except Exception as e:
            print("ERR", url, e)
            continue
        idx = rr.text.find("getUsersFormAuth")
        print(url, rr.status_code, len(rr.text), "HIT" if idx >= 0 else "")
        if idx >= 0:
            print(rr.text[max(0, idx - 800):idx + 800])
