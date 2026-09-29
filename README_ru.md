# AmneziaWG Clients Monitor

Минимальная административная панель только для чтения, которая показывает текущий snapshot клиентов из уже работающего контейнера AmneziaWG. Приложение не изменяет конфигурацию VPN и не управляет контейнерами.

## Архитектура

```text
Browser → ввод пароля → подписанная session cookie
        → React → защищённые GET /api/clients и /api/stats → Fastify → dockerode
                                               ↘ SQLite-счётчики трафика
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

Backend в фоне опрашивает счётчики AWG. При первом успешном опросе текущие счётчики становятся начальным значением за месяц, а дневной учёт начинается с нуля. Последующие приращения используются для дневного и месячного download каждого клиента, общего дневного трафика и текущей скорости download/upload. Последний ненулевой handshake также сохраняется, поэтому колонка `Connection` не сбрасывается после перезапуска приложения или VPN-контейнера. Сохранённый handshake используется только как история для отображения; статус online всегда определяется по текущему состоянию AWG. Границы дня и календарного месяца определяются через `TZ`.

## Требования

- Node.js 24 или новее и npm — для разработки;
- Docker с Compose — для production-запуска;
- уже работающий контейнер AmneziaWG, по умолчанию `amnezia-awg2`;
- доступ к `/var/run/docker.sock` на Docker-host.

## Настройка авторизации

Авторизация обязательна. Fastify сверяет единый пароль панели с Argon2id-хешем и хранит признак успешного входа и срок действия в подписанной через HMAC-SHA256 cookie с флагами `HttpOnly` и `SameSite=Strict`. Cookie не содержит пароль или конфиденциальные данные VPN. Пароль в открытом виде не хранится и не попадает во frontend-сборку.

Установите зависимости. При необходимости сгенерируйте стойкий случайный пароль панели, затем интерактивно создайте его Argon2id-хеш и отдельный 32-байтовый секрет сессии:

```bash
npm install
npm run auth:password
npm run auth:hash
npm run auth:secret
```

Сохраните результат `npm run auth:password` в менеджере паролей. `npm run auth:hash` дважды запросит этот пароль, не отображая его; скопируйте полученную строку `$argon2id$...` и результат `npm run auth:secret` в `.env`:

```dotenv
AUTH_PASSWORD_HASH='$argon2id$v=19$...'
SESSION_SECRET=64-шестнадцатеричных-символа
SESSION_TTL_SECONDS=86400
```

Сохраните одинарные кавычки вокруг `AUTH_PASSWORD_HASH`: они не дают Docker Compose интерпретировать символы `$`. Не добавляйте заполненный `.env` в Git. Изменение `SESSION_SECRET` завершает все действующие сессии. Новый хеш пароля применяется после перезапуска приложения.

Альтернативные команды генерации `SESSION_SECRET`:

```bash
openssl rand -hex 32
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Альтернативные команды генерации случайного пароля:

```bash
openssl rand -base64 24
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

## Локальная разработка

```bash
npm install
export AUTH_PASSWORD_HASH='$argon2id$v=19$...'
export SESSION_SECRET='64-шестнадцатеричных-символа'
npm run dev
```

Vite запускается на `http://localhost:5173` и проксирует `/api` в Fastify на `http://localhost:8080`. Локальный процесс API должен иметь доступ к `/var/run/docker.sock`.

При локальном запуске статистика хранится в `./data/traffic.sqlite`; этот каталог игнорируется Git.

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

Compose читает параметры авторизации из `.env` и по умолчанию публикует приложение на порту хоста `8080`. Внешний порт можно изменить через `HOST_PORT`, например `HOST_PORT=8081 docker compose up -d --build`. `PORT` задаёт порт, который Fastify слушает внутри контейнера, а `HOST_PORT` — соответствующий порт на хосте. По умолчанию обе переменные равны `8080`. Контейнер `amnezia-awg2` не входит в этот compose-проект и продолжает управляться отдельно.

В production session cookie всегда имеет флаг `Secure`, поэтому открывайте панель через HTTPS-домен. Прямой HTTP-доступ к опубликованному порту подходит для диагностики `/api/health`, но не сможет поддерживать production-сессию.

Счётчики трафика хранятся в именованном volume `traffic-data` и сохраняются при пересборке контейнера и обычном `docker compose down`. Команда `docker compose down -v` удалит накопленную статистику.

Для остановки:

```bash
docker compose down
```

## Переменные окружения

