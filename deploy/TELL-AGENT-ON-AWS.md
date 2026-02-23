# Deploy PILOT Indoor Positioning v4.0 — Clean Install

---

**Copy everything below this line and send it to your agent on AWS.**

---

## CLEAN DEPLOY — Indoor Positioning v4.0 (Velavu Cloud + Channel Sounding)

This is a **clean installation**. Remove any old indoor-positioning files first to avoid conflicts.

### Step 1: Clean up old installation

```bash
# Stop old engine if running
sudo systemctl stop pilot-indoor-engine 2>/dev/null || true
sudo docker stop pilot-indoor-engine 2>/dev/null || true
sudo docker stop pilot-indoor-mosquitto 2>/dev/null || true

# Remove old extension files
sudo rm -rf /var/www/store/indoor-positioning
sudo mkdir -p /var/www/store/indoor-positioning

# Remove old repo if exists
sudo rm -rf /home/ubuntu/pilot-indoor
```

### Step 2: Clone fresh from GitHub

```bash
cd /home/ubuntu
git clone https://github.com/PrimeTurkmen/pilot-indoor.git
cd pilot-indoor
```

### Step 3: Deploy extension files (served by nginx)

```bash
sudo cp -r /home/ubuntu/pilot-indoor/extension/* /var/www/store/indoor-positioning/
sudo chown -R www-data:www-data /var/www/store/indoor-positioning
```

Verify these files exist:
```bash
ls -la /var/www/store/indoor-positioning/
```

You should see: `Module.js`, `FloorPlanView.js`, `DeviceGrid.js`, `AssetPanel.js`, `IndoorNavPanel.js`, `ZoneManager.js`, `AdminPanel.js`, `config.json`, `styles.css`

### Step 4: Configure nginx

Check if nginx location block already exists:
```bash
grep -r "indoor-positioning" /etc/nginx/ 2>/dev/null
```

If NOT found, add this location block to your nginx server config:

```bash
sudo tee /etc/nginx/sites-available/indoor-extension > /dev/null << 'NGINX'
server {
    listen 80;
    server_name _;

    # Extension static files
    location /store/indoor-positioning/ {
        alias /var/www/store/indoor-positioning/;
        default_type application/javascript;
        location ~ \.json$ { default_type application/json; }
        location ~ \.css$ { default_type text/css; }
        add_header Cache-Control "public, max-age=60";
        add_header Access-Control-Allow-Origin "*";
    }

    # Proxy positioning engine API (Velavu + Channel Sounding)
    location /api/velavu/ {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/indoor/ {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket for real-time updates
    location /ws {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/indoor-extension /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

If you ALREADY have an nginx server block, just add the `location` blocks above into it and reload.

### Step 5: Install and start the positioning engine

```bash
cd /home/ubuntu/pilot-indoor/positioning-engine
npm install --production
```

Create a systemd service for the engine:

```bash
sudo tee /etc/systemd/system/pilot-indoor-engine.service > /dev/null << 'SERVICE'
[Unit]
Description=PILOT Indoor Positioning Engine v4.0
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/pilot-indoor/positioning-engine
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

# Velavu Cloud Engine (PRIMARY — set your token!)
Environment=VELAVU_API_TOKEN=qZIpJhSgD6PrUXILMB4LjsTh6PBPKGkiYukWO892dYU6
Environment=VELAVU_API_URL=https://api.velavu.com
Environment=VELAVU_POLL_MS=10000

# Channel Sounding Engine (secondary)
Environment=MQTT_BROKER=mqtt://localhost:1883

# Logging
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable pilot-indoor-engine
sudo systemctl start pilot-indoor-engine
```

### Step 6: Verify everything works

```bash
# Check engine is running
sudo systemctl status pilot-indoor-engine

# Check engine responds
curl -s http://localhost:3080/api/velavu/status | head -c 200

# Check nginx serves extension
curl -s -o /dev/null -w "%{http_code}" http://localhost/store/indoor-positioning/Module.js

# Check nginx proxies API
curl -s -o /dev/null -w "%{http_code}" http://localhost/api/velavu/devices

# Check engine logs
sudo journalctl -u pilot-indoor-engine -n 20 --no-pager
```

Expected results:
- Engine status: `active (running)`
- `/api/velavu/status`: JSON with `"engine":"velavu"`, `"connected":true`, device counts
- Module.js: `200`
- `/api/velavu/devices`: `200` with device array

### Step 7: Open firewall (if not already done)

In AWS EC2 → Security Groups, ensure inbound rules allow:
- Port **80** (HTTP) from `0.0.0.0/0`
- Port **443** (HTTPS) if using TLS

### Step 8: Set extension URL in PILOT Admin

In **PILOT Admin → Extensions**, set Indoor Positioning base URL to:
```
http://YOUR_EC2_PUBLIC_IP/store/indoor-positioning/
```

---

**Summary — one-shot clean deploy:**

```bash
# Clean + clone + deploy extension + install engine
sudo rm -rf /var/www/store/indoor-positioning /home/ubuntu/pilot-indoor && \
cd /home/ubuntu && \
git clone https://github.com/PrimeTurkmen/pilot-indoor.git && \
sudo mkdir -p /var/www/store/indoor-positioning && \
sudo cp -r pilot-indoor/extension/* /var/www/store/indoor-positioning/ && \
sudo chown -R www-data:www-data /var/www/store/indoor-positioning && \
cd pilot-indoor/positioning-engine && \
npm install --production && \
sudo systemctl restart pilot-indoor-engine && \
sudo nginx -t && sudo systemctl reload nginx && \
echo "✅ v4.0 deployed"
```

---

**End of instructions.**
