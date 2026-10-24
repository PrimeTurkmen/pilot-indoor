// Adapted from the owner's TAKE-AUTO/scripts/salik-trips.cjs.
// Salik customer-portal connector (CommonJS, zero deps — node fetch only).
// Logs in with a regular customer account at customers.salik.ae and reads the
// portal's own JSON "surface" endpoints: vehicle list, toll trips, parking
// transactions. Used by scripts/update-fines-tab.mjs to attribute Salik/parking
// charges to the client currently renting each car.
// See docs/rta-fines-connector.md for the fines side; Salik notes live in
// docs/salik-connector.md.
//
// Login flow (all plain HTTPS, no browser needed):
//   1. GET customers.salik.ae/          -> redirects to id.salik.ae login (fresh request id)
//   2. POST UserName/Password           -> 302 to /core/connect/authorize (idsvr cookie)
//   3. GET authorize URL                -> HTML form_post with id_token/access_token
//   4. POST form to /Connect/SalikIdCallback -> sets .ASPXAUTH on customers.salik.ae
// www.salik.ae is Cloudflare-fenced; customers.salik.ae surface endpoints are not.
//
// Key endpoint facts (verified 2026-08-13):
//   trips:        GET /surface/portal/trips?timePeriod=4&startDate=DD-MM-YYYY&endDate=DD-MM-YYYY
//                 &tagPlateDetails=3&plateNumber=<digits>&plateCode=<PlateColorId>&plateSource=1&plateCategory=1
//                 pageSize is hard-capped at 10 -> paginate by TotalCount.
//                 PlateColorId comes from the vehicles endpoint (letters don't work).
//   parkingtrips: same but pageSize=100 works; returns PlateColor as a LETTER.
//   vehicles:     GET /surface/search/vehicles?pageSize=100&searchType=1 -> PlateNumber,
//                 PlateColor (letter), PlateColorId (numeric, needed by trips).

"use strict";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15000;

