#!/usr/bin/env bash
# Start real storage servers for test/integration (Ubuntu, as root).
# Then: TL_REAL_SERVERS=1 npx vitest run test/integration
set -euo pipefail
apt-get install -y -q apache2 openssh-server >/dev/null
pip install --break-system-packages -q "moto[server]" wsgidav cheroot
W=/srv/tl; mkdir -p $W/apache $W/wsgi $W/lock; chown -R www-data:www-data $W/apache $W/lock
a2enmod -q dav dav_fs auth_basic >/dev/null
htpasswd -bc /etc/apache2/tl.htpasswd alice s3cret >/dev/null
cat > /etc/apache2/sites-available/tl.conf <<'CONF'
Listen 8081
DavLockDB /srv/tl/lock/DavLock
<VirtualHost 127.0.0.1:8081>
  Alias /dav /srv/tl/apache
  Alias /pub /srv/tl/apache
  <Location /dav>
    Dav On
    AuthType Basic
    AuthName "dav"
    AuthUserFile /etc/apache2/tl.htpasswd
    Require valid-user
  </Location>
  <Location /pub>
    Require all granted
  </Location>
</VirtualHost>
CONF
a2ensite -q tl >/dev/null; sed -i 's/^Listen 80$/#Listen 80/' /etc/apache2/ports.conf; apachectl start || apachectl restart
cat > $W/wsgidav.yaml <<'CONF'
host: 127.0.0.1
port: 8082
provider_mapping: {"/dav": "/srv/tl/wsgi"}
http_authenticator: {domain_controller: null, accept_basic: true, accept_digest: false, default_to_digest: false}
simple_dc: {user_mapping: {"*": {"alice": {password: "s3cret"}}}}
CONF
nohup wsgidav --config $W/wsgidav.yaml >/tmp/wsgidav.log 2>&1 &
nohup moto_server -H 127.0.0.1 -p 5005 >/tmp/moto.log 2>&1 &
id alice >/dev/null 2>&1 || useradd -m alice; echo alice:s3cret | chpasswd
mkdir -p /run/sshd; ssh-keygen -A >/dev/null
printf 'Port 2222\nListenAddress 127.0.0.1\nPasswordAuthentication yes\nUsePAM yes\nSubsystem sftp internal-sftp\nPidFile /run/sshd_tl.pid\n' > /etc/ssh/sshd_tl.conf
/usr/sbin/sshd -f /etc/ssh/sshd_tl.conf
