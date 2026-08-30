#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""NEON://SNAKE — обход блокировки Telegram на РФ-VPS (Cloudflare WARP).

  python deploy/deploy-warp.py --host <IP> --port 2222 --user root --password '...'

Что делает (всё ДОБАВЛЯЕТСЯ, чужие сервисы не затрагиваются):
  1. Ставит официальный пакет cloudflare-warp (apt-репозиторий Cloudflare)
  2. Режим proxy: SOCKS5 на 127.0.0.1:40000 — маршрутизация и DNS
     сервера НЕ меняются, ваши сайты работают как раньше
  3. Проверяет доступность api.telegram.org через прокси
  4. socat-рельса 172.17.0.1:40001 → 127.0.0.1:40000 (отдельный
     systemd-юнит neon-warp-relay), чтобы контейнер бота достучался
     до прокси; наружу рельса не торчит
  5. Обновляет bot.js + compose (extra_hosts) + .env и перезапускает
     контейнер игры — бот уходит в цикл getUpdates через WARP

Откат (если когда-нибудь понадобится):
  systemctl disable --now warp-svc neon-warp-relay && apt remove -y cloudflare-warp socat
"""
import argparse
import base64
import posixpath
import sys
import time

try:
    import paramiko
except ImportError:
    print('Нужен paramiko: pip install paramiko')
    sys.exit(1)

REMOTE_DIR = '/opt/neon-snake'
RELAY_PORT = 40001            # порт рельсы на docker0
WARP_PORT = 40000             # стандартный порт WARP-прокси

RELAY_UNIT = """[Unit]
Description=NEON://SNAKE — релея к WARP-прокси для бота (только docker0)
After=network.target warp-svc.service

