# Agent: Pull from GitHub and deploy to AWS EC2

**Repo:** https://github.com/PrimeTurkmen/pilot-indoor (branch: `main`)

Run these commands **on the EC2 instance** (e.g. via SSH or your MCP/agent that has shell access to the instance).

## One-time: clone repo (if not already there)

```bash
cd /home/ubuntu
if [ ! -d pilot-indoor ]; then
  git clone https://github.com/PrimeTurkmen/pilot-indoor.git
fi
```

## Every time: pull latest and deploy extension

```bash
cd /home/ubuntu/pilot-indoor
git fetch origin
git pull origin main

sudo cp -r extension/* /var/www/store/indoor-positioning/
sudo chown -R www-data:www-data /var/www/store/indoor-positioning
```

## Optional: ensure config.json exists

If the server copy is missing `config.json`:

```bash
echo '{"appName":"Indoor Positioning","version":"1.0.0","description":"Indoor people and asset tracking with BLE 6.0 Channel Sounding for PILOT Telematics","loadOrder":["IndoorNavPanel.js","FloorPlanView.js","DeviceGrid.js","ZoneManager.js","AdminPanel.js","Module.js"],"styles":"styles.css","settings":{"devicesApiUrl":"","defaultFloorPlanBounds":[[0,0],[1000,800]],"deviceRefreshInterval":5000}}' | sudo tee /var/www/store/indoor-positioning/config.json > /dev/null
sudo chown www-data:www-data /var/www/store/indoor-positioning/config.json
```

## Optional: reload nginx (only if you changed nginx config)

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

**Summary for the agent:** On the EC2 instance, run:

```bash
cd /home/ubuntu/pilot-indoor && git fetch origin && git reset --hard origin/main && sudo cp -r extension/* /var/www/store/indoor-positioning/ && sudo chown -R www-data:www-data /var/www/store/indoor-positioning
```

(`reset --hard` keeps the server in sync with GitHub even if there are local changes.)
