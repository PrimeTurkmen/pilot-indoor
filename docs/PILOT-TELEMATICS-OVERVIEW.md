# Pilot Fleet Intelligence — Extensions Overview

A set of **three store extensions** for the Pilot GPS platform that give car-rental
and fleet operators three capabilities inside the Pilot web app:

| Extension | What it adds |
|---|---|
| **RTA Salik** | A tab panel with **RTA traffic fines** and **Salik tolls** for the account's fleet. |
| **AI Assistant** | A chat window (plus **"Email report"**) that answers natural-language questions about the fleet and sends a formatted HTML report by email. |

---

## 1. RTA traffic fines

- **Anonymous, no-login lookup** of UAE traffic fines by plate number, through the
  RTA public fines gateway.
- Shows per-vehicle: fine reference, description, date, amount (AED), black points,
  and issuing authority (Dubai Police, RTA, Salik, Sharjah, Abu Dhabi, …).
- Fines are **cached for a day** on the backend and refreshed automatically — no
  manual re-pull.

## 2. Salik tolls

- Reads the account's **Salik toll transactions** (date, gate, amount) from the
  Salik customer portal.
- Shows a **per-vehicle toll summary** (trips + total AED over the period) and a
  trip breakdown.
- Each Salik account is connected per client (the client provides their own
  Salik login; the puller uses only their credentials).

## 3. AI fleet reporter

- Operators ask questions in plain language — *"how many vehicles?", "who exceeded
  4500 km this month?", "who has unpaid fines?"* — and get a concise, factual answer.
- **Strictly read-only**: it only reports the numbers from the fleet data it is
  given. It cannot change anything and has no admin access.
- **"Email report"** generates a full HTML fleet report (summary + per-vehicle
  table with fines, tolls, mileage, and limit status) and sends it to any email.

---

## How it works (at a glance)

- The extensions run **inside the operator's own Pilot session**, so they only ever
  see the fleet data the operator is already allowed to see (their account).
- No Pilot credentials leave the browser; the AI backend only receives a JSON
  snapshot of the fleet and reasons over that.

## Activation

- The extensions are **registered and published** in the Pilot store.
- They are turned on **per account / per user** by the reseller (TSC). Once enabled,
  the tab / button appears for that account's users.

## Data handled

- Fleet plates, models, mileage, rental contracts.
- RTA traffic fines and Salik tolls.
- Everything is read-only and account-scoped — the extensions never write to or
  modify any Pilot data.

---

*Backend is served over HTTPS (Cloudflare) and email reports are sent from a
dedicated noreply mailbox, branded "Pilot Fleet Reports".*
