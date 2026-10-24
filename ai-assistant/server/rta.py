"""
RTA Dubai traffic-fines connector (Python port of TAKE-AUTO/scripts/rta-fines.cjs).

Anonymous, no-login, per-plate fines lookup through the comgw.rta.ae gateway.
Every request/response body is AES-128-CBC encrypted and wrapped as {_data:<b64>}.
Key = base64 of a client-side constant from the public SPA bundle (not a secret);
IV = same 16 bytes. apiKey is likewise a client constant, provided via env
(RTA_API_KEY) — set it in the .env, it is not embedded in source.
"""
import base64
import json
import os
import re
import time
import threading

from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad
import httpx

RTA_AES_KEY_B64 = os.environ.get("RTA_AES_KEY_B64", "WGckN3lQXnEyWiFuUjU+aw==")
RTA_API_KEY = os.environ.get("RTA_API_KEY", "")
RTA_GATEWAY = os.environ.get("RTA_GATEWAY", "https://comgw.rta.ae")
RTA_ORIGIN = "https://ums.rta.ae"
RTA_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)

KEY = base64.b64decode(RTA_AES_KEY_B64)  # 16 bytes


def _enc(obj) -> str:
    raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    cipher = AES.new(KEY, AES.MODE_CBC, KEY)
    return base64.b64encode(cipher.encrypt(pad(raw, 16))).decode()


def _dec(b64: str) -> str:
    cipher = AES.new(KEY, AES.MODE_CBC, KEY)
    return unpad(cipher.decrypt(base64.b64decode(b64)), 16).decode("utf-8")


def _unwrap(text: str):
    j = json.loads(text)
    if isinstance(j, dict) and "_data" in j:
        return json.loads(_dec(j["_data"]))
    return j


def _headers(extra=None):
    h = {
        "User-Agent": RTA_UA,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": RTA_ORIGIN,
        "Referer": RTA_ORIGIN + "/",
    }
    if extra:
        h.update(extra)
    return h


_cache_auth = {"jwt": None, "cookie": None, "exp_ms": 0}
_auth_lock = threading.Lock()


def _guest_auth():
    if _cache_auth["jwt"] and _cache_auth["exp_ms"] - time.time() * 1000 > 60_000:
        return _cache_auth["jwt"], _cache_auth["cookie"]
    if not RTA_API_KEY:
        raise RuntimeError("RTA_API_KEY not configured")
    with _auth_lock:
        # re-check after acquiring the lock (double-checked locking)
        if _cache_auth["jwt"] and _cache_auth["exp_ms"] - time.time() * 1000 > 60_000:
            return _cache_auth["jwt"], _cache_auth["cookie"]
        with httpx.Client(timeout=30) as client:
            r = client.post(
                RTA_GATEWAY + "/auth/anonymous/login",
                headers=_headers(),
                content=json.dumps({"_data": _enc({"channelCode": "PORTAL", "apiKey": RTA_API_KEY})}),
            )
            r.raise_for_status()
            cookie = "; ".join(c.split(";")[0] for c in (r.headers.get_list("set-cookie") or []))
            body = _unwrap(r.text)
            jwt = body.get("access_token") or body.get("accessToken")
            if not jwt:
                raise RuntimeError("RTA login: no token")
            try:
                payload = jwt.split(".")[1]
                payload += "=" * (-len(payload) % 4)
                exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp", 0)
            except Exception:
                exp = 0
            exp_ms = (exp * 1000) if exp else (time.time() * 1000 + 25 * 60_000)
            _cache_auth.update(jwt=jwt, cookie=cookie, exp_ms=exp_ms)
            return jwt, cookie


EMIRATES = ["SHJ", "AUH", "AJM", "UMQ", "RAK", "FUJ", "DXB"]

# Plate-search config (sourceCode -> categories -> codes), cached ~1 day.
_plate_config = None
_plate_config_ts = 0.0


def _get_plate_config():
    global _plate_config, _plate_config_ts
    if _plate_config and time.time() - _plate_config_ts < 86400:
        return _plate_config
    jwt, cookie = _guest_auth()
    r = httpx.get(
        RTA_GATEWAY + "/comgw/mastersetup/api/msd/get-plate-search",
        headers=_headers({"Authorization": "Bearer " + jwt, "Cookie": cookie}),
        timeout=30,
    )
    r.raise_for_status()
    _plate_config = _unwrap(r.text)
    _plate_config_ts = time.time()
    return _plate_config


