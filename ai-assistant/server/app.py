import json
import os
import re
import secrets
import smtplib
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
import httpx

from rta import decode_plate, lookup_fines
from pilot_admin import PilotAdmin

app = FastAPI(title="Pilot AI Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

KEY = os.environ.get("DEEPSEEK_" + "API_KEY", "")
BASE = os.environ.get("DEEPSEEK_" + "BASE_URL", "https://api.deepseek.com")
MODEL = os.environ.get("DEEPSEEK_" + "MODEL", "deepseek-chat")

# The AI is a TIER-1 SUPPORT AGENT embedded in Pilot: it explains, guides,
# reads the account data and proposes safe actions. Tier-2 (destructive or
# sensitive changes) is NOT done directly — it must be confirmed by the
# operator; the AI offers escalation via WhatsApp/Telegram (UI buttons).
SYSTEM = (
    "You are the AI support agent of a GPS/fleet telematics company, embedded "
    "in the Pilot tracking app as a chat. You are tier-1 support: explain how "
    "to use Pilot, read the account's data, answer questions about the fleet, "
    "fines, tolls, trips and contracts, and guide the user step by step like "
    "an experienced operator. You know Pilot deeply (vehicles, tracks, "
    "reports, geofences, drivers, fuel, commands). "
    "You answer ONLY with concrete facts and numbers taken from the JSON "
    "context the user sends. Never invent numbers; if the context lacks a "
    "requested figure, say exactly that and name what is missing. "
    "The context JSON contains: vehicles (plate, name, model, folder, "
    "odometerKm, status moving/parked/offline, periodKm, salikConnected, "
    "salikTolls), liveStatus (moving/parked/offline counts), vehicleCount, "
    "fines (plate, type, amount, date), salik (plate, date, amount, gate), "
    "contracts, and a company profile describing this client. "
    "TONE: friendly, professional, short, table-like where useful. Answer in "
    "ENGLISH by default; if the user writes in another language (e.g. "
    "Russian), answer in that language. "
    "TIERS: (1) informational questions, explanations, how-to, reading data, "
    "proposing SAFE operational actions — you handle these directly. "
    "(2) Anything that changes data or can cost money (block/unblock a car, "
    "edit vehicles, refunds, deleting records, fuel corrections) — do NOT "
    "execute or promise execution: say this needs operator confirmation and "
    "offer to escalate (the UI has WhatsApp/Telegram buttons — mention them). "
    "\n\nACTIONS: only for SAFE operational requests the user explicitly asks "
    "for (send a command, create a share link, add a fuel transaction, bind a "
    "driver), append this exact block to your answer:\n"
    "<<<ACTIONS>>>\n"
    "[{\"type\":\"send_command\",\"label\":\"...\",\"agent_id\":123,\"template_name\":\"...\",\"params\":{}}]\n"
    "<<<END_ACTIONS>>>\n"
    "Supported types and REQUIRED fields:\n"
    "- send_command: agent_id OR imei, template_name, params (object, may be {}), label\n"
    "- share_link: agent_id OR imei, max_duration (minutes, optional), label\n"
    "- add_fuel: card_num, operation, unixtimestamp, place, azs, liters, fuel, price, sum, label\n"
    "- driver_bind: agent_id OR imei, driver_id OR ibutton, label\n"
    "Rules: propose ONLY actions the user explicitly asked for. Never propose "
    "destructive commands. Use the real agent_id/imei from the context. If it "
    "is ambiguous which vehicle, ask instead of guessing. If the request is "
    "informational, omit the block entirely. The block must be the last thing "
    "in your answer, and the JSON must be one valid array."
)


ADMIN_SYSTEM = (
    "You are the Pilot admin assistant for a master/reseller account. "
    "You are logged into the admin panel and may call server-side tools by "
    "emitting this exact block at the end of your answer:\n"
    "<<<ACTIONS>>>\n"
    "[{{\"type\":\"admin_accounts\",\"query\":\"...\",\"limit\":20}}]\n"
    "<<<END_ACTIONS>>>\n"
    "Tool types:\n"
    "- admin_accounts: search the account list. Fields: query (substring of name/email/login), "
    "limit (default 20, max 100), start.\n"
    "- admin_users: list login users of one account. Field: account_id.\n"
    "- admin_travel: login AS that account (server keeps the session). "
    "Fields: account_id, optional user_id. Do this before reading the account's own data.\n"
    "- admin_proxy: READ-ONLY GET to pilot-gps.com as the traveled user. "
    "Field: path (e.g. api/v3/vehicles). Use it to answer questions about the "
    "traveled account's vehicles/positions/reports. Never POST.\n"
    "Current session: traveled={traveled}, user={username}, account={account_id}, "
    "partner={partner_id}.\n"
    "Workflow for a question about an account: admin_accounts to find it, "
    "admin_travel into it, then admin_proxy for its data, then answer. "
    "Emit ONLY tools you genuinely need; results come back to you in the next "
    "round. Answer in ENGLISH by default; mirror the user's language otherwise. "
    "Never invent numbers — quote tool results. Do not print cookies, tokens, "
    "passwords or sec_token values."
)


class Ask(BaseModel):
    question: str
    context: dict = {}
    sid: str = ""
    admin: bool = False


class RtaFinesRequest(BaseModel):
    plates: list[str]


class ReportRequest(BaseModel):
    context: dict = {}
    email: str
    subject: str = "Отчёт по автопарку Pilot"
    from_date: str = ""
    to_date: str = ""
    plates: list[str] = []
    conversation: list = []  # chat history [{who,text}] — report answers what was asked


class SendRequest(BaseModel):
    """Send an arbitrary HTML/text email (e.g. a single AI answer)."""
    email: str
    subject: str = "Pilot AI"
    html: str = ""


class EmailCodeRequest(BaseModel):
    email: str


class EmailConfirmRequest(BaseModel):
    email: str
    code: str


class TtsRequest(BaseModel):
    text: str
    voice: str = ""  # optional Fish Audio reference_id override


# Fish Audio TTS (the owner's subscription): api.fish.audio/v1/tts
FISH_KEY = os.environ.get("FISH_AUDIO_API_KEY", "")
FISH_VOICE = os.environ.get("FISH_AUDIO_VOICE", "")
FISH_MODEL = os.environ.get("FISH_AUDIO_MODEL", "fish-speech-1.5")


# One-time email confirmation codes: email -> {code, expires_ts, attempts}.
# In-memory is fine — codes expire in 10 min and a restart just forces a
# fresh request.
EMAIL_CODES: dict[str, dict] = {}
EMAIL_CODES_LOCK = threading.Lock()
EMAIL_CODE_TTL = 600  # 10 min
EMAIL_CODE_MAX_ATTEMPTS = 5


# Email (SMTP) — reports sent via the owner's taqeeq.ae mailbox, rebranded Pilot.
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.hostinger.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "noreply@taqeeq.ae")
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_FROM_NAME = os.environ.get("SMTP_FROM_NAME", "Pilot Fleet Reports")

