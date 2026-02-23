# PILOT Indoor Positioning

> Full-stack indoor positioning extension for PILOT Telematics platform
> ELA Innovation / Wirepas mesh + BLE 6.0 Channel Sounding

**License:** Apache 2.0 · **Author:** TAQEEQ Systems ([pilot-gps.com](https://pilot-gps.com))  
**Target:** Indoor worker/asset tracking for construction sites in Turkmenistan & UAE

---

# English

## Project Overview

PILOT Indoor Positioning enables tracking of people and assets inside buildings with ±1 m accuracy using ELA Innovation BLE devices on Wirepas mesh with Channel Sounding support. The system consists of three layers: ELA hardware (tags/anchors/gateway), a Node.js positioning engine, and a PILOT Extension for visualization.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: HARDWARE (ELA Innovation / Wirepas mesh)               │
│  Blue PUCK tags → Blue ANCHOR → SolidSense N6 Gateway            │
│  Gateway publishes distances to MQTT                              │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 2: POSITIONING ENGINE v2.0 (Node.js / Docker)             │
│  MQTT ← WNT/ELA/generic → Trilateration → Kalman → Pilot API    │
│  Channel Sounding + RSSI fallback, adaptive update rate           │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 3: PILOT EXTENSION (Ext JS 7.7+, Leaflet)                 │
│  Floor plan overlay, tag markers, geozones, DeviceGrid           │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Extension Installation in PILOT (full frontend)

1. Host the **entire** `extension/` folder on your web server so PILOT can load it (e.g. `https://yourserver/store/indoor-positioning/`). All JS, `config.json`, and `styles.css` must be reachable at that base path.
2. In **PILOT Admin → Extensions**, register the extension with base URL:  
   `/store/indoor-positioning/` (or the full URL used above).
3. **Access control:** Assign the extension to the users or roles who should see it. Only admin-granted users will have access.
4. **Load order** (if configurable): load in this order so the app works inside PILOT:  
   `IndoorNavPanel.js` → `FloorPlanView.js` → `DeviceGrid.js` → `ZoneManager.js` → `AdminPanel.js` → `Module.js`. Then load `styles.css`. PILOT will call `initModule()` on the Module.
5. **Devices API:** The extension needs a JSON API for the device list and positions. Two options:
   - **Positioning engine (recommended):** The engine exposes **GET** `http://engine-host:3080/api/indoor/devices` (CORS enabled). Set in `extension/config.json` → `settings.devicesApiUrl` to that URL (e.g. `http://your-engine:3080/api/indoor/devices`).
   - **PILOT server:** Implement or proxy `/ax/indoor/devices.php` returning `{ "data": [ { "id", "name", "type", "zone", "battery", "lastUpdate", "status", "x", "y", "floor" }, ... ] }`. Leave `devicesApiUrl` empty to use this path.
6. See `extension/doc/INSTALL.md` for step-by-step installation, access control, and base URL override.

### 2. Standalone Demo (no PILOT required)

To prove the full stack locally without PILOT, run the engine and open the built-in standalone frontend:

```bash
cd positioning-engine
npm install
node server.js
```

Then open **http://localhost:3080/** or **http://localhost:3080/standalone/** in your browser. You'll see a map, device list, and floor plan settings. Devices appear when BLE tags send data via MQTT, or when mock data is enabled (see `positioning-engine/` config). Add your floor plan image to `positioning-engine/plans/` or use the placeholder.

### 3. Positioning Engine (Docker)

```bash
cd positioning-engine
docker-compose up -d
```

This starts Mosquitto (MQTT broker) and the positioning engine. Open **http://localhost:3080/** for the standalone demo. Configure `config.json` or environment variables before use.

### 4. Configuration

Edit `positioning-engine/config.json`:

| Section    | Key          | Description                          |
|-----------|---------------|--------------------------------------|
| mqtt      | broker        | MQTT broker URL (e.g. `mqtt://localhost:1883`) |
| mqtt      | username      | Optional broker auth                 |
| mqtt      | password      | Optional broker auth                 |
| pilot     | api_url       | PILOT server base URL                |
| pilot     | api_key       | PILOT API key for position updates   |
| api_port  | (number)      | Port for devices API (default 3080). GET `/api/indoor/devices` for the extension. |
| floors    | calibration   | 3 points: pixel → geo mapping        |
| floors    | anchors       | Anchor positions (x, y, z) per floor |

Environment variables override config: `MQTT_BROKER`, `PILOT_API_URL`, `PILOT_API_KEY`, `API_PORT`.

## Hardware (ELA Innovation)

| Component | Hardware |
|-----------|----------|
| Tags (people) | ELA Blue PUCK RHT (temp/humidity), Blue PUCK MOV (motion) |
| Tags (assets) | ELA Blue COIN ID |
| Anchors   | ELA Blue ANCHOR (fixed reference, Channel Sounding) |
| Gateway   | SolidSense N6 (Wirepas mesh gateway) |
| MQTT      | Mosquitto or any MQTT 3.1.1 broker |

---

# Русский

## Обзор проекта

PILOT Indoor Positioning позволяет отслеживать людей и активы внутри зданий с точностью ±1 м с использованием устройств ELA Innovation на Wirepas mesh с поддержкой Channel Sounding. Система состоит из трёх уровней: оборудование ELA (тэги/якоря/шлюз), Node.js движок позиционирования и PILOT Extension для визуализации.

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│  УРОВЕНЬ 1: ОБОРУДОВАНИЕ (ELA Innovation / Wirepas mesh)         │
│  Blue PUCK тэги → Blue ANCHOR якоря → SolidSense N6 шлюз         │
│  Шлюз публикует дистанции в MQTT                                  │
├─────────────────────────────────────────────────────────────────┤
│  УРОВЕНЬ 2: POSITIONING ENGINE v2.0 (Node.js / Docker)           │
│  MQTT ← WNT/ELA/generic → Трилатерация → Калман → Pilot API     │
│  Channel Sounding + RSSI fallback, адаптивный rate обновлений     │
├─────────────────────────────────────────────────────────────────┤
│  УРОВЕНЬ 3: PILOT EXTENSION (Ext JS 7.7+, Leaflet)               │
│  План этажа, маркеры тэгов, геозоны, DeviceGrid                  │
└─────────────────────────────────────────────────────────────────┘
```

## Быстрый старт

### 1. Установка расширения в PILOT

1. Разместите папку `extension/` на веб-сервере (например, `https://вашсервер/store/indoor-positioning/`).
2. В PILOT Админ → Расширения зарегистрируйте расширение с базовым URL:  
   `/store/indoor-positioning/` (или полный URL).
3. Порядок загрузки: убедитесь, что `Module.js` загружается. PILOT вызовет `initModule()`.
4. Необходимые файлы (порядок загрузки): `IndoorNavPanel.js`, `FloorPlanView.js`, `DeviceGrid.js`, `ZoneManager.js`, `AdminPanel.js`, `Module.js`, `styles.css`.

### 2. Positioning Engine (Docker)

```bash
cd positioning-engine
docker-compose up -d
```

Запускаются Mosquitto (MQTT брокер) и positioning engine. Настройте `config.json` или переменные окружения перед использованием.

### 3. Конфигурация

Редактируйте `positioning-engine/config.json`:

| Раздел     | Ключ         | Описание                               |
|-----------|---------------|----------------------------------------|
| mqtt      | broker        | URL MQTT брокера (напр. `mqtt://localhost:1883`) |
| mqtt      | username      | Опциональная авторизация               |
| mqtt      | password      | Опциональная авторизация               |
| pilot     | api_url       | Базовый URL сервера PILOT              |
| pilot     | api_key       | API ключ PILOT для обновления позиций  |
| floors    | calibration   | 3 точки: pixel → geo                   |
| floors    | anchors       | Позиции якорей (x, y, z) по этажам     |

Переменные окружения переопределяют config: `MQTT_BROKER`, `PILOT_API_URL`, `PILOT_API_KEY`.

## Оборудование (ELA Innovation)

| Компонент | Оборудование |
|-----------|--------------|
| Тэги (люди) | ELA Blue PUCK RHT (темп./влажность), Blue PUCK MOV (движение) |
| Тэги (активы) | ELA Blue COIN ID |
| Якоря     | ELA Blue ANCHOR (стационарные, Channel Sounding) |
| Шлюз      | SolidSense N6 (Wirepas mesh шлюз) |
| MQTT      | Mosquitto или любой брокер MQTT 3.1.1 |