def _uts_plate_code(source_code, category, display_code):
    """Resolve a display plate code ('3') to the UTS code ('692') for a source."""
    try:
        cfg = _get_plate_config()
    except Exception:
        return display_code
    for src in cfg or []:
        if src.get("sourceCode") != source_code:
            continue
        for cat in src.get("plateCategories", []):
            if cat.get("dxPlateCategoryCode") != category:
                continue
            for code in cat.get("plateCodes", []):
                if code.get("dxPlateCode") == display_code or code.get("plateCfiCode") == display_code:
                    return code.get("utsPlateCode") or code.get("dxPlateCode") or display_code
    return display_code


def decode_plate(raw):
    """Split free text -> RTA plate fields, resolving emirate + UTS plate code.

    Dubai (DXB) plates use a LETTER code; Sharjah/Abu Dhabi/other emirates use a
    numeric DISPLAY code that maps to a UTS plate code (e.g. Sharjah '3' -> 692)."""
    if not raw:
        return None
    cleaned = re.sub(r"\b(dubai|dxb|private|plate|no\.?)\b", " ", str(raw), flags=re.I).upper()
    emirate = None
    m = re.search(r"\b(" + "|".join(EMIRATES) + r")(?=\d|\s|$)", cleaned)
    if m:
        emirate = m.group(1)
        rest = cleaned.replace(m.group(1), " ", 1)
    else:
        emirate = "DXB"
        rest = cleaned
    digits = re.findall(r"\d{1,5}", rest)
    if not digits:
        return None
    plate_no = sorted(digits, key=len, reverse=True)[0]
    if emirate == "DXB":
        letters = re.findall(r"[A-Z]{1,2}", rest) or []
        plate_code = letters[0] if letters else ""
    else:
        code_digits = [d for d in digits if d != plate_no]
        display_code = code_digits[0] if code_digits else ""
        plate_code = _uts_plate_code(emirate, "PRIVATE", display_code)
    if not plate_code:
        return None
    return {
        "plateCategory": "PRIVATE",
        "plateCode": plate_code,
        "plateNo": plate_no,
        "sourceCodes": [emirate],
    }


def lookup_fines(query):
    """Look up payable fines for one plate, trying each emirate source in order."""
    jwt, cookie = _guest_auth()
    sources = query.get("sourceCodes") or [query.get("sourceCode") or "DXB"]
    auth_header = "Bearer " + jwt
    rows = []
    with httpx.Client(timeout=30) as client:
        for src in sources:
            request_body = {
                "sortBy": "CREATION_DATE",
                "sortDirection": "DESC",
                "rtaUnifiedNo": None,
                "pageSize": 50,
                "pageNo": 0,
                "plateCategory": query["plateCategory"],
                "plateNo": query["plateNo"],
                "plateCode": query["plateCode"],
                "searchKey": "",
                "sourceCode": src,
                "source": src,
                "sourceType": "UAE",
                "licenseSource": None,
                "driverLicenseNumber": None,
                "fineNumber": None,
                "fineYear": None,
                "fineSource": None,
                "countryId": None,
                "searchFilter": False,
            }
            r = client.post(
                RTA_GATEWAY + "/comgw/cvs/api/public/payable-fines",
                headers=_headers({"Authorization": auth_header, "Cookie": cookie}),
                content=json.dumps({"_data": _enc(request_body)}),
            )
            r.raise_for_status()
            body = _unwrap(r.text)
            got = body.get("content") if isinstance(body, dict) else None
            got = got if isinstance(got, list) else []
            if got:
                rows = got
                break
    fines = []
    for row in rows:
        fines.append(
            {
                "referenceNo": row.get("trafficFineReferenceNo") or "",
                "amount": row.get("totalFine") if isinstance(row.get("totalFine"), (int, float)) else 0,
                "blackPoints": row.get("blackPoints") if isinstance(row.get("blackPoints"), (int, float)) else 0,
                "description": (row.get("finesDescription") or {}).get("en", ""),
                "ticketDate": row.get("ticketDate") or "",
                "source": (row.get("sourceDetails") or {}).get("en", ""),
                "car": (row.get("carDetails") or {}).get("en"),
            }
        )
    return {
        "fines": fines,
        "totalAmount": sum(f["amount"] for f in fines),
        "totalBlackPoints": sum(f["blackPoints"] for f in fines),
    }
