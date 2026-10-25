"""Pilot Admin Panel API client (adm.pilot-gps.com).

Two-step JWT login (same flow as the Kvadrat hub's pilot_live_service),
plus the master-account endpoints the AI extension needs:

  - accounts list / detail   (accounts.php?cmd=read)
  - login-as-user form auth  (accounts.php?cmd=getUsersFormAuth)

READ ONLY + travel. This module never writes to Pilot.
JWT is refreshed when older than TOKEN_MAX_AGE_S (4h).
"""

import logging
import ssl
import time

import httpx

logger = logging.getLogger("pilot_admin")

BASE_URL = "https://adm.pilot-gps.com"
LOGIN_URL = f"{BASE_URL}/backend//login.php"
ACCOUNTS_URL = f"{BASE_URL}/backend/app/accounts.php"

TOKEN_MAX_AGE_S = 4 * 3600

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


class PilotAdmin:
    def __init__(self, username: str, password: str, partner_email: str = ""):
        self.username = username
        self.password = password
        self.partner_email = partner_email or f"{username}@skyelectronics.ru"
        self._jwt = ""
        self._partner_id = 0
        self._token_time = 0.0

    # ---------------------------------------------------------------- auth

    def _token_expired(self) -> bool:
        return not self._jwt or (time.time() - self._token_time) > TOKEN_MAX_AGE_S

    async def login(self) -> dict:
        """Two-step login. Returns {"ok": bool, "partner_id": int, "error": str}."""
        try:
            headers = {
                "User-Agent": "Mozilla/5.0 (PilotAdminClient)",
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            }
            async with httpx.AsyncClient(
                verify=_ssl_ctx, timeout=15, headers=headers
            ) as client:
                # Step 1: partner id
                r1 = await client.post(LOGIN_URL, data={
                    "cmd": "get_user_without_auth",
                    "username": self.username,
                    "password": self.password,
                })
                if r1.status_code != 200:
                    return {"ok": False, "partner_id": 0,
                            "error": f"login step 1 HTTP {r1.status_code}"}
                data = r1.json()
                if isinstance(data, list):
                    data = data[0] if data else {}
                self._partner_id = int(data.get("id") or 0) if isinstance(data, dict) else 0
                if not self._partner_id:
                    return {"ok": False, "partner_id": 0,
                            "error": "no partner_id in step 1 response"}

                # Step 2: JWT
                r2 = await client.post(LOGIN_URL, data={
                    "cmd": "login",
                    "time_zone": "-240",
                    "code": "",
                    "email": self.partner_email,
                    "partner_id": str(self._partner_id),
                    "totp_code": "",
                    "username": self.username,
                    "password": self.password,
                })
                if r2.status_code != 200:
                    return {"ok": False, "partner_id": self._partner_id,
                            "error": f"login step 2 HTTP {r2.status_code}"}
                data = r2.json()
                if isinstance(data, list):
                    data = data[0] if data else {}
                jwt = (data.get("jwt_token") or "") if isinstance(data, dict) else ""
                if not jwt:
                    return {"ok": False, "partner_id": self._partner_id,
                            "error": "no jwt_token in step 2 response"}
                self._jwt = jwt
                self._token_time = time.time()
                return {"ok": True, "partner_id": self._partner_id, "error": ""}
        except Exception as e:
            logger.exception("pilot admin login failed")
            return {"ok": False, "partner_id": 0, "error": str(e)}

    async def _ensure_auth(self) -> bool:
        if self._token_expired():
            res = await self.login()
            return res["ok"]
        return True

    # ------------------------------------------------------------- accounts

    async def _accounts_request(self, params: dict) -> dict | None:
        if not await self._ensure_auth():
            return None
        try:
            async with httpx.AsyncClient(verify=_ssl_ctx, timeout=20) as client:
                r = await client.get(ACCOUNTS_URL, params={
                    **params,
                    "authorization": self._jwt,
                })
                if r.status_code == 401:
                    self._jwt = ""
                    if not await self._ensure_auth():
                        return None
                    params["authorization"] = self._jwt
                    r = await client.get(ACCOUNTS_URL, params=params)
                if r.status_code != 200:
                    logger.warning("accounts.php HTTP %d", r.status_code)
                    return None
                data = r.json()
                return data if isinstance(data, dict) else {}
        except Exception:
            logger.exception("accounts request failed")
            return None

    async def list_accounts(self, search: str = "", start: int = 0, limit: int = 100) -> dict:
        """Returns {"ok": bool, "total": int, "rows": list, "error": str}."""
        params = {"cmd": "read", "page": "1", "start": str(start),
                  "limit": str(limit), "query": search}
        data = await self._accounts_request(params)
        if data is None:
            return {"ok": False, "total": 0, "rows": [], "error": "admin API unreachable or auth failed"}
        items = data.get("data") or data.get("rows") or []
        if not isinstance(items, list):
            items = []
        total = data.get("totalCount", len(items))
        return {"ok": True, "total": total, "rows": items, "error": ""}

    async def account_detail(self, account_id: int) -> dict:
        """Returns {"ok": bool, "row": dict, "error": str}."""
        import json as _json
        flt = _json.dumps([{"property": "id", "value": str(account_id), "operator": "eq"}])
        params = {"cmd": "read", "page": "1", "start": "0", "limit": "1", "filter": flt}
        data = await self._accounts_request(params)
        if data is None:
            return {"ok": False, "row": {}, "error": "admin API unreachable or auth failed"}
        items = data.get("data") or data.get("rows") or []
        if isinstance(items, list) and items:
            return {"ok": True, "row": items[0], "error": ""}
        return {"ok": True, "row": {}, "error": "account not found"}

    async def list_account_users(self, account_id: int) -> dict:
        """Returns {"ok": bool, "users": list, "error": str}.

        cmd=getUsers returns the account's login users (the usernames the
        admin panel uses for the travel form).
        """
        data = await self._accounts_request({"cmd": "getUsers",
                                             "account_id": str(account_id)})
        if data is None:
            return {"ok": False, "users": [], "error": "admin API unreachable or auth failed"}
        items = data.get("data") or data.get("rows") or []
        if not isinstance(items, list):
            items = []
        return {"ok": True, "users": items, "error": ""}

    async def travel(self, account_id: int, user_id: int = 0) -> dict:
        """Server-side login-as-user (the admin panel's own travel flow).

        1. cmd=getUsersFormAuth (with host/protocol) -> {url, role, id, token, sec_token}
        2. cmd=getUsers -> pick the user (their `login` is the username)
        3. POST url: username/role/id/token/sec_token -> Set-Cookie PILOTID=...

        Returns {"ok", "username", "account_id", "url", "cookie", "error"}.
        `cookie` is the PILOTID session cookie that authenticates
        pilot-gps.com (backend UI AND /api/v3/*) as that user.
        """
        fa = await self._accounts_request({
            "cmd": "getUsersFormAuth", "account_id": str(account_id),
            "host": "adm.pilot-gps.com", "protocol": "https:"})
        if fa is None:
            return {"ok": False, "error": "admin API unreachable or auth failed"}
        users = await self.list_account_users(account_id)
        if not users["ok"] or not users["users"]:
            return {"ok": False, "error": "no users for account (getUsers empty)"}
        row = users["users"][0]
        if user_id:
            row = next((u for u in users["users"] if str(u.get("id")) == str(user_id)), row)
        username = row.get("login") or row.get("email") or ""
        url = fa.get("url", "")
        token = fa.get("token", "")
        sec_token = fa.get("sec_token", "")
        role = fa.get("role", "partner")
        fid = fa.get("id", fa.get("partner", ""))
        if not url or not token or not username:
            return {"ok": False, "error": "no travel form auth in response"}
        try:
            async with httpx.AsyncClient(verify=_ssl_ctx, timeout=20,
                                         follow_redirects=False) as client:
                r = await client.post(url, data={
                    "username": username, "role": role,
                    "id": str(fid), "token": token, "sec_token": sec_token})
                if r.status_code not in (200, 302):
                    return {"ok": False, "error": f"travel POST HTTP {r.status_code}"}
                cookie = r.headers.get("set-cookie", "")
                cookie = cookie.split(";")[0] if cookie else ""
                if not cookie:
                    return {"ok": False, "error": "no session cookie in travel response"}
                return {"ok": True, "username": username, "account_id": account_id,
                        "url": url, "cookie": cookie, "error": "",
                        "form": {"url": url, "username": username, "role": role,
                                 "id": str(fid), "token": token,
                                 "sec_token": sec_token}}
        except Exception as e:
            logger.exception("travel failed")
            return {"ok": False, "error": str(e)}
