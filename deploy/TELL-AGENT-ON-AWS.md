# Tell the agent on AWS (copy-paste this)

---

**Copy everything below this line and send it to your agent.**

---

On the **pilot-indoor-positioning** EC2 instance (Ubuntu), run these commands so the Indoor Positioning extension is up to date and served by nginx.

**1. Go to the project and pull the latest from GitHub:**

```bash
cd /home/ubuntu
if [ ! -d pilot-indoor ]; then
  git clone https://github.com/PrimeTurkmen/pilot-indoor.git
fi
cd pilot-indoor
git fetch origin
git pull origin main
```

**2. Deploy the extension so nginx serves it (fixes 404 in PILOT):**

```bash
sudo mkdir -p /var/www/store/indoor-positioning
sudo cp -r /home/ubuntu/pilot-indoor/extension/* /var/www/store/indoor-positioning/
sudo chown -R www-data:www-data /var/www/store/indoor-positioning
```

**3. If config.json is missing, create it:**

```bash
echo '{"appName":"Indoor Positioning","version":"1.0.0","description":"Indoor people and asset tracking with BLE 6.0 Channel Sounding for PILOT Telematics","loadOrder":["IndoorNavPanel.js","FloorPlanView.js","DeviceGrid.js","ZoneManager.js","AdminPanel.js","Module.js"],"styles":"styles.css","settings":{"devicesApiUrl":"","defaultFloorPlanBounds":[[0,0],[1000,800]],"deviceRefreshInterval":5000}}' | sudo tee /var/www/store/indoor-positioning/config.json > /dev/null
sudo chown www-data:www-data /var/www/store/indoor-positioning/config.json
```

**4. Confirm nginx is serving the extension:**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost/store/indoor-positioning/Module.js
```

You should see `200`. If you see `404`, nginx is not configured for `/store/indoor-positioning/`. Then add this location to the nginx server block (e.g. in `/etc/nginx/sites-available/pilot-indoor`):

```nginx
location /store/indoor-positioning/ {
    alias /var/www/store/indoor-positioning/;
    default_type application/javascript;
    location ~ \.json$ { default_type application/json; }
    location ~ \.css$ { default_type text/css; }
    add_header Access-Control-Allow-Origin "*";
}
```

Then run: `sudo nginx -t && sudo systemctl reload nginx`

---

**After this:** In PILOT Admin → Extensions, the Indoor Positioning base URL must be set to `http://<EC2-PUBLIC-IP>/store/indoor-positioning/` (e.g. `http://13.218.85.146/store/indoor-positioning/`). Then open the extension in PILOT; it should load instead of 404.

---

**End of instructions.**
