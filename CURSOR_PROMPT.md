# ЗАДАЧА

Создай PILOT Extension модуль "Indoor Positioning" для платформы PILOT Telematics.
Модуль позволяет отслеживать людей и активы внутри зданий с точностью ±1м
используя Bluetooth 6.0 Channel Sounding на чипах nRF54L15.

# КОНТЕКСТ

Я — владелец GPS tracking компании TAQEEQ Systems (pilot-gps.com).
- Платформа: PILOT Telematics (Ext JS 7.7+, Leaflet карты)
- SDK расширений: github.com/pilot-telematics/pilot_extensions (Apache 2.0)
- API: Pilot API V3 (Swagger: pilot-swagger.pilot-gps.com)
- Позиционирование: BLE 6.0 Channel Sounding (nRF54L15, nRF Connect SDK v3.0.1)
- Якоря: MOKOSMART L03 (nRF54L15, 10+ лет батарея)
- Positioning Engine: свой (Node.js)

# АРХИТЕКТУРА

## Поток данных:
1. nRF54L15 тэги (Reflector) на людях/активах
2. nRF54L15 якоря (Initiator) на стенах/потолке — измеряют distance
3. nRF54L15 шлюз → собирает distances → MQTT
4. Positioning Engine (Docker/Node.js) → MQTT subscribe → trilateration → X,Y,Z
5. Positioning Engine → Pilot API V3 → обновляет координаты устройств
6. PILOT Extension → читает координаты → отображает на плане этажа

## Файлы референса (уже в контексте):
- pilot_extensions/AI_SPECS.md — полная спецификация Pilot Extensions
- pilot_extensions/examples/template-app/ — шаблон модуля
- pilot_extensions/examples/airports/ — пример с Leaflet картой и маркерами

# ТРЕБОВАНИЯ К EXTENSION МОДУЛЮ

## Module.js (точка входа):
- Ext.define('Store.indoor-positioning.Module')
- initModule() добавляет:
  - Таб в skeleton.navigation — список зданий/этажей/зон
  - Панель в skeleton.mapframe — Leaflet карта с планом этажа overlay
  - Кнопку в skeleton.header — быстрый доступ

## Основные компоненты:

### 1. IndoorNavPanel (навигация, левая панель)
- Древовидный список: Здания → Этажи → Зоны
- Список тэгов/людей с поиском
- Статус каждого тэга (online/offline, батарея, последняя позиция)
- Фильтры по типу (люди, активы, транспорт)

### 2. FloorPlanView (основная панель с картой)
- Leaflet карта (из Pilot MapContainer API)
- План этажа как imageOverlay (PNG/SVG загружаемый администратором)
- Маркеры тэгов обновляются в реальном времени (polling или WebSocket)
- Траектория перемещения (polyline за выбранный период)
- Геозоны на плане (polygon) с алертами входа/выхода
- Heatmap присутствия (опционально)
- Переключение между этажами
- Координатная сетка для ориентации

### 3. DeviceGrid (таблица устройств)
- Ext.grid.Panel со списком всех indoor устройств
- Колонки: Имя, Тип, Зона, Батарея, Последнее обновление, Статус
- Клик по строке → центрирует карту на устройстве
- Экспорт в CSV

### 4. ZoneManager (управление зонами)
- CRUD для зон на плане этажа
- Рисование полигонов на Leaflet карте
- Правила алертов: "Тэг вошёл/вышел из зоны"
- Привязка зон к этажам

### 5. AdminPanel (настройки)
- Загрузка планов этажей (PNG/SVG)
- Калибровка: привязка плана к координатам (3 точки)
- Управление якорями: позиции на плане
- Настройки подключения к Positioning Engine (MQTT broker URL)

# ТРЕБОВАНИЯ К POSITIONING ENGINE

## server.js (Node.js):
- MQTT клиент: подписка на топик distances от шлюзов
- Формат входных данных:
  ```json
  {
    "tag_id": "AA:BB:CC:DD:EE:FF",
    "measurements": [
      {"anchor_id": "anchor_01", "distance_m": 3.45, "rssi": -65},
      {"anchor_id": "anchor_02", "distance_m": 5.12, "rssi": -72},
      {"anchor_id": "anchor_03", "distance_m": 2.89, "rssi": -58}
    ],
    "timestamp": 1707830400
  }
  ```

## trilateration.js:
- Weighted trilateration из 3+ distances
- Kalman filter для сглаживания
- Floor detection (по Z координате или по anchor group)

## pilot-bridge.js:
- Конвертация X,Y → lat,lon (на основе калибровки плана)
- POST в Pilot API V3 для обновления позиции устройства
- Или эмуляция Wialon IPS протокола (TCP)

## Dockerfile:
- Node.js 20 Alpine
- MQTT (mosquitto) клиент
- Переменные окружения: MQTT_BROKER, PILOT_API_URL, PILOT_API_KEY

# СТИЛЬ КОДА

- JavaScript ES6+ для Extension
- Node.js для Positioning Engine
- Ext JS 7.7 для UI компонентов
- Leaflet для карт
- Комментарии на английском
- README на русском и английском

# ПОРЯДОК РАБОТЫ

1. СНАЧАЛА прочитай AI_SPECS.md и template-app из pilot_extensions
2. Создай Module.js по шаблону template-app
3. Создай FloorPlanView с Leaflet и overlay
4. Создай IndoorNavPanel с деревом зданий
5. Создай DeviceGrid
6. Создай positioning-engine/server.js
7. Создай Dockerfile
8. Создай README.md

Начни с Module.js и FloorPlanView — это ядро.
