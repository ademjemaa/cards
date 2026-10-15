# Notes for Claude Code

This repo is Hindsight, a browser game with a zero-dependency Node server. See README.md for rules, data and architecture.

## Deploying

The owner will give you the server address and SSH details in the conversation. Never commit them to this repo: it is public.

Typical deploy to a Linux server over SSH:

1. Check Node 18+ is installed on the server (`node -v`). If not, install it (NodeSource or the distro's package).
2. Copy or `git clone` this repo to the server, e.g. `/opt/hindsight` or `~/hindsight`.
3. Pick a port that is open in the server's firewall (check `ufw status` / the cloud provider's firewall). Default is 3000.
4. Run it as a service: systemd unit from README.md if you have sudo, otherwise `pm2` or `nohup`.
5. Verify from outside: `curl http://<server>:<port>/health` should return `{"ok":true,...}`, and `/` should return the game page.
6. Tell the owner the exact URL to share with friends.

If nginx or another reverse proxy fronts it, turn off proxy buffering (see README.md) or the live updates will stall.

## Editing

- Game UI and client logic: `data/index.src.html`, then run `python3 data/build.py` to regenerate `public/index.html`. Do not hand-edit `public/index.html`; it is generated and holds ~430 KB of embedded data.
- Server: `server.js`.
- Dataset rules: `data/build.py`.
