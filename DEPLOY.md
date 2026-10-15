# Deploy Robo Views on a VPS (24/7, PC can be off)

A VPS outside your home network can reach Telegram, so **auto-discover works** and drips keep running with your PC closed.

---

## 1. Get a VPS

Any small Linux server is fine (Ubuntu 22.04/24.04 recommended):

| Provider examples | Notes |
|-------------------|--------|
| Hetzner, DigitalOcean, Linode | Easy panels |
| Contabo, Vultr | Cheap plans |
| Oracle Cloud free tier | Free ARM VM if you can sign up |

**Minimum:** 1 GB RAM, 1 vCPU, 10 GB disk.

Open ports in the cloud firewall / security group:

- **22** — SSH  
- **3847** — Robo Views dashboard  

---

## 2. Connect and install Docker

```bash
ssh root@YOUR_VPS_IP
# or: ssh ubuntu@YOUR_VPS_IP
```

```bash
apt update && apt install -y ca-certificates curl git
# Docker official install (Ubuntu)
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

---

## 3. Put the project on the VPS

### Option A — Git (best)

```bash
cd /opt
git clone YOUR_REPO_URL robo-views-bot
cd robo-views-bot
```

### Option B — Upload from your PC (no git)

On **Windows** (PowerShell, from PC):

```powershell
scp -r "d:\Robo Views Bot" root@YOUR_VPS_IP:/opt/robo-views-bot
```

On the **VPS**:

```bash
cd /opt/robo-views-bot
# remove local junk if you uploaded everything
rm -rf node_modules
```

---

## 4. Create `.env` on the VPS

```bash
cd /opt/robo-views-bot
nano .env
```

Paste (fill real values):

```env
JAP_API_KEY=your_jap_key
JAP_API_URL=https://justanotherpanel.com/api/v2
JAP_SERVICE_ID=7394
ORDER_QTY=21
LIVE_MODE=true
PORT=3847
CHANNEL_USERNAME=testnoor123
CHANNEL_URL=https://t.me/testnoor123
AUTO_DISCOVER_POSTS=true
DATA_DIR=/app/data

# Strongly recommended for reliable auto-posts:
# 1) @BotFather → create bot → copy token
# 2) Add bot as ADMIN of your channel @testnoor123
TELEGRAM_BOT_TOKEN=

# Only track posts AFTER this message id (optional; e.g. 78)
# discoverAfterMessageId is also stored in the dashboard DB
```

Save: `Ctrl+O`, Enter, `Ctrl+X`.

**Live spend:** `LIVE_MODE=true` spends real JAP balance. Use `false` first if you only want a dry-run test on the VPS.

---

## 5. Start with Docker (recommended)

```bash
cd /opt/robo-views-bot
docker compose up -d --build
docker compose ps
docker compose logs -f
```

You should see something like:

```text
Robo Views → http://localhost:3847
Mode: LIVE ⚠️
Bot-discover: ON ...
```

Stop following logs: `Ctrl+C` (container keeps running).

### Useful commands

```bash
docker compose logs -f          # watch logs
docker compose restart          # restart bot
docker compose down             # stop
docker compose up -d --build    # rebuild after code update
```

---

## 6. Open the dashboard

In your browser:

**http://YOUR_VPS_IP:3847**

Check:

1. Header shows **LIVE** (if `LIVE_MODE=true`) and a balance  
2. **Auto-discover** ON  
3. Channel `@testnoor123`  
4. Post a test message in the channel → should appear under Tracked posts → **+86** orders  

---

## 7. Firewall on Ubuntu (if needed)

```bash
ufw allow 22
ufw allow 3847
ufw enable
ufw status
```

---

## 8. Without Docker (Node + PM2)

```bash
# install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm i -g pm2

cd /opt/robo-views-bot
npm install --omit=dev
# create .env as above, set DATA_DIR=/opt/robo-views-bot/data
mkdir -p data
pm2 start server/index.js --name robo-views
pm2 save
pm2 startup
```

```bash
pm2 logs robo-views
pm2 restart robo-views
```

---

## 9. Telegram auto-discover checklist

| Method | What you need |
|--------|----------------|
| **Scrape** | VPS can open `https://t.me/s/testnoor123` |
| **Bot API** (best) | `TELEGRAM_BOT_TOKEN` + bot is **channel admin** |

Test scrape from VPS:

```bash
curl -I https://t.me/s/testnoor123
curl -I https://api.telegram.org
```

Both should **not** time out.

---

## 10. Update code later

```bash
cd /opt/robo-views-bot
git pull                    # if using git
docker compose up -d --build
```

Posts/orders live in the Docker volume `robo-data` — rebuild does **not** wipe history.

---

## Security tips

- Do **not** commit `.env` (API keys).  
- Prefer a non-root user + SSH keys.  
- Optional later: put Nginx + HTTPS (domain) in front of port 3847.  
- Turn **Live** off in the UI or set `LIVE_MODE=false` when you are not testing spend.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Dashboard not loading | Security group / `ufw` port **3847** |
| Balance n/a | Wrong `JAP_API_KEY` or forgot restart after change |
| No auto posts | VPS cannot reach Telegram; add bot admin + `TELEGRAM_BOT_TOKEN` |
| Mode always dry-run | Set `LIVE_MODE=true` in `.env` **and** enable Live in UI |
| After reboot bot gone | Docker: `restart: unless-stopped` should revive; Node: `pm2 save` + `pm2 startup` |
