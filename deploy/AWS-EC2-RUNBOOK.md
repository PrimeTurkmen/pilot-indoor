# Deploy Indoor Positioning extension on AWS EC2 (fix 404)

Use this on your **pilot-indoor-positioning** EC2 instance (Ubuntu). Replace `YOUR_PUBLIC_IP_OR_DNS` with your instance’s public IP or DNS (e.g. `13.218.85.146` or `ec2-13-218-85-146.compute-1.amazonaws.com`).

## 1. SSH into the instance

Use EC2 Instance Connect or:

```bash
ssh -i your-key.pem ubuntu@YOUR_PUBLIC_IP_OR_DNS
```

## 2. Install nginx (if not already)

```bash
sudo apt-get update
sudo apt-get install -y nginx
```

## 3. Put the extension files on the server

**Option A — Clone the repo (if the repo is public or you have SSH key on the instance):**

```bash
sudo mkdir -p /var/www/store
sudo chown ubuntu:ubuntu /var/www/store
cd /var/www/store
git clone https://github.com/YOUR_ORG/pilot-indoor.git
sudo mv pilot-indoor/extension indoor-positioning
# Remove repo if you only need the extension
sudo rm -rf pilot-indoor
```

**Option B — Copy from your machine (run from your Mac/laptop):**

```bash
# On your laptop (from the pilot-indoor repo root):
scp -i your-key.pem -r extension ubuntu@YOUR_PUBLIC_IP_OR_DNS:/tmp/
# Then on the EC2 instance:
sudo mkdir -p /var/www/store/indoor-positioning
sudo cp -r /tmp/extension/* /var/www/store/indoor-positioning/
sudo chown -R www-data:www-data /var/www/store/indoor-positioning
```

**Option C — Manual:** Zip the `extension/` folder on your machine, upload to the instance (e.g. S3 or scp), then unzip into `/var/www/store/indoor-positioning/`.

Ensure these exist on the server:

- `/var/www/store/indoor-positioning/Module.js`
- `/var/www/store/indoor-positioning/config.json`
- `/var/www/store/indoor-positioning/IndoorNavPanel.js`
- `/var/www/store/indoor-positioning/FloorPlanView.js`
- `/var/www/store/indoor-positioning/DeviceGrid.js`
- `/var/www/store/indoor-positioning/ZoneManager.js`
- `/var/www/store/indoor-positioning/AdminPanel.js`
- `/var/www/store/indoor-positioning/styles.css`

## 4. Configure nginx to serve the extension

Create a snippet (or add to your existing server block):

```bash
sudo nano /etc/nginx/sites-available/indoor-extension
```

Paste this (adjust `server_name` if you use a domain):

```nginx
server {
    listen 80;
    server_name _;   # or your domain, e.g. pilot-indoor.example.com

    location /store/indoor-positioning/ {
        alias /var/www/store/indoor-positioning/;
        default_type application/javascript;
        location ~ \.json$ {
            default_type application/json;
        }
        location ~ \.css$ {
            default_type text/css;
        }
        add_header Cache-Control "public, max-age=300";
        add_header Access-Control-Allow-Origin "*";
    }
}
```

Enable and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/indoor-extension /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

If you already have a default server on port 80, add only the `location /store/indoor-positioning/ { ... }` block inside that server and reload.

## 5. Open firewall (security group)

In AWS EC2 → Security groups for this instance, ensure:

- **Inbound:** Port **80** (HTTP) and/or **443** (HTTPS) from `0.0.0.0/0` (or your PILOT server IP) so PILOT can load the extension.

## 6. Set the extension URL in PILOT Admin

In **PILOT Admin → Extensions**, set the Indoor Positioning extension base URL to:

- **http://YOUR_PUBLIC_IP_OR_DNS/store/indoor-positioning/**  
  or  
- **http://ec2-13-218-85-146.compute-1.amazonaws.com/store/indoor-positioning/**

(Use **https** if you put a TLS termination in front of this instance.)

## 7. Verify

In a browser open:

- `http://YOUR_PUBLIC_IP_OR_DNS/store/indoor-positioning/Module.js`

You should see JavaScript content, not 404. Then reload the PILOT Extensions panel; the 404 for Indoor Positioning should be gone.