REPORT_SYSTEM = (
    "You generate a professional support/fleet report in ENGLISH from the JSON "
    "context and the conversation the user had with the AI assistant. "
    "Output clean HTML (no markdown fences). Structure: "
    "1) Summary — total vehicles, total RTA fines (AED), total Salik (AED), "
    "moving/parked/offline counts. "
    "2) Per-vehicle table: plate (RTA), name from Pilot, agent ID, model, "
    "odometer (km), RTA fines (count + amount AED), Salik (amount AED for the "
    "period), km driven in the selected period. "
    "3) Salik trips breakdown for the period — per vehicle: date, gate, amount AED. "
    "4) Answers to every question asked in the conversation (quote the question, "
    "then the factual answer). "
    "Use only facts from the context, never invent numbers. "
    "Footer 'Generated by Pilot Fleet Reports'."
)


# RTA fines cache: plate key -> {ts, data}. Persisted to disk, refreshed daily
# (served from cache for a full day; only re-pulled when stale on refresh).
_fines_cache = {}
FINES_TTL = 86400  # 24h
RTA_CACHE_FILE = os.environ.get("RTA_CACHE", "/home/ceo/pilot-ai/server/rta_cache.json")


def _load_cache():
    global _fines_cache
    try:
        with open(RTA_CACHE_FILE, "r", encoding="utf-8") as f:
            _fines_cache = json.load(f)
    except Exception:
        _fines_cache = {}


