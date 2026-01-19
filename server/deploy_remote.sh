#!/usr/bin/env bash
# Usage: ./deploy_remote.sh user@host:/path
set -euo pipefail
if [ "$#" -lt 1 ]; then
  echo "Usage: $0 user@host:/target/path [ssh_opts]"
  exit 2
fi
TARGET=$1
shift
SSH_OPTS="$@"
echo "Deploying remote_proxy to ${TARGET}"
TMPDIR=$(mktemp -d)
cp -r server remote_proxy_package || true
tar -C . -czf ${TMPDIR}/remote_proxy.tar.gz server package.json package-lock.json || tar -C server -czf ${TMPDIR}/remote_proxy.tar.gz .
scp ${SSH_OPTS} ${TMPDIR}/remote_proxy.tar.gz ${TARGET}
ssh ${SSH_OPTS} ${TARGET%:*} "mkdir -p ${TARGET#*:} && tar -xzf ${TARGET#*:}/remote_proxy.tar.gz -C ${TARGET#*:} || true"
echo "Deployed. On remote host: cd ${TARGET#*:} && npm install && node server/remote_proxy.js &"
rm -rf ${TMPDIR}
