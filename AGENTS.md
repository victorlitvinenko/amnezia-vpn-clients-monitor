# AGENTS.md

## Project overview

This repository contains a minimal, read-only dashboard for monitoring clients of an existing AmneziaWG Docker container.

The application is a TypeScript npm-workspaces monorepo:

- `apps/api`: Fastify API, Docker integration, parsing, merge logic, and tests.
- `apps/web`: React and Vite dashboard.
- `packages/shared`: API types shared by the backend and frontend.
- `Dockerfile`: multi-stage production image containing the API and compiled frontend.
- `docker-compose.yml`: production-oriented Compose service with Docker socket access.

The production server listens on `0.0.0.0` using `PORT`, which defaults to `8080`. Compose publishes that container port through `HOST_PORT`, which also defaults to `8080`.

## Agent workflow

- Communicate with the repository owner in Russian unless the current request explicitly asks for another language.
- Use Context7 whenever current third-party library or framework documentation is needed.
- Use the configured Exa MCP tools rather than built-in web search or fetching when external research is required.
- Inspect `git status` before editing and preserve unrelated user changes.
- Use `apply_patch` for hand-written file changes.
- Prefer `rg` and `rg --files` for repository searches.
- Do not create commits, branches, pull requests, or destructive Git operations unless explicitly requested.
- Keep changes focused on the current task and avoid unrelated dependency or formatting churn.
- Report which verification commands were run and call out checks that could not be completed.

## Required commands

Install dependencies:

```bash
npm install
```

Use Node.js 24 or newer. Local development and both Docker build stages are standardized on Node.js 24.

Run local development servers:

```bash
npm run dev
```

Before completing a change, run all relevant checks:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
docker compose config --quiet
```

Oxlint with `oxlint-tsgolint` provides type-aware linting. Oxfmt is the only formatter; run `npm run format` to apply formatting changes.

For changes to Docker packaging or production startup, also verify:

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:${HOST_PORT:-8080}/api/health
```

Do not assume that the `amnezia-awg2` container exists in every development environment. A `503` response from `/api/clients` is expected when the target container is unavailable; `/api/health` must still return `200`.

## Architecture and data flow

```text
Browser
  → React dashboard
  → GET /api/clients
  → Fastify
  → dockerode
  → /var/run/docker.sock
  → existing AmneziaWG container
```

The backend reads two sources concurrently:

1. `awg show <interface> dump` for current peer state.
2. `cat /opt/amnezia/awg/clientsTable` for client metadata.

Records must be joined strictly by public key:

```ts
client.clientId === peer.publicKey;
```

Never join records by IP address.

Runtime AWG data is authoritative for IP address, handshake, endpoint, and traffic. `clientsTable` contributes only the client name, creation date, and a fallback IP address.

AWG traffic counters are server-relative. Convert them to the client's perspective:

```ts
downloadBytes = peer.txBytes;
uploadBytes = peer.rxBytes;
```

## Security invariants

Treat these rules as mandatory. The Docker socket grants highly privileged access to the host even when mounted with `:ro`.

- The application is read-only.
- Do not add generic Docker proxy, exec, command, or shell endpoints.
- Do not accept container names, interface names, commands, or command arguments from HTTP requests.
- Keep Docker commands as fixed server-side arrays.
- Do not use `child_process`, a Docker CLI binary, `eval`, or dynamically constructed shell commands.
- Do not call container mutation APIs such as `start`, `stop`, `restart`, `remove`, or `createContainer`.
- Do not write files inside the AmneziaWG container.
- Do not expose preshared keys, private keys, AWG header protection keys, configuration contents, or Docker socket details.
- Do not log the `/api/clients` response body or client endpoints.
- API failures must return safe JSON without stack traces or internal Docker details.
- Keep application API routes read-only and based on `GET`.

The only allowed commands inside the AmneziaWG container are the internal equivalents of:

```text
awg show awg0 dump
cat /opt/amnezia/awg/clientsTable
```

