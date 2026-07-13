# Deployment — onyx.ansht.tech

Production runs on a single DigitalOcean droplet (Ubuntu 24.04) behind
nginx + Let's Encrypt, managed by pm2, auto-deployed from GitHub Actions
on every green push to `master`.

## Topology

```
browser ──https──> nginx (onyx.ansht.tech, :443)
                    ├── /rpc  ──> Helius devnet RPC   (API key lives ONLY in nginx config)
                    └── /     ──> next start on 127.0.0.1:3000 (pm2 process "onyx")
```

- The app repo lives at `/opt/onyx` (git clone of this repository).
- Secrets live at `/opt/onyx-secrets/` (root-only, `chmod 600`) and in
  `/opt/onyx/app/.env.local` — both are **outside git** and were placed
  over scp; nothing secret is in this repository or its history.
- Runtime price-history state is written to `/opt/onyx/app/.data/`
  (gitignored), so it survives deploys.

## Why the /rpc proxy

`NEXT_PUBLIC_*` env vars are inlined into the browser bundle at build
time. Putting a keyed RPC URL there would publish the API key to every
visitor. Instead the browser is built with
`NEXT_PUBLIC_SOLANA_RPC_URL=https://onyx.ansht.tech/rpc`, and nginx
forwards that path to Helius. Server-side code (API routes) uses Helius
directly via the non-public `SOLANA_RPC_URL`. Both fall back to
`https://api.devnet.solana.com` if unset (see `app/src/lib/onchain.ts`).

## Env on the server (`/opt/onyx/app/.env.local`)

| var | value | notes |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://onyx.ansht.tech/rpc` | proxied; no key in bundle |
| `SOLANA_RPC_URL` | Helius devnet URL (keyed) | server-only |
| `NEXT_PUBLIC_ONYX_PROGRAM_ID` / `NEXT_PUBLIC_TXORACLE_PROGRAM_ID` | public program ids | non-secret |
| `ANCHOR_WALLET` | `/opt/onyx-secrets/id.json` | funded devnet keypair; powers /api/faucet + demo liquidity |
| `TXLINE_JWT`, `TXLINE_API_TOKEN` (+ optional `TXLINE_API_ORIGIN`, `TXLINE_API_BASE_URL`) | TxLINE sandbox creds | live fixture window + settlement proofs |

## CI/CD

- `.github/workflows/ci.yml` — program tests (mollusk against the real SBF
  binary) + app typecheck/unit-test/build, on every push and PR.
  Note: `app/next-env.d.ts` is gitignored, so CI regenerates the two
  `/// <reference>` lines before `tsc --noEmit` (they declare the
  image-module types; without them every `import x from "*.png"` fails).
- `.github/workflows/deploy.yml` — fires when ci completes **successfully
  on master**; ssh's to the droplet and runs `/opt/onyx/deploy/deploy.sh`.
  Needs one repo secret: `DO_SSH_PRIVATE_KEY` (private key matching a key
  in the droplet's `~root/.ssh/authorized_keys`).
- `deploy/deploy.sh` — `git reset --hard origin/master`, install, build
  into a scratch dir first, then swap + `pm2 reload onyx`. A failed build
  leaves the running app untouched.

## Operations

```bash
ssh -i ~/.ssh/digitalocean root@134.209.149.89

pm2 status            # process health
pm2 logs onyx         # app logs
pm2 reload onyx       # zero-downtime restart
systemctl status nginx
certbot renew --dry-run   # cert auto-renews via systemd timer

# manual deploy (same thing the Action runs)
/opt/onyx/deploy/deploy.sh
```

## Rotating the Helius key

1. Generate a new key in the Helius dashboard.
2. On the droplet, edit the key in BOTH places:
   `/etc/nginx/sites-available/onyx` (the `/rpc` proxy_pass) and
   `/opt/onyx/app/.env.local` (`SOLANA_RPC_URL`).
3. `nginx -t && systemctl reload nginx && pm2 reload onyx`.
   No rebuild needed — the browser only ever sees `/rpc`.