// ── minimal cookie jar, keyed by hostname ───────────────────────────────────
function makeJar() {
  const store = new Map(); // host -> Map(name -> value)
  const hostOf = (url) => new URL(url).hostname;
  return {
    absorb(url, res) {
      const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      if (!cookies.length) return;
      const host = hostOf(url);
      if (!store.has(host)) store.set(host, new Map());
      const jar = store.get(host);
      for (const c of cookies) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        // The portal sets EMPTY placeholder cookies (.ASPXAUTH=, …) before
        // login; replaying them against the callback makes ASP.NET throw a
        // 500. Treat empty values as deletions — curl does the same.
        if (value === "") jar.delete(name);
        else jar.set(name, value);
      }
    },
    header(url) {
      const jar = store.get(hostOf(url));
      if (!jar) return "";
      return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

async function req(jar, url, init = {}) {
  const res = await fetch(url, {
    redirect: "manual",
    ...init,
    signal: jar.signal ? AbortSignal.any([jar.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": UA, Cookie: jar.header(url), ...(init.headers || {}) },
  });
  jar.absorb(url, res);
  return res;
}

// ── login → jar authorized on customers.salik.ae ────────────────────────────
async function login(user, pass) {
  const jar = makeJar();
  jar.signal = AbortSignal.timeout(90000);
  // 1. bounce off the portal root to get a fresh login request id; the portal
  //    may hop through /Connect/Login before landing on id.salik.ae
  let res = await req(jar, "https://customers.salik.ae/");
  let loginUrl = "";
  for (let hop = 0; hop < 8; hop++) {
    let loc = res.headers.get("location") || "";
    if (!loc) break; // final 200 page
    if (loc.startsWith("/")) loc = new URL(res.url).origin + loc;
    res = await req(jar, loc);
    if (res.url.includes("id.salik.ae") && res.status === 200) {
      loginUrl = res.url;
      break;
    }
  }
  if (!loginUrl) throw new Error("salik: never reached id.salik.ae login");

  // 2. credentials
  res = await req(jar, loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ UserName: user, Password: pass }).toString(),
  });
  const authLoc = res.headers.get("location") || "";
  if (res.status !== 302 || !authLoc.includes("authorize")) {
    throw new Error(`salik: login rejected for ${user} (HTTP ${res.status})`);
  }

  // 3. authorize -> form_post HTML with hidden tokens
  res = await req(jar, authLoc.startsWith("http") ? authLoc : "https://id.salik.ae" + authLoc);
  const html = await res.text();
  const fields = [...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  if (!fields.length) throw new Error("salik: authorize page had no token form");

  // 4. post tokens back -> .ASPXAUTH cookie on customers.salik.ae
  res = await req(jar, "https://customers.salik.ae/Connect/SalikIdCallback", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  if (!jar.header("https://customers.salik.ae/").includes(".ASPXAUTH")) {
    throw new Error("salik: no .ASPXAUTH after callback");
  }
  return jar;
}

async function getJson(jar, path, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await req(jar, "https://customers.salik.ae" + path);
      if (!res.ok) throw new Error(`salik ${path} -> HTTP ${res.status}`);
      const text = await res.text();
      // The portal answers with an EMPTY body for zero-result sets and for
      // windows it considers too large — retry in case it's transient.
      if (!text.trim()) throw new Error(`salik ${path} -> empty response`);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
  throw lastErr;
}

// ── vehicles: plateNumber -> {color, colorId} ───────────────────────────────
async function getVehicles(jar) {
  const out = new Map();
  for (let page = 1; page <= 50; page++) {
    const d = await getJson(jar, `/surface/search/vehicles?pageId=${page}&pageSize=100&searchType=1&lang=en&tagIndicator=false`);
    if (!Array.isArray(d.Result?.Vehicles)) throw new Error("Unrecognized Salik vehicle response");
    for (const v of d.Result.Vehicles) out.set(`${String(v.PlateNumber).trim()}:${String(v.PlateColor).trim().toUpperCase()}`, { color: v.PlateColor, colorId: v.PlateColorId });
    if (d.Result.Vehicles.length < 100 || out.size >= (d.Result.TotalCount ?? Infinity)) return out;
  }
  throw new Error("Salik vehicle list exceeded page limit");
}

// "8/13/2026 1:21:03 PM" (Dubai local) -> Date
function parseTripDate(s) {
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (/pm/i.test(m[7])) h += 12;
  return new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h - 4, Number(m[5]), Number(m[6])));
}

const ddmmyyyy = (d) =>
  `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;

// ── toll trips for ONE plate within [from, to] ──────────────────────────────
async function getTollTrips(jar, { plateNumber, colorId, from, to }) {
  const base =
    `/surface/portal/trips?tripType=1&tagPlateDetails=3&plateNumber=${encodeURIComponent(plateNumber)}` +
    `&plateCode=${colorId}&plateSource=1&plateCategory=1&timePeriod=4` +
    `&startDate=${ddmmyyyy(from)}&endDate=${ddmmyyyy(to)}&lang=en`;
  const first = await getJson(jar, `${base}&pageId=1&pageSize=10`);
  if (!first.Result || !Array.isArray(first.Result.Trips)) throw new Error("Unrecognized Salik trips response");
  const result = first.Result;
  const total = result.TotalCount || 0;
  const trips = [...(result.Trips || [])];
  for (let page = 2; trips.length < total; page++) {
    const d = await getJson(jar, `${base}&pageId=${page}&pageSize=10`);
    const next = d.Result?.Trips;
    if (page > 100 || !Array.isArray(next) || !next.length) throw new Error("Salik toll pagination incomplete");
    trips.push(...next);
  }
  return trips.map((t) => ({
    date: parseTripDate(t.TripDateTime),
    amount: parseFloat(t.Amount) || 0,
    gate: `${t.TollGateLocation} (${t.TollGateDirection})`,
  }));
}

// ── ALL parking transactions within [from, to] (bucket by plate locally) ────
// Queried in ≤30-day chunks because the portal returns an empty body for very
// large windows. A failed chunk is surfaced so partial toll history is never
// presented as complete.
async function getParkingTrips(jar, { from, to }) {
  const CHUNK = 30 * 86400000;
  const out = [];
  for (let start = new Date(from); start <= to; start = new Date(start.getTime() + CHUNK)) {
    const end = new Date(Math.min(start.getTime() + CHUNK - 86400000, to.getTime()));
    try {
      const base =
        `/surface/portal/parkingtrips?timePeriod=4&tagPlateDetails=1` +
        `&startDate=${ddmmyyyy(start)}&endDate=${ddmmyyyy(end)}&lang=en`;
      const first = await getJson(jar, `${base}&pageId=1&pageSize=100`);
      if (!first.Result || !Array.isArray(first.Result.ParkingTrips)) throw new Error("Unrecognized Salik parking response");
      const result = first.Result;
      const total = result.TotalCount || 0;
      const trips = [...(result.ParkingTrips || [])];
      for (let page = 2; trips.length < total; page++) {
        const d = await getJson(jar, `${base}&pageId=${page}&pageSize=100`);
        const next = d.Result?.ParkingTrips;
        if (page > 100 || !Array.isArray(next) || !next.length) throw new Error("Salik parking pagination incomplete");
        trips.push(...next);
      }
      out.push(...trips);
    } catch (e) {
      throw new Error(`Salik parking query failed for ${ddmmyyyy(start)}`);
    }
  }
  return out.map((t) => ({
    plateNumber: String(t.PlateNumber).trim(),
    plateColor: t.PlateColor,
    date: parseTripDate(t.PartnerTransactionDateTime),
    amount: Number(t.CollectedAmount) || 0,
    location: t.Location,
  }));
}

module.exports = { login, getVehicles, getTollTrips, getParkingTrips };
