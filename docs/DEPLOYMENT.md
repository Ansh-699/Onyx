# Deployment — onyx.ansht.in

Production runs on one Azure VM (Ubuntu 24.04, `azureuser@138.91.41.33`), shared
with other services. Caddy terminates TLS, pm2 runs the app, and GitHub Actions
deploys every green push to `master`.

## Topology

```
browser ──https──> Caddy (onyx.ansht.in, :443, automatic Let's Encrypt)
                    └── / ──> next start on 127.0.0.1:3001 (pm2 process "onyx-web")
```

- The repo is cloned at `~/onyx`; the app runs from `~/onyx/app` with bun.
- Secrets live only in `~/onyx/app/.env.local` (gitignored, `chmod 600`), placed
  over scp. Nothing secret is in this repository or its history.
- The Caddy site block is in `/etc/caddy/Caddyfile`.

## Env on the server (`~/onyx/app/.env.local`)

| var | value | notes |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | inlined into the browser bundle, so never a keyed URL |
| `SOLANA_RPC_URL` | Helius devnet URL (keyed) | server-only, read at runtime |
| `NEXT_PUBLIC_ONYX_PROGRAM_ID` / `NEXT_PUBLIC_TXORACLE_PROGRAM_ID` | public program ids | non-secret |
| `NEXT_PUBLIC_MAGICBLOCK_ROUTER_URL` | `https://devnet-router.magicblock.app/` | non-secret |
| `ANCHOR_WALLET` | funded devnet keypair (inline array) | powers /api/faucet + demo liquidity |
| `TXLINE_JWT`, `TXLINE_API_TOKEN`, `TXLINE_API_ORIGIN`, `TXLINE_API_BASE_URL` | TxLINE sandbox creds | live fixtures + settlement proofs |

Changing a `NEXT_PUBLIC_*` value needs a rebuild; server-only values need only
`pm2 reload onyx-web --update-env`.

## CI/CD

- `.github/workflows/ci.yml` — program tests (mollusk against the real SBF
  binary) + app typecheck/unit-test/build, on every push and PR.
- `.github/workflows/deploy.yml` — runs when ci succeeds on `master` (or by
  `workflow_dispatch`). It SSHes with `DEPLOY_SSH_KEY` to `DEPLOY_HOST` as
  `DEPLOY_USER`, then smoke-tests `/` and `/markets`.
- The deploy key is restricted on the box: its `authorized_keys` entry is
  `restrict,command="/home/azureuser/onyx-deploy-entry.sh"`, so it can only run a
  deploy. That entry script fetches `origin/master`, hard-resets `~/onyx`, and execs
  the fresh `deploy/deploy.sh`.
- `deploy/deploy.sh` — install with a frozen lockfile, build, `pm2 reload
  onyx-web`, then wait for a 200. A failed build leaves the running app untouched.

## Operations

```bash
ssh -i ~/.ssh/digitalocean azureuser@138.91.41.33

pm2 status                 # process health
pm2 logs onyx-web          # app logs
pm2 reload onyx-web        # zero-downtime restart
sudo systemctl status caddy

# manual deploy (same thing the Action runs)
~/onyx-deploy-entry.sh
```
