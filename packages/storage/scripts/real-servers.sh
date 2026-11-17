#!/usr/bin/env bash
# Start real storage servers for test/integration and packages/sync/test/real-servers.test.ts
# (Ubuntu, as root; also used by the CI job "storage (real servers)").
# Then: TL_REAL_SERVERS=1 npx vitest run test/integration
#
#   Apache httpd mod_dav  http://127.0.0.1:8081/dav/  (public read: /pub/)
#                         /full/  same, on a 1 MiB tmpfs: a real "507 Insufficient Storage"
#                         /small/ same, with LimitRequestBody 4096: a real "413"
#   WsgiDAV               http://127.0.0.1:8082/dav/
#   moto server (S3 API)  http://127.0.0.1:5005
#   OpenSSH sftp          127.0.0.1:2222
# Every server uses the account alice / s3cret. Safe to run twice.
set -euo pipefail
PIP=${PIP:-pip}
if ! command -v apache2 >/dev/null || ! command -v htpasswd >/dev/null || [ ! -x /usr/sbin/sshd ]; then
  apt-get update -q >/dev/null
  apt-get install -y -q apache2 apache2-utils openssh-server >/dev/null
fi
# Versions the results in README.md were obtained with.
"$PIP" install --break-system-packages -q "moto[server]==5.2.5" "wsgidav==4.4.1" "cheroot==11.1.2"
W=/srv/tl; mkdir -p $W/apache $W/wsgi $W/lock $W/full $W/small
mountpoint -q $W/full || mount -t tmpfs -o size=1m tmpfs $W/full
chown -R www-data:www-data $W/apache $W/lock $W/full $W/small
a2enmod -q dav dav_fs auth_basic alias >/dev/null
htpasswd -bc /etc/apache2/tl.htpasswd alice s3cret >/dev/null
cat > /etc/apache2/sites-available/tl.conf <<'CONF'
Listen 8081
DavLockDB /srv/tl/lock/DavLock
<VirtualHost 127.0.0.1:8081>
  Alias /dav /srv/tl/apache
  Alias /pub /srv/tl/apache
  Alias /full /srv/tl/full
  Alias /small /srv/tl/small
  <Location /dav>
    Dav On
    AuthType Basic
    AuthName "dav"
    AuthUserFile /etc/apache2/tl.htpasswd
    Require valid-user
  </Location>
  <Location /full>
    Dav On
    AuthType Basic
    AuthName "dav"
    AuthUserFile /etc/apache2/tl.htpasswd
    Require valid-user
  </Location>
  <Location /small>
    Dav On
    AuthType Basic
    AuthName "dav"
    AuthUserFile /etc/apache2/tl.htpasswd
    Require valid-user
    LimitRequestBody 4096
  </Location>
  <Location /pub>
    Require all granted
  </Location>
</VirtualHost>
CONF
a2ensite -q tl >/dev/null; sed -i 's/^Listen 80$/#Listen 80/' /etc/apache2/ports.conf
apachectl -k graceful 2>/dev/null || apachectl start
cat > $W/wsgidav.yaml <<'CONF'
host: 127.0.0.1
port: 8082
provider_mapping: {"/dav": "/srv/tl/wsgi"}
http_authenticator: {domain_controller: null, accept_basic: true, accept_digest: false, default_to_digest: false}
simple_dc: {user_mapping: {"*": {"alice": {password: "s3cret"}}}}
CONF
pgrep -f "wsgidav --config" >/dev/null || nohup wsgidav --config $W/wsgidav.yaml >/tmp/wsgidav.log 2>&1 &
pgrep -f "moto_server" >/dev/null || nohup moto_server -H 127.0.0.1 -p 5005 >/tmp/moto.log 2>&1 &
id alice >/dev/null 2>&1 || useradd -m alice; echo alice:s3cret | chpasswd
mkdir -p /run/sshd; ssh-keygen -A >/dev/null
printf 'Port 2222\nListenAddress 127.0.0.1\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM yes\nSubsystem sftp internal-sftp\nPidFile /run/sshd_tl.pid\n' > /etc/ssh/sshd_tl.conf
[ -f /run/sshd_tl.pid ] && kill -0 "$(cat /run/sshd_tl.pid)" 2>/dev/null || /usr/sbin/sshd -f /etc/ssh/sshd_tl.conf
# Wait until every server answers.
for i in $(seq 1 60); do
  if curl -s -o /dev/null http://127.0.0.1:8081/pub/ && curl -s -o /dev/null http://127.0.0.1:8082/ \
    && curl -s -o /dev/null http://127.0.0.1:5005/ && (exec 3<>/dev/tcp/127.0.0.1/2222) 2>/dev/null; then
    echo "real servers ready"; exit 0
  fi
  sleep 1
done
echo "real servers did not start" >&2; tail -n 20 /tmp/wsgidav.log /tmp/moto.log >&2 || true; exit 1
