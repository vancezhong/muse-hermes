# Local voice services

Muse can connect to a local FunASR service for streaming speech recognition and a local CosyVoice service for speech synthesis. The model weights and upstream projects are installed separately; they are not part of this repository.

By default, Muse connects to FunASR at `ws://127.0.0.1:10095` and CosyVoice at `http://127.0.0.1:50000`. Microphone audio is sent to the configured ASR endpoint. Assistant replies are sent to the configured TTS endpoint. Both endpoints can be changed with `FUNASR_URL` and `COSYVOICE_URL`.

The included launch scripts target macOS with Python 3.10. Run the installation commands below from the Muse repository root. They place model code, virtual environments, and downloaded weights under `~/.local/share/muse`, outside the repository.

## FunASR

Install the runtime and dependencies:

```sh
PROJECT_DIR="$PWD"
VOICE_HOME="${MUSE_VOICE_HOME:-$HOME/.local/share/muse}"
mkdir -p "$VOICE_HOME"

git clone --depth 1 https://github.com/modelscope/FunASR.git "$VOICE_HOME/FunASR"
python3.10 -m venv "$VOICE_HOME/venv-funasr"
source "$VOICE_HOME/venv-funasr/bin/activate"
python -m pip install --upgrade pip
python -m pip install -r "$PROJECT_DIR/voice-stack/requirements-funasr-macos.txt"
```

In a separate terminal, from the Muse repository root, start the service:

```sh
./voice-stack/start-funasr-macos.sh
```

The script binds the WebSocket service to loopback and uses CPU inference.

## CosyVoice

Install the runtime, dependencies, and model weights:

```sh
PROJECT_DIR="$PWD"
VOICE_HOME="${MUSE_VOICE_HOME:-$HOME/.local/share/muse}"
mkdir -p "$VOICE_HOME"

git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git "$VOICE_HOME/CosyVoice"
cd "$VOICE_HOME/CosyVoice"
git submodule update --init --recursive
python3.10 -m venv "$VOICE_HOME/venv-cosyvoice"
source "$VOICE_HOME/venv-cosyvoice/bin/activate"
python -m pip install --upgrade pip
python -m pip install -r "$PROJECT_DIR/voice-stack/requirements-cosyvoice-mac.txt"
python -m pip install --no-build-isolation --no-deps "openai-whisper==20250625"
python -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice-300M-SFT', local_dir='pretrained_models/CosyVoice-300M-SFT', ignore_patterns=['*.zip', 'flow.decoder.estimator.fp32.onnx'])"
```

In another terminal, from the Muse repository root, start the adapter:

```sh
./voice-stack/start-cosyvoice-macos.sh
```

The default speaker is `中文女`. Set `COSYVOICE_SPEAKER` to a speaker ID returned by the service's `/health` endpoint if that speaker is unavailable in your model.

## Start Muse

With both voice services running, start Muse in another terminal:

```sh
npm run dev
```

Open the local Vite URL and select **语音聊天**. Muse checks the voice services before opening a session. Stopping Muse does not stop the separate model services; stop each one in its own terminal.

## Remote devices and HTTPS

Browsers require a secure context to use a microphone from another device. To create a local certificate pair on macOS:

```sh
./voice-stack/create-lan-certificate-macos.sh
```

Install and trust the generated `ca.crt` on each client device. On iOS, enable full trust for the installed root certificate in **Settings → General → About → Certificate Trust Settings**. Start Muse with the generated server certificate and private key:

```sh
export MUSE_TLS_CERT="$HOME/.local/share/muse/tls/server.crt"
export MUSE_TLS_KEY="$HOME/.local/share/muse/tls/server.key"
MUSE_HOST=0.0.0.0 npm start
```

Muse serves HTTP on port `4173` and HTTPS on port `4174` by default. Protect the private key and only enable network access on a trusted network. The certificate script refuses to overwrite existing certificate files.

## Service settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUSE_VOICE_HOME` | `~/.local/share/muse` | Location of local voice runtimes and environments |
| `FUNASR_URL` | `ws://127.0.0.1:10095` | FunASR WebSocket endpoint |
| `COSYVOICE_URL` | `http://127.0.0.1:50000` | CosyVoice HTTP endpoint |
| `COSYVOICE_TTS_PATH` | `/stream/inference_sft` | Streaming TTS route |
| `COSYVOICE_SPEAKER` | `中文女` | Speaker ID passed to CosyVoice |
| `COSYVOICE_SAMPLE_RATE` | `22050` | Fallback sample rate when the service omits it |

FunASR, CosyVoice, and their model weights are third-party components. Review their upstream licenses and model terms before use or redistribution: [FunASR](https://github.com/modelscope/FunASR) and [CosyVoice](https://github.com/FunAudioLLM/CosyVoice).