def _save_cache():
    try:
        with open(RTA_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(_fines_cache, f)
    except Exception:
        pass


_load_cache()

# Salik cache: a JSON file pushed by the UAE-side puller (the VPS is geo-blocked
# from customers.salik.ae, so the Mac/Parrot pulls and uploads the snapshot here).
SALIK_CACHE = os.environ.get("SALIK_CACHE", "/home/ceo/pilot-ai/salik/cache.json")

# Company profiles: one MD file per client with everything the AI should know
# about the engagement (who they are, fleet, special agreements, support notes).
# The extension sends context.company = <key>; the server loads
# <dir>/<key>.md and appends it to the system prompt.
COMPANY_DIR = os.environ.get("COMPANY_PROFILES_DIR", "/home/ceo/pilot-ai/server/company_profiles")


def load_company_profile(key: str) -> str:
    key = re.sub(r"[^A-Za-z0-9_-]", "", str(key or ""))
    if not key:
        return ""
    try:
        with open(os.path.join(COMPANY_DIR, key + ".md"), "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL, "key_configured": bool(KEY)}


@app.get("/salik")
def salik():
    """Return the cached Salik toll snapshot (pushed by the UAE-side puller)."""
    try:
        with open(SALIK_CACHE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"matched": 0, "notFound": 0, "totalTolls": 0, "days": 0, "data": {}}


@app.post("/ask")
async def ask(req: Ask):
    if not KEY:
        return {"error": "AI server not configured (missing API key)."}

    user_msg = (
        "Context (JSON):\n"
        + json.dumps(req.context, ensure_ascii=False)
        + "\n\nQuestion: "
        + req.question
    )
    system = SYSTEM
    profile = ""
    if isinstance(req.context, dict):
        profile = load_company_profile(req.context.get("company") or "")
    if profile:
        system += ("\n\nABOUT THIS COMPANY (the client you are supporting):\n" + profile)
    if req.admin and req.sid:
        session = await admin_session(req.sid)
        if session.get("logged_in"):
            system = ADMIN_SYSTEM.format(
                traveled=session.get("traveled"),
                username=session.get("username") or "-",
                account_id=session.get("account_id") or "-",
                partner_id=session.get("partner_id") or "-",
            )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_msg},
    ]

    # Admin mode: the AI may emit admin tool actions; execute them server-side
    # and feed the results back (max 3 tool rounds).
    for _ in range(3):
        raw = await _ai_chat(messages, max_tokens=1200)
        if isinstance(raw, dict):
            return raw  # error dict
        answer, actions = _split_actions(raw)
        tool_actions = [a for a in actions
                        if req.admin and a.get("type", "").startswith("admin_")]
        if not tool_actions:
            return {"answer": answer, "actions": actions}
        results = []
        for a in tool_actions:
            results.append({"action": a, "result": await _exec_admin_tool(req.sid, a)})
        messages.append({"role": "assistant", "content": answer})
        messages.append({"role": "user", "content":
                         "Tool results (JSON):\n" + json.dumps(results, ensure_ascii=False)})
    # final round after tools exhausted
    raw = await _ai_chat(messages, max_tokens=1200)
    if isinstance(raw, dict):
        return raw
    answer, actions = _split_actions(raw)
    return {"answer": answer, "actions": actions}


async def _ai_chat(messages: list, max_tokens: int = 1200):
    payload = {
        "model": MODEL,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": max_tokens,
    }
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            r = await client.post(
                BASE.rstrip("/") + "/chat/completions",
                json=payload,
                headers={"Authorization": "Bearer " + KEY},
            )
            r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    except Exception as exc:  # noqa: BLE001
        return {"error": "AI error: " + str(exc)}


