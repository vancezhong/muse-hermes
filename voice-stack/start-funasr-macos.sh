#!/usr/bin/env bash
set -euo pipefail

MUSE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_HOME="${MUSE_VOICE_HOME:-$HOME/.local/share/muse}"
FUNASR_REPO="${FUNASR_REPO:-$VOICE_HOME/FunASR}"
FUNASR_PYTHON="${FUNASR_PYTHON:-$VOICE_HOME/venv-funasr/bin/python}"

if [[ ! -x "$FUNASR_PYTHON" || ! -f "$FUNASR_REPO/runtime/python/websocket/funasr_wss_server.py" ]]; then
  echo "FunASR is not installed. Follow $MUSE_ROOT/voice-stack/README.md first." >&2
  exit 1
fi

exec "$FUNASR_PYTHON" "$FUNASR_REPO/runtime/python/websocket/funasr_wss_server.py" \
  --host 127.0.0.1 --port 10095 --ngpu 0 --device cpu --ncpu 8 \
  --worker_threads 8 --concurrent_vad 1 --concurrent_asr_online 1 \
  --concurrent_asr_offline 1 --concurrent_punc 1 --concurrent_sv 1 \
  --certfile "" --keyfile ""
