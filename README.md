# Robo View Machine

Organic-style Telegram post views drip via JustAnotherPanel.

## Formula (per post)

| Goal | Value |
|------|--------|
| Total views | **~1,200** |
| Duration | **~4.5 hours** (4–5h band) |
| Order size | **always 20** (JAP service `7394`) |
| Instant open | **~76** → 4×20 every 2s at post start |
| Multi-post | Yes — each link runs its own schedule in parallel |

Milestones (approx paid views):
- 5 min → ~240  
- 20 min → ~440  
- 1 h → ~660  
- 2.5 h → ~900  
- 4.5 h → ~1,200  

## Setup

```bash
cd "d:\Robo Views Bot"
npm install
npm start
```

Open **http://localhost:3847**

Paste one or many links (one per line). Leave start time empty to match “now” (post go-live).
## Setup

```bash
cd "d:\Robo Views Bot"
npm install
npm start
```

Open **http://localhost:3847**

### Env (`.env`)

| Key | Meaning |
|-----|---------|
| `JAP_API_KEY` | Your panel API key |
| `JAP_API_URL` | `https://justanotherpanel.com/api/v2` |
| `JAP_SERVICE_ID` | `7394` |
| `ORDER_QTY` | `20` (locked) |
| `LIVE_MODE` | `false` = dry-run (safe). Turn **Live** on in UI to spend balance. |
| `CHANNEL_USERNAME` | `robogems` |

## Modes

- **DRY-RUN** (default): full schedule + logs, **no** real JAP spend.
- **LIVE**: places real `+20` orders when each drop is due.

## Flow

1. Paste a post link (or **Sync channel** / auto-discover new posts last **1h**).
2. Engine builds the full multi-day schedule.
3. Worker checks every 5s and fires due drops.
4. Dashboard shows stage curve, pending/sent, balance, event log.