| Переменная                   |            По умолчанию | Назначение                                    |
| ---------------------------- | ----------------------: | --------------------------------------------- |
| `PORT`                       |                  `8080` | Внутренний HTTP-порт Fastify                  |
| `HOST_PORT`                  |                  `8080` | Порт Docker-host, публикуемый Compose         |
| `AUTH_PASSWORD_HASH`         |           _обязательно_ | Argon2id-хеш единого пароля панели            |
| `SESSION_SECRET`             |           _обязательно_ | Ключ подписи сессии: 32 байта, 64 hex-символа |
| `SESSION_TTL_SECONDS`        |                 `86400` | Время жизни авторизованной сессии в секундах  |
| `AMNEZIA_CONTAINER`          |          `amnezia-awg2` | Имя существующего контейнера                  |
| `AMNEZIA_INTERFACE`          |                  `awg0` | Имя AWG-интерфейса                            |
| `ONLINE_THRESHOLD_SECONDS`   |                   `180` | Максимальный возраст handshake для online     |
| `CACHE_TTL_MS`               |                  `3000` | Время жизни snapshot в памяти                 |
| `TRAFFIC_SAMPLE_INTERVAL_MS` |                  `5000` | Интервал фонового опроса трафика              |
| `TRAFFIC_DB_PATH`            | `./data/traffic.sqlite` | Путь к SQLite-файлу статистики                |
| `TZ`                         |         `Europe/Moscow` | Часовой пояс для границ дня и месяца          |
| `NODE_ENV`                   |           `development` | В `production` включает раздачу React-сборки  |

Пример находится в `.env.example`. Не передавайте эти значения через публичные HTTP-параметры.

## API

- `GET /api/health` — проверка HTTP-приложения;
- `GET /api/auth/session` — состояние авторизации текущей подписанной сессии;
- `POST /api/auth/login` — проверка пароля и создание сессии;
- `POST /api/auth/logout` — удаление текущей сессии;
- `GET /api/clients` — текущий объединённый snapshot клиентов с дневным и месячным download.
- `GET /api/stats` — нагрузка контейнера на процессор, его аптайм, текущие скорости download/upload и общий трафик за день.

Все API-маршруты, кроме health, входа и проверки состояния сессии, требуют действительную сессию и иначе отвечают `401`. Допускается не более пяти попыток входа в минуту. Панель обновляет данные клиентов и статистику контейнера каждые 5 секунд. При недоступности socket, контейнера, команды или повреждённых данных `/api/clients` и `/api/stats` отвечают `503` и безопасным JSON без stack trace. `/api/health` проверяет только готовность самого dashboard и не обращается к AmneziaWG.

## Безопасность Docker socket

Docker socket фактически предоставляет высокие привилегии на host. Суффикс `:ro` защищает точку монтирования как файл, но **не делает Docker API доступным только для чтения**. Основная защита здесь архитектурная:

- нет универсального Docker proxy или endpoint выполнения команд;
- API данных принимает только `GET` и не принимает Docker-команды; API авторизации только создаёт или удаляет подписанную сессию;
- backend содержит только два фиксированных вызова Docker Exec;
- отсутствуют `child_process`, Docker CLI, `eval` и операции start/stop/remove/create;
- файловая система dashboard-контейнера работает в режиме read-only, кроме отдельного volume `/app/data` для статистики;
- ответы и обычные логи не содержат endpoint-список клиентов.

Размещайте dashboard только в доверенной среде и используйте HTTPS через Dokploy/Traefik. Встроенная парольная авторизация защищает данные панели, но не уменьшает привилегии, предоставленные Docker socket.

## Dokploy

1. Создайте в Dokploy Compose-приложение из этого репозитория.
2. Выполните deployment с `docker-compose.yml` из корня.
3. Добавьте домен к сервису `vpn-dashboard`.
4. Укажите `Container Port` равным `8080` и HTTP-протокол.
5. Включите HTTPS для домена: production-cookie авторизации не передаётся по обычному HTTP.
6. Откройте домен, войдите и убедитесь, что панель загружается.
7. При необходимости отдельно проверьте `/api/health` для диагностики deployment.

Публикация `HOST_PORT` полезна для самостоятельного запуска и не мешает маршрутизации Dokploy на внутренний `PORT`, который по умолчанию равен `8080`. Если значение `PORT` изменено, укажите тот же container port в Dokploy. Если политика конкретного сервера запрещает публикацию host-портов, удалите секцию `ports` в локальном override-файле Compose.

## Диагностика

Посмотреть состояние и логи:

```bash
docker compose ps
docker compose logs -f vpn-dashboard
docker ps --filter name=amnezia-awg2
```

Проверить публичный health endpoint с Docker-host:

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