[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:{port},bind={bind},fork,reuseaddr TCP:127.0.0.1:{warp}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""


def log(m):
    print('[warp] ' + m)
    sys.stdout.flush()


def sh(ssh, cmd, timeout=600, check=True):
    _, o, e = ssh.exec_command(cmd, timeout=timeout)
    code = o.channel.recv_exit_status()
    out = o.read().decode('utf-8', 'replace').strip()
    err = e.read().decode('utf-8', 'replace').strip()
    if check and code != 0:
        raise RuntimeError('провал (%d): %s\n%s' % (code, cmd, (out + err)[-800:]))
    return code, (out + ('\n' + err if err else '')).strip()


def q(s):
    return "'" + s.replace("'", "'\\''") + "'"


def write_remote(ssh, path, content):
    b64 = base64.b64encode(content.encode('utf-8')).decode('ascii')
    sh(ssh, 'mkdir -p %s && echo %s | base64 -d > %s'
       % (q(posixpath.dirname(path)), b64, q(path)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', required=True)
    ap.add_argument('--port', type=int, default=2222)
    ap.add_argument('--user', default='root')
    ap.add_argument('--password', required=True)
    args = ap.parse_args()

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    log('SSH %s@%s:%d …' % (args.user, args.host, args.port))
    ssh.connect(args.host, port=args.port, username=args.user,
                password=args.password, timeout=20,
                look_for_keys=False, allow_agent=False)

    # ---------- 1. пакет cloudflare-warp ----------
    code, out = sh(ssh, 'warp-cli --version 2>/dev/null', check=False)
    if code == 0 and out:
        log('WARP уже стоит: ' + out)
    else:
        log('ставлю cloudflare-warp (официальный apt-репозиторий)…')
        sh(ssh, 'apt-get install -y curl gpg lsb-release >/dev/null 2>&1 || true')
        sh(ssh, 'curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg '
                '| gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg')
        code, codename = sh(ssh, 'lsb_release -cs')
        sh(ssh, 'echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] '
                'https://pkg.cloudflareclient.com/ %s main" > /etc/apt/sources.list.d/cloudflare-client.list' % codename)
        sh(ssh, 'apt-get update -o Acquire::Retries=3 >/dev/null 2>&1 && apt-get install -y cloudflare-warp', timeout=900)
        log('пакет установлен')

    # ---------- 2. регистрация + режим proxy ----------
    code, out = sh(ssh, 'warp-cli --accept-tos registration show 2>/dev/null || warp-cli --accept-tos account show 2>/dev/null', check=False)
    if 'Status' in out or 'Account' in out or 'status' in out.lower():
        log('регистрация есть')
    else:
        code, out = sh(ssh, 'warp-cli --accept-tos registration new 2>&1 || warp-cli --accept-tos register 2>&1', check=False)
        log('регистрация: ' + out[-200:])
    sh(ssh, 'warp-cli --accept-tos mode proxy 2>&1 || true')
    sh(ssh, 'warp-cli --accept-tos connect 2>&1 || true')
    time.sleep(4)
    code, out = sh(ssh, 'warp-cli --accept-tos status 2>/dev/null || warp-cli --accept-tos account 2>/dev/null', check=False)
    log('статус WARP: ' + out[:120])

    # ---------- 3. доступность Telegram через прокси ----------
    log('проверяю api.telegram.org через WARP (до 20 с)…')
    ok_telegram = False
    for attempt in range(4):
        code, out = sh(ssh, 'curl -s --socks5-hostname 127.0.0.1:%d -o /dev/null -w "%%{http_code}" -m 8 https://api.telegram.org/' % WARP_PORT, check=False)
        log('  попытка %d: HTTP %s' % (attempt + 1, out))
        if out and out not in ('000', ''):
            ok_telegram = True
            break
        time.sleep(5)
    if not ok_telegram:
        raise RuntimeError('через WARP Telegram так и недоступен — смотрите warp-cli status')

    # ---------- 4. socat-рельса на docker0 ----------
    code, gw = sh(ssh, "ip -4 addr show docker0 | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}'", check=False)
    if not gw:
        raise RuntimeError('не нашёл IP docker0')
    log('docker0 = ' + gw)
    sh(ssh, 'dpkg -s socat >/dev/null 2>&1 || apt-get install -y socat', timeout=300)
    write_remote(ssh, '/etc/systemd/system/neon-warp-relay.service',
                 RELAY_UNIT.format(port=RELAY_PORT, warp=WARP_PORT, bind=gw))
    sh(ssh, 'systemctl daemon-reload && systemctl enable --now neon-warp-relay')
    time.sleep(2)
    code, out = sh(ssh, 'ss -tln | grep ":%d "' % RELAY_PORT, check=False)
    log('рельеса слушает: ' + (out[:100] or 'НЕТ!'))
    if not out:
        raise RuntimeError('рельеса не поднялась')

    # ---------- 5. обновление контейнера ----------
    log('обновляю bot.js/compose/.env и перезапускаю контейнер…')
    sftp = ssh.open_sftp()

    def up(local, remote):
        import os
        rdir = posixpath.dirname(remote)
        parts = rdir.strip('/').split('/')
        cur = ''
        for p in parts:
            cur += '/' + p
            try:
                sftp.stat(cur)
            except FileNotFoundError:
                sftp.mkdir(cur)
        sftp.put(local, remote)
        log('  + ' + remote)

    up('server/bot.js', REMOTE_DIR + '/server/bot.js')
    up('docker-compose.vps.yml', REMOTE_DIR + '/docker-compose.vps.yml')
    sftp.close()
    code, env = sh(ssh, 'cat %s/.env' % REMOTE_DIR)
    env = env.replace('WARP_PROXY_HOST=host.docker.internal\n', '') \
             .replace('WARP_PROXY_PORT=%d\n' % RELAY_PORT, '')
    env += '\nWARP_PROXY_HOST=host.docker.internal\nWARP_PROXY_PORT=%d\n' % RELAY_PORT
    write_remote(ssh, REMOTE_DIR + '/.env', env)
    sh(ssh, 'chmod 600 %s/.env' % REMOTE_DIR)
    sh(ssh, 'cd %s && docker compose -f docker-compose.vps.yml up -d --build' % REMOTE_DIR, timeout=900)

    # ---------- 6. проверка бота ----------
    log('жду логи бота…')
    time.sleep(6)
    code, out = sh(ssh, 'cd %s && docker compose -f docker-compose.vps.yml logs game --since 2m 2>&1 | grep -i "bot" | tail -8' % REMOTE_DIR, check=False)
    log('логи: ' + out.replace('\n', ' | ') or '(пусто)')
    code, out = sh(ssh, 'TOKEN=$(grep ^BOT_TOKEN %s/.env | cut -d= -f2); '
                        'curl -s --socks5-hostname 127.0.0.1:%d https://api.telegram.org/bot$TOKEN/getMe -m 10' % (REMOTE_DIR, WARP_PORT), check=False)
    ok_me = '"ok":true' in out.replace(' ', '')
    log('getMe через WARP: ' + ('OK — бот жив' if ok_me else out[:200]))

    log('========================================')
    log('ГОТОВО' + ('' if ok_me else ' (но проверьте логи)'))
    ssh.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('\n[warp] ОСТАНОВЛЕНО: %s' % e)
        sys.exit(1)
