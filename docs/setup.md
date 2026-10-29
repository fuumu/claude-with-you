# Setup Guide

**[日本語版 / Japanese](setup.ja.md)** ← 日本語版が正。このファイルは日本語版から同期。

## Starting point

| Location | State |
|------|------|
| GitHub `<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>` | Repository exists (empty or initial state) |
| NAS `<YOUR_NAS_PATH>` | Actual files exist |
| WS (workstation) | Nothing yet |

---

## Phase 1: NAS → GitHub

SSH from the WS into the NAS (as the `<YOUR_NAS_USER>` user) and run the following.

### 1-0. GitHub authentication (SSH key)

```bash
# Generate an SSH key (created in the NAS user's home directory)
ssh-keygen -t ed25519 -C "mio-nas"
# → <YOUR_NAS_HOME>/.ssh/id_ed25519(.pub) is created
# Just press Enter at all 3 prompts (location, passphrase, confirmation)

# Synology permissions are too open by default — fix them (required)
chmod 600 ~/.ssh/id_ed25519
chmod 700 ~/.ssh

# Show the public key
cat ~/.ssh/id_ed25519.pub
```

Copy the string shown in the terminal and register it on GitHub **in a browser on the same WS**.  
Settings → SSH and GPG keys → New SSH key → paste and save.  
(No file transfer needed — the terminal and browser are on the same screen.)

```bash
# Verify the connection
ssh -T git@github.com
# OK if you see "Hi <YOUR_GITHUB_USERNAME>! You've successfully authenticated..."
```

### 1-1. Repository setup

```bash
cd <YOUR_NAS_PATH>

# Initialize git
git init

# Register the remote (SSH form)
git remote add origin git@github.com:<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git

# Create .gitignore
cat > .gitignore << 'EOF'
.env
memory/data/
ts/node_modules/
ts/dist/
EOF

# Stage and commit
git add .
git commit -m "initial commit: mio-memory MCP server"

# Push
# If GitHub already has an initial commit
git pull origin main --allow-unrelated-histories
git push origin main

# If GitHub is empty
# git push -u origin main
```

---

## Phase 2: WS preparation

Run in PowerShell.

### 2-0. GitHub authentication (GitHub CLI)

```powershell
# Install GitHub CLI
winget install GitHub.cli
# If winget is unavailable, download the installer from https://cli.github.com

# Authenticate (a browser opens — log in with your GitHub account)
gh auth login
```

### 2-1. Development environment setup

```powershell
# Create the working folder
New-Item -ItemType Directory -Path <YOUR_LOCAL_PATH>
Set-Location <YOUR_LOCAL_PATH>

# Install Claude Code (requires Node.js 18+)
npm install -g @anthropic-ai/claude-code

# Clone the repository
git clone https://github.com/<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git
Set-Location <YOUR_REPO_NAME>

# Verify Claude Code starts
claude
```

---

## Phase 3: Start working

Start a Claude Code session in the WS repository directory, and Claude Code takes care of reading/writing files, committing, and pushing.

Your role: direction, review, approval.

---

## Phase 4: Deploying to the NAS (on code updates)

SSH from the WS into the NAS and run:

```bash
cd <YOUR_NAS_PATH>

git pull origin main

sudo docker-compose up -d --build memory
```

Health check:

```bash
curl <YOUR_SERVER_URL>/health
# OK if {"status": "ok", "version": "4.0", ..., "served_by": "ts"} is returned
```

> **Note:** on the NAS, `docker-compose` requires `sudo`. Always spell out `origin main` for `git pull` (no upstream is configured).

### Switching from v3.x (Python, TS-front setup) to v4.0 (once)

v4.0 makes the server TypeScript only: the `memory` service in `docker-compose.yml` builds `ts/` (the Python container and the `ts-proxy` service are gone).
The data location (`memory/data` → `/data`), the port (5002) and `.env` stay as they are. OAuth tokens (`oauth_store.json`) carry over, so connectors do not need to re-authenticate.

A NAS that ran the TS-front setup ([ts-switchover.md](ts-switchover.md)) has a locally edited `docker-compose.yml`, so
**stop the old setup first, with the old file**, then drop the local edit and update:

```bash
cd <YOUR_NAS_PATH>

# 0. Back up (settings and data)
cp docker-compose.yml docker-compose.yml.bak.$(date +%Y%m%d)
cp .env .env.bak.$(date +%Y%m%d)
sudo tar czf ../mio-data.$(date +%Y%m%d).tgz memory/data

# 1. Stop the old setup (Python + ts-proxy) with the local compose file, so ts-proxy stops too
sudo docker-compose down

# 2. Drop the local edit and update (check that git status shows nothing else changed)
git checkout -- docker-compose.yml
git status
git pull origin main

# 3. Start the TS-only server
sudo docker-compose up -d --build

# 4. Check
curl http://127.0.0.1:5002/health          # "version":"4.0" and "served_by":"ts"
sudo docker-compose logs memory | head     # mio-memory v4.0: listening on 0.0.0.0:5002
```

Also check that admin.html opens and that MCP tools (e.g. `CoreMem_read`) work from Claude.ai / Claude Code.
The MCP URL is `https://<YOUR_SERVER_URL>/mcp` (the old `/mcp/sse` was removed). The unused Python image can be removed with `sudo docker image prune`.

**Rollback:** the Python version is kept on the `legacy-python` branch (TS-FULL step 7, the last state that ran with the TS front).

```bash
sudo docker-compose down
git fetch origin legacy-python
git checkout legacy-python
cp docker-compose.yml.bak.YYYYMMDD docker-compose.yml   # the TS-front setup saved in step 0
sudo docker-compose up -d --build
```

