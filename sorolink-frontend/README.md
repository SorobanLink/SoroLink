# SoroLink Frontend

![SoroLink logo](./public/sorolink-mark.svg)

The web dashboard for running and inspecting SoroLink Stellar Testnet scenarios.

## Requirements

- Node.js 20.9 or newer
- A running `sorolink-backend` instance

## Setup

```bash
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. The server-side proxy connects to the backend at
`ESURE_BACKEND_URL`, which defaults to `http://127.0.0.1:3001`.

## Commands

```bash
npm run dev
npm run typecheck
npm run build
npm test
npm run start
```

## Security boundary

The browser communicates with a same-origin Next.js proxy. The backend origin is
server-only configuration and is not embedded in the client bundle. This app
never requests, receives, or stores Stellar secret keys.
