# Deploy на VPS (Ubuntu + Docker)

Сервер игры (рекорды, дуэли, бот) живёт на вашем VPS в двух контейнерах:
`game` (Node) и `caddy` (HTTPS-прокси с авто-сертификатом Let's Encrypt).
Домен не нужен — используется `<IP>.sslip.io`.

## Развернуть (одна команда с компьютера разработчика)

```bash
python deploy/deploy.py --host <IP-АДРЕС-VPS> --user root \
  --password '<пароль>' --bot-token '<токен бота>'
```

Скрипт сам: поставит Docker (если нет), загрузит файлы в `/opt/neon-snake`,
запишет `.env` (токен только там, rights 600, в git не попадает),
поднимет контейнеры и проверит `/api/health`.

После успеха скрипт напечатает адреса для `js/config.js`:
- `apiBase: https://<ip>.sslip.io`
- `wsUrl:   wss://<ip>.sslip.io/ws`

Их нужно вписать в `js/config.js`, поднять `VERSION` в `sw.js`
и задеплоить игру на GitHub Pages — дуэли и рекорды поедут через VPS.

## Если HTTPS не поднялся

1. Проверьте, что в панели хостинга открыты порты **80 и 443** (TCP).
2. `docker compose logs caddy` на VPS — там видно выпуск сертификата.

## Обновление сервера

```bash
python deploy/deploy.py --host <IP> --user root --password '<пароль>' \
  --bot-token '<токен>' --skip-install
```

Данные (scores.json / duels.json) живут в volume `game-data` и
переживают обновление.

## Бот

Работает long polling-ом внутри контейнера `game`: вебхук не нужен,
никаких панелей. Если api.telegram.org недоступен с VPS — бот сам
повторяет попытки, игра работает независимо. Логи:
`docker compose logs game | grep bot`.

## Вариант для VPS с уже занятыми портами 80/443 (наш боевой)

На продакшн-VPS nginx уже обслуживает другие сайты — тогда Caddy не
нужен, TLS терминирует существующий nginx отдельным vhost'ом:

```bash
python deploy/deploy-nginx.py --host <IP> --port 2222 --user root   --password '<пароль>' --bot-token '<токен>' --game-port 8177
```

Скрипт НИЧЕГО чужого не трогает: контейнер слушает только
127.0.0.1:8177, добавляется один файл `sites-available/neon-snake`,
сертификат — certbot --webroot (не правит конфиги), перед reload
обязателен `nginx -t`. Боевой адрес: https://144-31-61-4.sslip.io

Известная особенность хостинга в РФ: api.telegram.org с такого VPS
недоступен (TCP режется провайдером) — бот в контейнере тихо ждёт и
переподключается, игра и дуэли работают независимо (см. docker logs).

## Боевые E2E-тесты

```bash
node server/test/run-e2e-prod.js
```

Прогоняет настоящие js/net.js + js/leaderboard.js против живого
сервера: HTTPS, рекорды, wss-комнаты, реле, обрыв соперника.
