#!/bin/bash
# Pull Salik tolls (UAE-only) for Take Auto + push to VPS via Tailscale.
# Silent on success (cron: empty stdout = no message). set -e = non-zero exit on
# failure, which triggers the cron error alert.
set -e
cd "$(dirname "$0")"
node pull.js plates.json 30 > /tmp/salik_result.json 2>/tmp/salik_err.log
scp -o ConnectTimeout=15 /tmp/salik_result.json ceo@100.92.174.7:~/pilot-ai/salik/cache.json