async def _exec_admin_tool(sid: str, action: dict) -> dict:
    """Execute one admin_* tool action server-side. Read-only + travel only."""
    t = action.get("type")
    client = _admin_session(sid)
    if client is None:
        return {"error": "no admin session"}
    try:
        if t == "admin_accounts":
            res = await client.list_accounts(
                search=str(action.get("query") or ""),
                start=int(action.get("start") or 0),
                limit=min(int(action.get("limit") or 20), 100))
            if not res["ok"]:
                return {"error": res["error"]}
            rows = [{k: v for k, v in (r or {}).items()
                     if k in ("id", "name", "login", "email", "veh_count",
                              "created", "status", "phone")} for r in res["rows"][:50]]
            return {"total": res["total"], "rows": rows}
        if t == "admin_users":
            res = await client.list_account_users(int(action.get("account_id") or 0))
            if not res["ok"]:
                return {"error": res["error"]}
            rows = [{k: v for k, v in (u or {}).items()
                     if k in ("id", "login", "name", "email", "status",
                              "roleid", "is_owner_user", "veh_count")}
                    for u in res["users"][:50]]
            return {"users": rows}
        if t == "admin_travel":
            res = await client.travel(int(action.get("account_id") or 0),
                                      int(action.get("user_id") or 0))
            if res["ok"]:
                ADMIN_SESSIONS[sid]["travel"] = {
                    "username": res["username"],
                    "account_id": action.get("account_id"),
                    "cookie": res["cookie"],
                    "url": res["url"],
                }
                return {"traveled": True, "username": res["username"],
                        "account_id": action.get("account_id")}
            return {"traveled": False, "error": res["error"]}
        if t == "admin_proxy":
            path = str(action.get("path") or "").lstrip("/")
            res = await admin_proxy(sid=sid, path=path)
            body = res.get("body")
            if isinstance(body, dict) and body.get("code") == 0:
                data = body.get("data")
                if isinstance(data, list) and len(data) > 30:
                    data = data[:30]
                return {"status": res.get("status"), "data": data}
            return res
        return {"error": f"unknown admin tool {t}"}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


_ACTIONS_RE = re.compile(r"<<<ACTIONS>>>\s*(.*?)\s*<<<END_ACTIONS>>>", re.S)


def _split_actions(raw: str):
    """Pull a trailing <<<ACTIONS>>> JSON array out of the AI answer."""
    m = _ACTIONS_RE.search(raw)
    if not m:
        return raw, []
    answer = raw[: m.start()].strip()
    try:
        actions = json.loads(m.group(1))
        if not isinstance(actions, list):
            actions = []
    except Exception:
        actions = []
    # drop non-dict entries with no type
    actions = [a for a in actions if isinstance(a, dict) and a.get("type")]
    return answer, actions


# ---------------------------------------------------------------------------
# Admin master account (adm.pilot-gps.com): login, account list, travel.
# Server keeps one JWT per sid in memory. Creds come from env
# (PILOT_ADMIN_USER / PILOT_ADMIN_PASS) or from the /admin/login body.
# ---------------------------------------------------------------------------
ADMIN_SESSIONS = {}
ADMIN_TTL = 4 * 3600
ADMIN_LOGIN_BACKOFF = 2.0  # seconds sleep on failed login attempts

PILOT_ADMIN_USER = os.environ.get("PILOT_ADMIN_USER", "")
PILOT_ADMIN_PASS = os.environ.get("PILOT_ADMIN_PASS", "")


class AdminLoginRequest(BaseModel):
    username: str = ""
    password: str = ""


class AdminSidRequest(BaseModel):
    sid: str = ""


def _admin_session(sid: str) -> PilotAdmin | None:
    entry = ADMIN_SESSIONS.get(sid)
    if not entry:
        return None
    if time.time() - entry["ts"] > ADMIN_TTL:
        ADMIN_SESSIONS.pop(sid, None)
        return None
    return entry["client"]


