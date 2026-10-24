// salik-server.js — Node HTTP sidecar exposing Salik tolls (zero deps).
// Requires ./salik.cjs (the connector). Login session cached ~20 min.
// Credentials come from env SALIK_USER / SALIK_PASS (default Take Auto).
"use strict";
const http = require("http");
const salik = require("./salik.cjs");

const USER = process.env.SALIK_USER || "Takeauto";
const PASS = process.env.SALIK_PASS || "Dubai2022@";
const PORT = Number(process.env.SALIK_PORT || 8791);

let cachedJar = null;
let cachedAt = 0;
const SESSION_TTL = 20 * 60 * 1000;

async function getSession() {
  if (cachedJar && Date.now() - cachedAt < SESSION_TTL) return cachedJar;
  cachedJar = await salik.login(USER, PASS);
  cachedAt = Date.now();
  return cachedJar;
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && req.url === "/health") { json(res, 200, { ok: true, user: USER }); return; }

  if (req.method === "POST" && req.url === "/salik") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { plates, days } = JSON.parse(body || "{}");
        const d = Number(days) || 30;
        const from = new Date(Date.now() - d * 86400000);
        const to = new Date();
        const jar = await getSession();
        const vehicles = await salik.getVehicles(jar); // Map "num:COLOR" -> {color,colorId}
        const out = {};
        for (const p of plates || []) {
          const num = String(p.number || "").trim();
          const code = String(p.code || "").trim().toUpperCase();
          let v = vehicles.get(`${num}:${code}`);
          if (!v) {
            // fallback: any vehicle with this plate number
            for (const [k, val] of vehicles.entries()) {
              if (k.split(":")[0] === num) { v = val; break; }
            }
          }
          const key = code ? `${code} ${num}` : num;
          if (!v) { out[key] = { tolls: [], totalTolls: 0, error: "not in salik account" }; continue; }
          const tolls = await salik.getTollTrips(jar, { plateNumber: num, colorId: v.colorId, from, to });
          const totalTolls = tolls.reduce((s, t) => s + (t.amount || 0), 0);
          out[key] = { tolls, totalTolls, tripCount: tolls.length };
        }
        json(res, 200, out);
      } catch (e) {
        json(res, 500, { error: String((e && e.message) || e) });
      }
    });
    return;
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`salik server on 127.0.0.1:${PORT}`));
