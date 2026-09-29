# AmneziaWG Clients Monitor

A minimal read-only administrative dashboard that displays a current snapshot of clients from an existing AmneziaWG container. The application does not modify the VPN configuration or manage containers.

Russian documentation: [README_ru.md](README_ru.md).

## Architecture

```text
Browser → React → GET /api/clients and /api/stats → Fastify → dockerode
                                               ↓
                                      /var/run/docker.sock
                                               ↓
                                         amnezia-awg2
```

Fastify and the compiled React application run in a single production container on `0.0.0.0:8080`. The backend performs only two predefined operations inside the target container:

```text
awg show awg0 dump
cat /opt/amnezia/awg/clientsTable
```

Commands, the container name, and the interface name cannot be supplied through HTTP requests. Runtime data is matched with metadata strictly by `clientId === publicKey`. Traffic statistics are shown from the VPN client's perspective: AWG `txBytes` is download traffic and AWG `rxBytes` is upload traffic.

## Requirements

- Node.js 24 or newer and npm for development;
- Docker with Compose for production deployments;
- an existing AmneziaWG container, named `amnezia-awg2` by default;
- access to `/var/run/docker.sock` on the Docker host.

## Local development

```bash
npm install
npm run dev
```

Vite starts at `http://localhost:5173` and proxies `/api` to Fastify at `http://localhost:8080`. The local API process must have access to `/var/run/docker.sock`.

Available checks:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

The project uses Oxlint with `oxlint-tsgolint` for type-aware linting and Oxfmt for formatting. Run `npm run format` to apply formatting changes.

## Production build

Build the monorepo locally:

```bash
npm install
npm run build
NODE_ENV=production npm run start -w @awg-monitor/api
```

The production version should normally be started with Docker Compose so that the Docker socket is mounted correctly.

## Docker Compose

```bash
docker compose up -d --build
docker compose logs -f
```

By default, Compose publishes the application at `http://localhost:8080`. You can change the host port through `HOST_PORT`, for example: `HOST_PORT=8081 docker compose up -d --build`. `PORT` controls the port that Fastify listens on inside the container, while `HOST_PORT` controls the host-side mapping. Both default to `8080`. The `amnezia-awg2` container is not part of this Compose project and remains managed separately.

To stop the application:

```bash
docker compose down
```

## Environment variables

| Variable                   |        Default | Purpose                                                                 |
| -------------------------- | -------------: | ----------------------------------------------------------------------- |
| `PORT`                     |         `8080` | Internal Fastify HTTP port                                              |
| `HOST_PORT`                |         `8080` | Docker host port published by Compose                                   |
| `AMNEZIA_CONTAINER`        | `amnezia-awg2` | Name of the existing container                                          |
| `AMNEZIA_INTERFACE`        |         `awg0` | AWG interface name                                                      |
| `ONLINE_THRESHOLD_SECONDS` |          `180` | Maximum handshake age for an online client                              |
| `CACHE_TTL_MS`             |         `3000` | In-memory snapshot lifetime                                             |
| `NODE_ENV`                 |  `development` | Enables serving the compiled React application when set to `production` |

See `.env.example` for an example configuration. Do not expose these values through public HTTP parameters.

## API

- `GET /api/health` checks the HTTP application;
- `GET /api/clients` returns the current merged client snapshot.
- `GET /api/stats` returns the current CPU load of the AmneziaWG container.

The dashboard refreshes both client data and CPU load every 10 seconds. If the socket, container, command, or source data is unavailable, `/api/clients` and `/api/stats` respond with status `503` and safe JSON without a stack trace. `/api/health` checks only whether the dashboard itself is ready and does not contact AmneziaWG.

## Docker socket security

The Docker socket effectively provides elevated access to the host. The `:ro` suffix protects the socket mount as a filesystem entry, but **does not make the Docker API read-only**. The primary protection is architectural:

- there is no generic Docker proxy or command execution endpoint;
- the HTTP API accepts only `GET` requests and does not accept Docker commands;
- the backend contains only two fixed Docker Exec calls;
- there is no `child_process`, Docker CLI, `eval`, or start/stop/remove/create operation;
- the dashboard container uses a read-only filesystem;
- responses and ordinary logs do not include the client endpoint list.

Run the dashboard only in a trusted environment and restrict external access through Dokploy/Traefik. Version 1 does not include built-in authentication.

## Dokploy

1. Create a Compose application in Dokploy from this repository.
2. Deploy using the root `docker-compose.yml` file.
3. Add a domain to the `vpn-dashboard` service.
4. Set `Container Port` to `8080` and select HTTP.
5. Restrict access through Traefik, a reverse proxy, or an external identity-aware proxy.
6. Check `/api/health` and `/api/clients` through the configured domain.

Publishing `HOST_PORT` is useful for self-hosted installations and does not interfere with Dokploy routing to the internal `PORT`, which defaults to `8080`. If `PORT` is changed, configure the same container port in Dokploy. If the server policy prohibits publishing host ports, remove the `ports` section in a local Compose override file.

## Troubleshooting

Check container state and logs:

```bash
docker compose ps
docker compose logs -f vpn-dashboard
docker ps --filter name=amnezia-awg2
```

Check HTTP from the Docker host:

```bash
curl http://localhost:8080/api/health
```

Alternatively, check HTTP from inside the production container:

```bash
docker compose exec vpn-dashboard node -e "fetch('http://127.0.0.1:8080/api/health').then(async r => console.log(r.status, await r.text()))"
```

Common causes of `/api/clients` errors:

- `/var/run/docker.sock` is missing or inaccessible to the process;
- the container named by `AMNEZIA_CONTAINER` does not exist or is stopped;
- the container does not include `awg`, or `AMNEZIA_INTERFACE` is incorrect;
- `/opt/amnezia/awg/clientsTable` is missing or contains malformed JSON.

If the Docker socket group on the host is incompatible with the image user, check the socket permissions and Docker daemon configuration. Do not make the socket publicly writable with `chmod 666`.
