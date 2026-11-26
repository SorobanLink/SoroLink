# Windows Development Setup

This guide walks through setting up SoroLink for local development on Windows
using **PowerShell** or **Git Bash**. All commands are tested on Windows 10 and
Windows 11.

> **Note:** The main `README.md` uses Unix-style commands. The equivalents below
> differ where shell syntax, path separators, or environment variable syntax
> differs on Windows.

---

## Prerequisites

### Node.js (via nvm-windows or winget)

**Option A — nvm-windows (recommended, allows version switching):**

```powershell
# Download and run the nvm-windows installer from:
# https://github.com/coreybutler/nvm-windows/releases
# Then in a new Administrator PowerShell:
nvm install 20
nvm use 20
node --version  # should print v20.x.x
```

**Option B — winget (simpler, system-wide install):**

```powershell
winget install OpenJS.NodeJS.LTS
# Restart PowerShell after install
node --version
```

### Git

```powershell
winget install Git.Git
# Or download from https://git-scm.com/download/win
```

### Line ending configuration

Stellar YAML scenario files and shell scripts use Unix line endings (LF). Configure
Git to check out files with LF on Windows so the CLI does not reject them:

```powershell
git config --global core.autocrlf input
```

This keeps working-tree files in their original LF format when you clone; it
does not affect files you create on Windows.

---

## Clone and install

**PowerShell:**

```powershell
git clone https://github.com/SorobanLink/SoroLink.git
cd SoroLink
npm install  # root workspace install
```

**Git Bash:**

```bash
git clone https://github.com/SorobanLink/SoroLink.git
cd SoroLink
npm install
```

---

## Environment variables

PowerShell does not use `export KEY=VALUE`. Use one of these approaches:

**Set for the current session:**

```powershell
$env:NODE_ENV = "development"
$env:ESURE_BACKEND_URL = "http://localhost:4000"
```

**Load from a `.env` file (PowerShell):**

```powershell
# Install dotenv-cli if not already installed
npm install -g dotenv-cli

# Then prefix commands with dotenv:
dotenv -- npm start
```

**Git Bash** supports the same `KEY=VALUE npm start` syntax as Unix:

```bash
NODE_ENV=development npm start
```

---

## Backend

```powershell
cd sorolink-backend
npm ci
# Copy and edit the env file
Copy-Item .env.example .env
# Edit .env in your preferred editor, then:
npm run dev
```

**Git Bash:**

```bash
cd sorolink-backend
npm ci
cp .env.example .env
# Edit .env, then:
npm run dev
```

---

## Frontend

```powershell
cd sorolink-frontend
npm ci
# Copy env file
Copy-Item .env.local.example .env.local
# Edit .env.local, then:
npm run dev
```

The dev server starts at `http://localhost:3000`.

---

## CLI

```powershell
cd sorolink-cli
npm ci
npm run build
# Run a bundled scenario:
node dist/cli.js run xlm-payment
```

**Git Bash:**

```bash
cd sorolink-cli
npm ci
npm run build
node dist/cli.js run xlm-payment
```

---

## Running tests

### Backend tests

```powershell
cd sorolink-backend
npm test
```

### Frontend tests

```powershell
cd sorolink-frontend
npm test
```

### CLI tests

```powershell
cd sorolink-cli
npm test
```

---

## Running `npm run check` (workspace-level)

From the repo root:

```powershell
npm run check
```

This runs typecheck, lint, and test for all packages. If a package's check
script fails, it will print which package failed.

---

## Common Windows-specific issues

### `'node' is not recognized…`

Node was not added to `PATH`. Restart PowerShell, or add `%APPDATA%\nvm` and
the active Node directory to `PATH` manually via System Properties → Environment
Variables.

### `\r` characters cause `sh: syntax error` in scripts

Your `.env` or YAML files have Windows line endings (CRLF). Run:

```powershell
git config --global core.autocrlf input
# Then re-clone or run:
git rm --cached -r .
git reset --hard
```

### PowerShell execution policy blocks npm scripts

```powershell
# Allow local scripts for the current user:
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

### Path separator issues in scenario file arguments

The CLI accepts both `/` and `\` on Windows. If you pass a custom scenario
path with backslashes, quote it:

```powershell
node dist/cli.js run "..\tests\my-scenario.yaml"
```

**Git Bash** uses `/` natively:

```bash
node dist/cli.js run ../tests/my-scenario.yaml
```
