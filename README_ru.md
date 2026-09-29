# AmneziaWG Clients Monitor

Минимальная административная панель только для чтения, которая показывает текущий snapshot клиентов из уже работающего контейнера AmneziaWG. Приложение не изменяет конфигурацию VPN и не управляет контейнерами.

## Архитектура

```text
Browser → React → GET /api/clients и /api/stats → Fastify → dockerode
                                               ↓
                                      /var/run/docker.sock
                                               ↓
                                         amnezia-awg2
```

Fastify и собранный React работают в одном production-контейнере на `0.0.0.0:8080`. Backend выполняет внутри целевого контейнера только две заранее заданные операции:

```text
awg show awg0 dump
cat /opt/amnezia/awg/clientsTable
```

Команды, имя контейнера и имя интерфейса не принимаются из HTTP-запросов. Runtime-данные связываются с метаданными строго по `clientId === publicKey`. Статистика трафика показывается с точки зрения VPN-клиента: AWG `txBytes` — download, AWG `rxBytes` — upload.

## Требования

- Node.js 24 или новее и npm — для разработки;
- Docker с Compose — для production-запуска;
- уже работающий контейнер AmneziaWG, по умолчанию `amnezia-awg2`;
- доступ к `/var/run/docker.sock` на Docker-host.

## Локальная разработка

```bash
npm install
npm run dev
```

Vite запускается на `http://localhost:5173` и проксирует `/api` в Fastify на `http://localhost:8080`. Локальный процесс API должен иметь доступ к `/var/run/docker.sock`.

Доступные проверки:

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
```

Для type-aware lint используется Oxlint с `oxlint-tsgolint`, для форматирования — Oxfmt. Команда `npm run format` применяет форматирование.

## Production build

Локальная сборка monorepo:

```bash
npm install
npm run build
NODE_ENV=production npm run start -w @awg-monitor/api
```

Обычно production-версию следует запускать через Docker Compose, чтобы корректно подключить Docker socket.

## Docker Compose

```bash
docker compose up -d --build
docker compose logs -f
```

По умолчанию Compose публикует приложение на `http://localhost:8080`. Внешний порт можно изменить через `HOST_PORT`, например `HOST_PORT=8081 docker compose up -d --build`. `PORT` задаёт порт, который Fastify слушает внутри контейнера, а `HOST_PORT` — соответствующий порт на хосте. По умолчанию обе переменные равны `8080`. Контейнер `amnezia-awg2` не входит в этот compose-проект и продолжает управляться отдельно.

Для остановки:

```bash
docker compose down
```

## Переменные окружения

| Переменная                 |   По умолчанию | Назначение                                   |
| -------------------------- | -------------: | -------------------------------------------- |
| `PORT`                     |         `8080` | Внутренний HTTP-порт Fastify                 |
| `HOST_PORT`                |         `8080` | Порт Docker-host, публикуемый Compose        |
| `AMNEZIA_CONTAINER`        | `amnezia-awg2` | Имя существующего контейнера                 |
| `AMNEZIA_INTERFACE`        |         `awg0` | Имя AWG-интерфейса                           |
| `ONLINE_THRESHOLD_SECONDS` |          `180` | Максимальный возраст handshake для online    |
| `CACHE_TTL_MS`             |         `3000` | Время жизни snapshot в памяти                |
| `NODE_ENV`                 |  `development` | В `production` включает раздачу React-сборки |

Пример находится в `.env.example`. Не передавайте эти значения через публичные HTTP-параметры.

## API

- `GET /api/health` — проверка HTTP-приложения;
- `GET /api/clients` — текущий объединённый snapshot клиентов.
- `GET /api/stats` — текущая нагрузка на процессор контейнера AmneziaWG.

Панель обновляет данные клиентов и нагрузку на процессор каждые 5 секунд. При недоступности socket, контейнера, команды или повреждённых данных `/api/clients` и `/api/stats` отвечают `503` и безопасным JSON без stack trace. `/api/health` проверяет только готовность самого dashboard и не обращается к AmneziaWG.

## Безопасность Docker socket

Docker socket фактически предоставляет высокие привилегии на host. Суффикс `:ro` защищает точку монтирования как файл, но **не делает Docker API доступным только для чтения**. Основная защита здесь архитектурная:

- нет универсального Docker proxy или endpoint выполнения команд;
- HTTP API принимает только `GET` и не принимает Docker-команды;
- backend содержит только два фиксированных вызова Docker Exec;
- отсутствуют `child_process`, Docker CLI, `eval` и операции start/stop/remove/create;
- файловая система dashboard-контейнера работает в режиме read-only;
- ответы и обычные логи не содержат endpoint-список клиентов.

Размещайте dashboard только в доверенной среде и ограничьте внешний доступ средствами Dokploy/Traefik. В v1 встроенной авторизации нет.

## Dokploy

1. Создайте в Dokploy Compose-приложение из этого репозитория.
2. Выполните deployment с `docker-compose.yml` из корня.
3. Добавьте домен к сервису `vpn-dashboard`.
4. Укажите `Container Port` равным `8080` и HTTP-протокол.
5. Ограничьте доступ на уровне Traefik, reverse proxy или внешнего identity-aware proxy.
6. Проверьте через домен пути `/api/health` и `/api/clients`.

Публикация `HOST_PORT` полезна для самостоятельного запуска и не мешает маршрутизации Dokploy на внутренний `PORT`, который по умолчанию равен `8080`. Если значение `PORT` изменено, укажите тот же container port в Dokploy. Если политика конкретного сервера запрещает публикацию host-портов, удалите секцию `ports` в локальном override-файле Compose.

## Диагностика

Посмотреть состояние и логи:

```bash
docker compose ps
docker compose logs -f vpn-dashboard
docker ps --filter name=amnezia-awg2
```

Проверить HTTP с Docker-host:

```bash
curl http://localhost:8080/api/health
```

Либо проверить HTTP изнутри production-контейнера:

```bash
docker compose exec vpn-dashboard node -e "fetch('http://127.0.0.1:8080/api/health').then(async r => console.log(r.status, await r.text()))"
```

Частые причины ошибок `/api/clients`:

- `/var/run/docker.sock` отсутствует или недоступен процессу;
- контейнер с именем из `AMNEZIA_CONTAINER` не найден или остановлен;
- в контейнере нет `awg` либо задан неверный `AMNEZIA_INTERFACE`;
- отсутствует `/opt/amnezia/awg/clientsTable` или файл содержит повреждённый JSON.

Если группа Docker socket на host несовместима с пользователем образа, проверьте права socket и настройки Docker daemon. Не делайте socket общедоступным через `chmod 666`.
