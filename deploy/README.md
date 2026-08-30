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
