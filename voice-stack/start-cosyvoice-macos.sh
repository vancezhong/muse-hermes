#!/usr/bin/env bash
set -euo pipefail

MUSE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_HOME="${MUSE_VOICE_HOME:-$HOME/.local/share/muse}"
COSYVOICE_ROOT="${COSYVOICE_ROOT:-$VOICE_HOME/CosyVoice}"
COSYVOICE_PYTHON="${COSYVOICE_PYTHON:-$VOICE_HOME/venv-cosyvoice/bin/python}"
COSYVOICE_MODEL_DIR="${COSYVOICE_MODEL_DIR:-$COSYVOICE_ROOT/pretrained_models/CosyVoice-300M-SFT}"

if [[ ! -x "$COSYVOICE_PYTHON" || ! -f "$COSYVOICE_ROOT/cosyvoice/cli/cosyvoice.py" ]]; then
  echo "CosyVoice is not installed. Follow $MUSE_ROOT/voice-stack/README.md first." >&2
  exit 1
fi
if [[ ! -f "$COSYVOICE_MODEL_DIR/cosyvoice.yaml" ]]; then
  echo "CosyVoice model is missing. Download iic/CosyVoice-300M-SFT as described in $MUSE_ROOT/voice-stack/README.md." >&2
  exit 1
fi

cd "$COSYVOICE_ROOT"
export COSYVOICE_ROOT
exec "$COSYVOICE_PYTHON" "$MUSE_ROOT/voice-stack/cosyvoice_stream_server.py" --model-dir "$COSYVOICE_MODEL_DIR"