@app.post("/admin/login")
async def admin_login(req: AdminLoginRequest):
    username = req.username.strip() or PILOT_ADMIN_USER
    password = req.password or PILOT_ADMIN_PASS
    if not username or not password:
        return {"ok": False, "error": "no admin credentials (env or body)"}
    client = PilotAdmin(username, password)
    res = await client.login()
    if not res["ok"]:
        time.sleep(ADMIN_LOGIN_BACKOFF)
        return {"ok": False, "error": res["error"]}
    sid = secrets.token_hex(16)
    ADMIN_SESSIONS[sid] = {"client": client, "ts": time.time()}
    return {"ok": True, "sid": sid, "partner_id": res["partner_id"]}


@app.post("/admin/logout")
async def admin_logout(req: AdminSidRequest):
    if req.sid in ADMIN_SESSIONS:
        ADMIN_SESSIONS.pop(req.sid, None)
    return {"ok": True}


@app.get("/admin/accounts")
async def admin_accounts(sid: str = "", search: str = "", start: int = 0, limit: int = 100):
    client = _admin_session(sid)
    if client is None:
        return {"ok": False, "error": "no admin session (login first)"}
    limit = max(1, min(limit, 500))
    return await client.list_accounts(search=search, start=start, limit=limit)


@app.get("/admin/users")
async def admin_users(sid: str = "", account_id: int = 0):
    client = _admin_session(sid)
    if client is None:
        return {"ok": False, "error": "no admin session (login first)"}
    if not account_id:
        return {"ok": False, "error": "account_id required"}
    return await client.list_account_users(account_id)


@app.post("/admin/travel")
async def admin_travel(req: AdminTravelRequest):
    client = _admin_session(req.sid)
    if client is None:
        return {"ok": False, "error": "no admin session (login first)"}
    if not req.account_id:
        return {"ok": False, "error": "account_id required"}
    res = await client.travel(req.account_id, req.user_id)
    if res["ok"]:
        entry = ADMIN_SESSIONS[req.sid]
        entry["travel"] = {
            "username": res["username"],
            "account_id": req.account_id,
            "cookie": res["cookie"],
            "url": res["url"],
        }
    return res


@app.get("/admin/session")
async def admin_session(sid: str = ""):
    if sid not in ADMIN_SESSIONS:
        return {"logged_in": False, "traveled": False}
    entry = ADMIN_SESSIONS[sid]
    t = entry.get("travel") or {}
    return {
        "logged_in": True,
        "traveled": bool(t),
        "username": t.get("username", ""),
        "account_id": t.get("account_id", 0),
        "partner_id": entry["client"]._partner_id,
    }


@app.get("/admin/proxy")
async def admin_proxy(sid: str = "", path: str = "", params: str = ""):
    """READ-ONLY GET forward to pilot-gps.com as the traveled user.

    path is everything after the host, e.g. 'api/v3/vehicles?imei=...'.
    The travel cookie authenticates it. Only GET is allowed — no writes.
    """
    if sid not in ADMIN_SESSIONS:
        return {"ok": False, "error": "no admin session (login first)"}
    t = (ADMIN_SESSIONS[sid].get("travel") or {})
    if not t.get("cookie"):
        return {"ok": False, "error": "not traveled (travel into an account first)"}
    path = (path or "").lstrip("/")
    if not path:
        return {"ok": False, "error": "path required"}
    url = "https://pilot-gps.com/" + path
    try:
        async with httpx.AsyncClient(verify=False, timeout=25,
                                     follow_redirects=False) as c:
            r = await c.get(url, headers={"Cookie": t["cookie"]},
                            params=params or None)
        try:
            body = r.json()
        except Exception:
            body = r.text[:4000]
        return {"ok": r.status_code == 200, "status": r.status_code, "body": body}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": "proxy error: " + str(exc)}


class AdminTravelRequest(BaseModel):
    sid: str = ""
    account_id: int = 0
    user_id: int = 0


