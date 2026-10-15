# Hindsight

A 2–8 player time-travel investing race that runs in the browser.

Everyone is dropped into the same random year between 1962 and 2020 and gets the same run of year cards, including the same lucky years. For each year, every player picks one asset to bet their whole fortune on: a stock, an ETF, an index, gold, oil, corn, Bitcoin. Once everyone has locked in, the cards flip one by one, the money bags hop along each row and the totals roll from thousands to trillions.

## Rules

- **First card**: the starting year. Every player gets the same lump sum ($100, $1,000 or $10,000).
- **Normal year**: buy at the asset's first price of the year, sell at its last price.
- **Lucky year**: buy at the year's best low and sell at the highest price after that low.
- **Fail**: if the asset wasn't trading that year (no data), the money skips the year unchanged and the card is stamped FAIL. The game never warns you.
- **Hold cash**: a safe pick that keeps the money flat.

## Run it

Needs Node 18 or newer. No npm packages.

```bash
node server.js            # listens on port 3000
PORT=8080 node server.js  # or any port
```

Open `http://<server>:<port>/`. One player presses **Create a table** and shares the 4-letter code. Friends open the same address, type the code and press **Join**, or pick the table under **Open tables**.

Health check: `GET /health`.

### Keep it running (systemd)

```ini
# /etc/systemd/system/hindsight.service
[Unit]
Description=Hindsight game server
After=network.target

[Service]
WorkingDirectory=/opt/hindsight
ExecStart=/usr/bin/node /opt/hindsight/server.js
Environment=PORT=3000
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now hindsight
```

Without root, `pm2 start server.js --name hindsight` or `nohup node server.js > hindsight.log 2>&1 &` also works.

### Behind nginx

Server-Sent Events need buffering off on the two stream routes:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

## How multiplayer works

`server.js` is a small presence relay with no dependencies:

- `GET /lobby`: event stream of open tables.
- `GET /events?t=CODE&id=PLAYER`: event stream of everyone at a table and their state.
- `POST /presence {t, id, patch}`: merges a player's state and broadcasts it.
- `POST /leave {t, id}`: leaves a table.

All game logic runs in the browser. The host's state carries the game (seed, start year, lucky cards, phase). Each player's state carries their name, lock status and picks. When everyone is locked, the host flips the phase to `reveal` and every browser plays the same animation from the same data. A player who drops off is removed after 15 seconds, and if the host leaves, the next player in join order takes over.

## Data

`public/index.html` embeds `data/assets.json`: 454 assets. For every year each asset has `[entry, exit, optimalEntry, optimalExit]`, where the optimal pair always buys before it sells.

| Source | What | Years | Granularity |
|---|---|---|---|
| Yahoo Finance | 276 stocks, 40 ETFs, 25 indices, futures, 15 crypto, 14 currencies | 1962–2025 (varies by asset) | Daily OHLC |
| World Bank Pink Sheet | 71 commodity prices | 1960–2025 | Monthly averages |
| FRED producer price indexes | 1950s commodity backfill, lumber, steel, vegetables, paper, seafood | 1950–2025 | Monthly |
| datahub gold prices | Gold in the 1950s | 1950–1959 | Monthly |

Stock prices are split-adjusted and exclude dividends. Assets that share a commodity (gold, silver, oil, corn and others) use futures data from 2000 onward and World Bank or FRED data before that. Some delisted companies (Lehman, Enron, Yahoo, Twitter) aren't in the list because Yahoo no longer serves their history.

The raw per-source files are in `data/`. To change the asset list or merge rules, edit `data/build.py` and run:

```bash
python3 data/build.py   # rewrites data/assets.json and public/index.html
```

The page template is `data/index.src.html`; the build injects the dataset where it says `/*DATA*/`.
