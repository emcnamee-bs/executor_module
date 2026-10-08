#!/bin/sh
# Daily: copy the last 24h of executor + iip + ollama journal output to plain files under
# logs/ and delete exported files older than 7 days. The journal itself is capped at 7 days
# by /etc/systemd/journald.conf.d/90-retention-7d.conf; these files are the grep-able copy.
set -eu
DIR="${HOME}/executor_module/logs/export"
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d)
journalctl --user --since "-24h" --no-pager -o short-iso \
  -u 'executor-module*' -u 'executor-*' -u iip > "$DIR/user-units-$STAMP.log" 2>/dev/null || true
journalctl --since "-24h" --no-pager -o short-iso -u ollama > "$DIR/ollama-$STAMP.log" 2>/dev/null || true
gzip -f "$DIR/user-units-$STAMP.log" "$DIR/ollama-$STAMP.log" 2>/dev/null || true
find "$DIR" -type f -mtime +7 -delete
