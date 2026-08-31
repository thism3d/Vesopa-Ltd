sudo su
wget https://vesopaepos.com/app/vesopa-hestia-install.sh

bash vesopa-hestia-install.sh \
  --hostname 'hosting2.vesopa.com' \
  --username 'vesopa' \
  --email 'muzahid@vesopa.com' \
  --password 'YOUR-PASSWORD' \
  --port '2083' \
  --multiphp '7.4,8.3' \
  --vsftpd no \
  --proftpd yes \
  --postgresql yes \
  --sieve yes \
  --quota yes \
  --webterminal yes \
  --interactive no \
  --force

reboot