`AMNEZIA_CONTAINER` and `AMNEZIA_INTERFACE` may change these server-side targets through environment variables, but HTTP clients must never control them.

## Backend conventions

- Use strict TypeScript and avoid `any`.
- Keep parsing and merge logic as pure functions in `apps/api/src/domain.ts`.
- Validate untrusted `clientsTable` JSON at runtime with Zod.
- Correctly demultiplex Docker Exec stdout and stderr; never treat the raw multiplexed stream as plain text.
- Fetch AWG runtime state and client metadata with `Promise.all`.
- Preserve the short in-memory cache and coalesce concurrent cache misses.
- A handshake timestamp of `0` means the client has never connected.
- Online status is a heuristic based on `ONLINE_THRESHOLD_SECONDS`.
- Include runtime peers even when their metadata is missing.
- Ignore malformed AWG peer lines instead of crashing the entire parser.
- Keep API types in `packages/shared`.
- Preserve graceful shutdown on `SIGTERM` and `SIGINT`.

When changing parsing, merge behavior, status calculation, caching, or traffic direction, add or update unit tests.

## Frontend conventions

- Keep the UI in English unless the product requirements explicitly change.
- Preserve the dark, compact, responsive design without introducing a UI kit or Tailwind.
- Desktop uses a table-like layout; narrow screens use client cards.
- Keep previous data visible during automatic refreshes.
- Refresh `/api/clients` every 10 seconds.
- Sort clients deterministically: online first, then newest handshake, never-connected clients last, and name as the final tie-breaker.
- Display IP addresses and endpoints with a monospace font.
- Show `Never connected` when no handshake exists.
- Avoid charts, animations, history, WebSockets, and SSE in this version.

If layout or interaction behavior changes, test both desktop and mobile widths and check for horizontal overflow and browser console errors.

## Docker and deployment

- Keep a multi-stage Docker build.
- The runtime image must contain only production dependencies and compiled output.
- Do not install or include Docker CLI in the image.
- Keep Fastify bound to `0.0.0.0` inside the container.
- `PORT` controls the internal application port and `HOST_PORT` controls the host-side mapping; both default to `8080`.
- Do not add the existing AmneziaWG container to this Compose project.
- Keep the application stateless and do not add persistent volumes or databases.
- Preserve the read-only root filesystem, `/tmp` tmpfs, `no-new-privileges`, and healthcheck unless a documented technical reason requires a change.
- Dokploy/Traefik should route to the container port configured by `PORT`.

## Environment variables

Supported variables and defaults:

| Variable                   |        Default | Meaning                                               |
| -------------------------- | -------------: | ----------------------------------------------------- |
| `PORT`                     |         `8080` | Fastify port inside the container                     |
| `HOST_PORT`                |         `8080` | Host port published by Compose                        |
| `AMNEZIA_CONTAINER`        | `amnezia-awg2` | Existing target container name                        |
| `AMNEZIA_INTERFACE`        |         `awg0` | AWG interface name                                    |
| `ONLINE_THRESHOLD_SECONDS` |          `180` | Maximum handshake age for online status               |
| `CACHE_TTL_MS`             |         `3000` | In-memory snapshot cache lifetime                     |
| `NODE_ENV`                 |  `development` | Runtime mode; production serves the compiled frontend |

Update `.env.example`, `README.md`, and `README_ru.md` whenever environment behavior or deployment instructions change.

## Documentation

- `README.md` is the primary English documentation.
- `README_ru.md` is the Russian translation.
- Keep both documents synchronized when behavior, commands, configuration, or troubleshooting guidance changes.
- Keep exact command, package, API, and product names unchanged when translating them.

## Scope control

Keep the first version intentionally small. Do not introduce databases, authentication, history, charts, GeoIP, notifications, client management, configuration editing, traffic limits, or speculative abstractions unless the task explicitly requires them.

Prefer straightforward code, strict types, small pure functions, and focused tests over framework-heavy architecture.
