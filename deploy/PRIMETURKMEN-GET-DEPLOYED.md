# How PrimeTurkmen gets what was deployed

The latest code is on **GitHub**: https://github.com/PrimeTurkmen/pilot-indoor (branch `main`).

## On the AWS EC2 instance (pilot-indoor-positioning)

**If the repo is already cloned** (e.g. at `/home/ubuntu/pilot-indoor`):

```bash
cd /home/ubuntu/pilot-indoor
git fetch origin
git pull origin main
sudo cp -r extension/* /var/www/store/indoor-positioning/
sudo chown -R www-data:www-data /var/www/store/indoor-positioning
```

**If the repo is not there yet:**

```bash
cd /home/ubuntu
git clone https://github.com/PrimeTurkmen/pilot-indoor.git
sudo mkdir -p /var/www/store/indoor-positioning
sudo cp -r pilot-indoor/extension/* /var/www/store/indoor-positioning/
sudo chown -R www-data:www-data /var/www/store/indoor-positioning
```

After that, the extension served by nginx at `http://<EC2-IP>/store/indoor-positioning/` is the same as what’s on GitHub.

## One-liner for an agent

```bash
cd /home/ubuntu/pilot-indoor && git pull origin main && sudo cp -r extension/* /var/www/store/indoor-positioning/ && sudo chown -R www-data:www-data /var/www/store/indoor-positioning
```

(If the repo doesn’t exist: clone first, then run the copy/chown lines.)
