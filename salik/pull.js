// pull.js — pull Salik tolls for MULTIPLE accounts → merged JSON (stdout).
// Usage: node pull.js [days]
"use strict";
const s = require("./salik.cjs");
const fs = require("fs");

const ACCOUNTS = [
  { name: "Takeauto", user: process.env.TAKE_USER || "Takeauto", pass: process.env.TAKE_PASS || "Dubai2022@", platesFile: "takeauto_plates.json" },
  { name: "KVADRAT", user: process.env.KVADRAT_USER || "KVADRAT", pass: process.env.KVADRAT_PASS || "Ghoroob32A409n", platesFile: "mihail_plates.json" },
];

const days = Number(process.argv[2] || 30);

function extractNumber(raw) {
  const d = String(raw).toUpperCase().match(/\d{1,5}/g);
  if (!d || !d.length) return null;
  return d.slice().sort((a, b) => b.length - a.length)[0];
}

async function pullAccount(acc) {
  const plates = JSON.parse(fs.readFileSync(acc.platesFile, "utf8"));
  const jar = await s.login(acc.user, acc.pass);
  const vehicles = await s.getVehicles(jar); // "num:COLOR" -> {color,colorId}
  const byNumber = new Map();
  for (const [k, val] of vehicles) {
    const num = k.split(":")[0];
    if (!byNumber.has(num)) byNumber.set(num, { key: k, ...val });
  }
  const from = new Date(Date.now() - days * 86400000);
  const to = new Date();
  const out = {};
  let matched = 0, notFound = 0, totalTolls = 0;
  for (const raw of plates) {
    const number = extractNumber(raw);
    if (!number) { out[raw] = { error: "no number" }; continue; }
    const entry = byNumber.get(number);
    if (!entry) { out[raw] = { error: "not in salik" }; notFound++; continue; }
    matched++;
    const tolls = await s.getTollTrips(jar, { plateNumber: number, colorId: entry.colorId, from, to });
    const total = tolls.reduce((x, t) => x + (t.amount || 0), 0);
    totalTolls += total;
    out[raw] = { salikPlate: entry.key, tripCount: tolls.length, totalTolls: Math.round(total * 100) / 100, tolls };
  }
  return { matched, notFound, totalTolls: Math.round(totalTolls * 100) / 100, data: out };
}

(async () => {
  const all = { matched: 0, notFound: 0, totalTolls: 0, days, data: {} };
  for (const acc of ACCOUNTS) {
    try {
      const r = await pullAccount(acc);
      all.matched += r.matched;
      all.notFound += r.notFound;
      all.totalTolls += r.totalTolls;
      Object.assign(all.data, r.data);
      console.error(`[${acc.name}] matched=${r.matched} notFound=${r.notFound} tolls=${r.totalTolls.toFixed(1)}`);
    } catch (e) {
      console.error(`[${acc.name}] ERROR: ${e.message}`);
    }
  }
  all.totalTolls = Math.round(all.totalTolls * 100) / 100;
  console.log(JSON.stringify(all));
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