To return to normal operation, restore the compose file with `git checkout -- docker-compose.yml`, then `git checkout main`.

---

## First-run initialization (CoreMem skeleton)

`memory/data/` is `.gitignore`d, so a brand-new environment ships with no memory and no rules.
mio-memory **boots fine when empty**, but the CoreMem `core.md` that defines who the assistant is
is meaningless without content (the MCP `initialize` tells clients to run `CoreMem_read("core.md")` at session start).

**`ts/skeleton/`** (bundled in the repo, v3.43+; moved from `memory/skeleton/` in v4.0) fills this gap.

### Auto-seed behavior (idempotent; existing environments untouched)

On first boot, `seedCoreMemIfEmpty()` in `ts/src/seed.ts` runs under this contract (same as the old Python version):

1. Seed `ts/skeleton/coremem/<lang>/*.md` **only when CoreMem has no `core_stable.md`** (a fresh environment)
2. Skip any file that already exists (**idempotent** — no double-seeding on restart)
3. Do **nothing** when `core_stable.md` is present (protects a running environment's data)

Files seeded: `core_manifest.md` / `core_stable.md` / `core_rules.md` / `core_infra.md` /
`core_history.md` / `todo.md` / `protocol_guide.md` / `welcome.md`

### Help on-ramp (`MIO_SEED_WELCOME`, default on)

So new users aren't lost, the first seed adds an "ask the connected Claude how to use it" on-ramp:

- seeds `welcome.md` (a user-facing guide)
- posts a one-time persistent inbox message (the AI notices it at startup and can guide the user)
- set `MIO_SEED_WELCOME=off` in `.env` if you don't want it

### Seed language (`MIO_SEED_LANG`)

The skeleton ships in two languages (`skeleton/coremem/ja/` and `en/`). Pick which one to seed via an env var:

- unset → **`ja`** (default)
- `MIO_SEED_LANG=en` → English skeleton
- falls back to `ja` if the requested language is missing

For an English-speaking new environment, set `MIO_SEED_LANG=en` in `.env` before the first boot.

### Filling in after setup

1. Replace the `<...>` placeholders in `core_stable.md` (identity) and `core_infra.md` (host/URL/version)
   — edit via the admin.html CoreMem tab or the MCP `CoreMem_save` tool
2. Adjust the operating rules in `core_rules.md` as needed
3. `protocol_guide.md` (the 38-tool MCP guide) works as-is (install-agnostic)

> See `ts/skeleton/README.md` for the full rationale and policy.

---

## Friend system setup

### SendGrid configuration

The friend system uses SendGrid to send approval emails.

**1. SendGrid account setup**

1. Create an account at [sendgrid.com](https://sendgrid.com) (the free plan is sufficient)
2. Settings → API Keys → Create API Key
3. Permissions: **Mail Send** only is fine
4. Copy the generated key (it is shown only once)

**2. Verify the sender email address**

1. Settings → Sender Authentication → Single Sender Verification
2. Register and verify the email address you will send from

**3. Configure .env**

```env
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxx
SENDGRID_FROM_EMAIL=mio@your-domain.com
MIO_REGISTER_URL=https://your-domain.com
```

`MIO_REGISTER_URL` is the base URL for the activation link in approval emails (no trailing path — `/activate` is appended automatically). Optional (falls back to `MIO_BASE_URL`).

**Note:** if `SENDGRID_API_KEY` is unset, approval emails are not sent. Activation codes can be viewed manually in the Friends tab of admin.html.

---

## LMStudio setup (run on the WS)

Preparation for running `generate_summary_layers.py` with `--backend lmstudio`.

### 1. Enable the Anthropic-compatible endpoint

1. Start LMStudio
2. Open the **Developer** tab in the left sidebar (the `</>` icon)
3. Set **Server** to `Running`
4. Confirm **Anthropic-compatible** is enabled (checkbox or toggle)
5. Confirm the port is `1234`

### 2. Open port 1234 in the Windows firewall

Run in an elevated PowerShell:

```powershell
netsh advfirewall firewall add rule name="LMStudio" dir=in action=allow protocol=TCP localport=1234
```

### 3. Verify connectivity from the NAS

SSH into the NAS and test:

```bash
curl http://<YOUR_WS_IP>:1234/v1/models
# OK if LMStudio responds
```

---

## Docker build DNS issue (Synology NAS specific)

### Symptom

`npm install` stalls with DNS resolution failures while building the `node:22-slim` image (up to v3.x the same thing happened to `pip install` in `python:3.11-slim`):

```
npm install --no-audit --no-fund
...
npm error code EAI_AGAIN
npm error request to https://registry.npmjs.org/sharp failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org
```

### Cause

The default DNS in Synology's Docker build environment sometimes doesn't work.

### Fix

Add `network: host` to the `build:` section of `docker-compose.yml` so the build uses the host's DNS (which has internet connectivity):

```yaml
services:
  memory:
    build:
      context: ./ts
      network: host    ← add this (the bundled docker-compose.yml already has it)
```

---

## Notes on using network_mode: host

`network_mode: host` is set so the container can reach LMStudio on the WS (`<YOUR_WS_IP>:1234`).

### Note: `ports:` and `dns:` are unnecessary

With `network_mode: host`, the `ports:` and `dns:` settings are ignored (and may produce warnings), so **remove them**:

```yaml
services:
  memory:
    network_mode: host
    # remove ports: (ineffective with network_mode: host)
    # remove dns: (unneeded — the host's DNS is used)
    volumes:
      - ./memory/data:/data
```
