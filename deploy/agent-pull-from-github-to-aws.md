# Agent: Clean deploy v4.0 from GitHub to AWS EC2

**Repo:** https://github.com/PrimeTurkmen/pilot-indoor (branch: `main`)

Run these commands **on the EC2 instance**.

## Clean install (remove old, deploy new)

```bash
# Stop old engine
sudo systemctl stop pilot-indoor-engine 2>/dev/null || true

# Remove everything old
sudo rm -rf /var/www/store/indoor-positioning
sudo rm -rf /home/ubuntu/pilot-indoor

# Clone fresh
cd /home/ubuntu
git clone https://github.com/PrimeTurkmen/pilot-indoor.git

# Deploy extension to nginx
sudo mkdir -p /var/www/store/indoor-positioning
sudo cp -r /home/ubuntu/pilot-indoor/extension/* /var/www/store/indoor-positioning/
sudo chown -R www-data:www-data /var/www/store/indoor-positioning

# Install engine dependencies
cd /home/ubuntu/pilot-indoor/positioning-engine
npm install --production

# Restart engine + nginx
sudo systemctl restart pilot-indoor-engine
sudo nginx -t && sudo systemctl reload nginx
```

## Update only (pull latest and redeploy)

```bash
cd /home/ubuntu/pilot-indoor
git fetch origin
git reset --hard origin/main

# Redeploy extension
sudo cp -r extension/* /var/www/store/indoor-positioning/
sudo chown -R www-data:www-data /var/www/store/indoor-positioning

# Reinstall engine deps if package.json changed
cd positioning-engine && npm install --production

# Restart
sudo systemctl restart pilot-indoor-engine
sudo nginx -t && sudo systemctl reload nginx
```

## Verify

```bash
curl -s http://localhost:3080/api/velavu/status
curl -s -o /dev/null -w "%{http_code}" http://localhost/store/indoor-positioning/Module.js
curl -s -o /dev/null -w "%{http_code}" http://localhost/api/velavu/devices
```

All should return `200` with data.