def _send_email(to: str, subject: str, html: str) -> str:
    if not SMTP_PASS:
        return "SMTP not configured (SMTP_PASS empty)"
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{SMTP_FROM_NAME} <{SMTP_USER}>"
    msg["To"] = to
    msg.attach(MIMEText(html, "html", "utf-8"))
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=30) as s:
        s.login(SMTP_USER, SMTP_PASS)
        s.sendmail(SMTP_USER, [to], msg.as_string())
    return "sent"


@app.post("/report")
async def report(req: ReportRequest):
    """Generate a detailed fleet report (DeepSeek) and email it via SMTP."""
    if not KEY:
        return {"error": "AI server not configured."}
    # server-side filters: particular cars + date range
    ctx = dict(req.context)
    plates = [p.strip() for p in (req.plates or []) if p.strip()]
    if plates:
        plateset = set(plates)
        veh = ctx.get("vehicles") or []
        veh = [v for v in veh if (v.get("plate") or v.get("plateRaw") or "") in plateset]
        ctx["vehicles"] = veh
        ctx["vehicleCount"] = len(veh)

    def in_range(d):
        if not d:
            return not (req.from_date or req.to_date)
        ds = str(d)[:10]
        if req.from_date and ds < req.from_date:
            return False
        if req.to_date and ds > req.to_date:
            return False
        return True

    if req.from_date or req.to_date:
        if ctx.get("fines"):
            ctx["fines"] = [f for f in ctx["fines"] if in_range(f.get("date") or f.get("ticketDate"))]
        if ctx.get("salik"):
            ctx["salik"] = [s for s in ctx["salik"] if in_range(s.get("date"))]

    conv_lines = []
    for item in (req.conversation or [])[-40:]:
        if isinstance(item, dict):
            who = "User" if item.get("who") == "user" else "Assistant"
            conv_lines.append(f"{who}: {item.get('text', '')}")
        else:
            conv_lines.append(str(item))
    conversation = "\n".join(conv_lines)
    user_msg = (
        "Контекст (JSON):\n"
        + json.dumps(ctx, ensure_ascii=False)
        + (("\n\nПериод: " + req.from_date + " → " + req.to_date) if req.from_date or req.to_date else "")
        + (("\n\nРазговор клиента с ассистентом (ответь на каждый вопрос):\n" + conversation)
           if conversation else "")
        + "\n\nСформируй отчёт."
    )
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": REPORT_SYSTEM},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.2,
        "max_tokens": 3000,
    }
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            r = await client.post(
                BASE.rstrip("/") + "/chat/completions",
                json=payload,
                headers={"Authorization": "Bearer " + KEY},
            )
            r.raise_for_status()
        html = r.json()["choices"][0]["message"]["content"].strip()
    except Exception as exc:  # noqa: BLE001
        return {"error": "AI error: " + str(exc)}
    status = _send_email(req.email, req.subject, html)
    return {"status": status, "email": req.email, "preview": html[:300]}


@app.post("/send")
def send_email(req: SendRequest):
    """Email arbitrary content (a single AI answer, a note) via SMTP."""
    to_list = [a.strip() for a in req.email.replace(";", ",").split(",") if a.strip()]
    if not to_list:
        return {"error": "no recipients"}
    ok, failed = [], []
    for to in to_list:
        try:
            st = _send_email(to, req.subject, req.html)
        except Exception as exc:  # noqa: BLE001
            st = "SMTP error: " + str(exc)
        (ok if st == "sent" else failed).append(to)
    return {"status": "sent" if ok else ("failed" if not ok else "partial"),
            "sent": ok, "failed": failed}


