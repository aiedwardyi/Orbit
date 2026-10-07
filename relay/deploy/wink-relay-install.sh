#!/usr/bin/env bash
# Runs on the relay VM, uploaded to the deploying user's home and called as
#   sudo bash wink-relay-install.sh install-key   < operator key on stdin
#   sudo bash wink-relay-install.sh install <node-version> <node-sha256>
#   sudo bash wink-relay-install.sh restart
set -euo pipefail

cmd="${1:-}"
user="${SUDO_USER:?run through sudo}"
home="$(getent passwd "$user" | cut -d: -f6)"
etc=/etc/wink-relay
opt=/opt/wink-relay

case "$cmd" in
  install-key)
    install -d -m 0755 -o root -g root "$etc"
    tmp="$(mktemp "$etc/.operator.key.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    head -c 4096 > "$tmp"
    if ! grep -q '^-----BEGIN PRIVATE KEY-----$' "$tmp"; then
      echo "install-key: stdin is not a PEM private key" >&2
      exit 1
    fi
    chmod 0400 "$tmp"
    mv -f "$tmp" "$etc/operator.key"
    trap - EXIT
    echo "operator key installed"
    ;;

  install)
    version="${2:?node version}"
    sha="${3:?node sha256}"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version" >&2; exit 1; }
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "bad sha256" >&2; exit 1; }
    tarball="$home/node-v$version-linux-x64.tar.xz"
    echo "$sha  $tarball" | sha256sum --check --quiet -
    [ -f "$etc/operator.key" ] || { echo "operator key missing: run install-key first" >&2; exit 1; }

    install -d -m 0755 "$opt" "$opt/app"
    rm -rf "$opt/node.new"
    mkdir "$opt/node.new"
    tar -xJf "$tarball" -C "$opt/node.new" --strip-components=1 --no-same-owner
    rm -rf "$opt/node.old"
    if [ -d "$opt/node" ]; then mv "$opt/node" "$opt/node.old"; fi
    mv "$opt/node.new" "$opt/node"

    install -m 0644 "$home/wink-relay.mjs" "$opt/app/wink-relay.mjs"
    install -d -m 0755 "$etc"
    install -m 0644 "$home/wink-relay.config.json" "$etc/config.json"
    [ -f "$etc/revoked-labels" ] || install -m 0644 /dev/null "$etc/revoked-labels"
    install -m 0644 "$home/wink-relay.service" /etc/systemd/system/wink-relay.service

    install -d -m 0755 /etc/systemd/journald.conf.d
    printf '[Journal]\nMaxRetentionSec=7day\n' > /etc/systemd/journald.conf.d/wink-relay.conf
    systemctl restart systemd-journald

    systemctl daemon-reload
    systemctl enable wink-relay.service
    systemctl restart wink-relay.service
    rm -f "$home/wink-relay.mjs" "$home/wink-relay.config.json" "$home/wink-relay.service" "$tarball"
    systemctl --no-pager --lines=0 status wink-relay.service
    ;;

  restart)
    systemctl restart wink-relay.service
    ;;

  *)
    echo "usage: wink-relay-install.sh install-key|install <version> <sha256>|restart" >&2
    exit 2
    ;;
esac