@app.post("/email/request-code")
def email_request_code(req: EmailCodeRequest):
    """Email a 6-digit confirmation code to the address (one-time verify)."""
    email = req.email.strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return {"error": "invalid email"}
    code = "%06d" % secrets.randbelow(1000000)
    with EMAIL_CODES_LOCK:
        EMAIL_CODES[email] = {
            "code": code,
            "expires_ts": time.time() + EMAIL_CODE_TTL,
            "attempts": 0,
        }
    html = (
        '<div style="font:14px/1.6 Arial,sans-serif;color:#1e293b">'
        "<p>Your Pilot confirmation code:</p>"
        '<p style="font-size:26px;letter-spacing:6px;font-weight:bold;margin:12px 0">'
        + code
        + "</p><p>Enter it in the Pilot AI Assistant to confirm this email. "
        "The code expires in 10 minutes.</p></div>"
    )
    st = _send_email(email, "Pilot — email confirmation code", html)
    if st != "sent":
        return {"status": "failed", "error": st}
    return {"status": "sent", "email": email}


@app.post("/email/confirm")
def email_confirm(req: EmailConfirmRequest):
    """Check a confirmation code. On success the address is considered verified."""
    email = req.email.strip().lower()
    with EMAIL_CODES_LOCK:
        rec = EMAIL_CODES.get(email)
        if not rec:
            return {"ok": False, "error": "no code requested for this email"}
        if time.time() > rec["expires_ts"]:
            EMAIL_CODES.pop(email, None)
            return {"ok": False, "error": "code expired — request a new one"}
        rec["attempts"] += 1
        if rec["attempts"] > EMAIL_CODE_MAX_ATTEMPTS:
            EMAIL_CODES.pop(email, None)
            return {"ok": False, "error": "too many attempts — request a new code"}
        if req.code.strip() != rec["code"]:
            return {"ok": False, "error": "wrong code"}
        EMAIL_CODES.pop(email, None)
    return {"ok": True, "email": email}


@app.post("/tts")
async def tts(req: TtsRequest):
    """Text-to-speech via Fish Audio (owner's subscription). Returns audio/mpeg."""
    if not FISH_KEY:
        return JSONResponse({"error": "TTS not configured (FISH_AUDIO_API_KEY)"}, status_code=503)
    text = (req.text or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    payload = {
        "text": text[:2000],
        "format": "mp3",
    }
    if req.voice or FISH_VOICE:
        payload["reference_id"] = req.voice or FISH_VOICE
    else:
        payload["model"] = FISH_MODEL
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                "https://api.fish.audio/v1/tts",
                json=payload,
                headers={"Authorization": "Bearer " + FISH_KEY},
            )
            if r.status_code != 200:
                return JSONResponse({"error": f"fish.audio HTTP {r.status_code}: {r.text[:200]}"},
                                    status_code=502)
            return Response(content=r.content, media_type="audio/mpeg")
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": "TTS error: " + str(exc)}, status_code=502)


@app.post("/rta-fines")
def rta_fines(req: RtaFinesRequest):
    """Look up RTA payable fines for a list of plates (cached 1h per plate)."""
    result = {}
    to_lookup = []
    for plate in req.plates:
        q = decode_plate(plate)
        if not q:
            result[plate] = {"fines": [], "totalAmount": 0, "totalBlackPoints": 0,
                             "error": "invalid plate", "plate": plate}
            continue
        cache_key = q["plateCode"] + ":" + q["plateNo"]
        cached = _fines_cache.get(cache_key)
        if cached and time.time() - cached["ts"] < FINES_TTL:
            result[plate] = dict(cached["data"])
            result[plate]["plate"] = plate
            result[plate]["cached"] = True
            continue
        to_lookup.append((plate, q, cache_key))

    def _do(item):
        plate, q, cache_key = item
        try:
            data = lookup_fines(q)
            _fines_cache[cache_key] = {"ts": time.time(), "data": data}
            out = dict(data)
            out["plate"] = plate
            return plate, out
        except Exception as exc:  # noqa: BLE001
            return plate, {"fines": [], "totalAmount": 0, "totalBlackPoints": 0,
                           "error": str(exc), "plate": plate}

    if to_lookup:
        with ThreadPoolExecutor(max_workers=6) as ex:
            for plate, out in ex.map(_do, to_lookup):
                result[plate] = out
        _save_cache()
    return result
