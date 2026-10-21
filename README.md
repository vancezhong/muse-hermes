<div align="center">
  <img src="public/muse.svg" alt="Muse" width="76" height="76" />
  <h1>Muse</h1>
  <p>A local-first web client for Hermes Agent.</p>
  <p><a href="README.zh-CN.md">简体中文</a></p>
</div>

Muse gives Hermes a focused, responsive chat interface with saved conversations, streamed replies, permission prompts, and optional local speech. It runs on your machine and connects to Hermes through the Agent Client Protocol (ACP).

## Features

- Responsive Vue app that can be installed as a PWA.
- Conversation history stored in the browser's local storage.
- Live replies, turn cancellation, and visible tool activity.
- Permission prompts for actions requested by Hermes.
- Optional streaming speech recognition and synthesis with local FunASR and CosyVoice services.

## Requirements

- Node.js 22.12 or newer.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed and configured on the same machine.
- For speech features: macOS, Python 3.10, and the local voice services described in [`voice-stack/README.md`](voice-stack/README.md).

## Getting started

```sh
git clone https://github.com/vancezhong/muse-hermes.git
cd muse-hermes
npm install
npm run dev
```

Open the local URL printed by Vite. Muse starts Hermes with the `default` profile. To use another profile, set `HERMES_PROFILE` before starting Muse:

```sh
HERMES_PROFILE=work npm run dev
```

For a production-style local server:

```sh
npm run build
npm start
```

The production server binds to `127.0.0.1` by default and serves the build from `dist/`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HERMES_BIN` | `hermes` | Hermes executable path |
| `HERMES_PROFILE` | `default` | Hermes profile to launch |
| `MUSE_HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `4173` | HTTP port |
| `MUSE_HTTPS_PORT` | `4174` | HTTPS port when TLS is enabled |
| `MUSE_TLS_CERT` | — | Path to a TLS certificate |
| `MUSE_TLS_KEY` | — | Path to its private key |

Set both TLS variables to enable HTTPS. The helper [`voice-stack/create-lan-certificate-macos.sh`](voice-stack/create-lan-certificate-macos.sh) creates local certificates for trusted devices on your network.

## Privacy and network access

Muse includes no model credentials. Hermes keeps its profile, provider configuration, and authentication on your machine. Conversation history is saved in the current browser's local storage. Speech audio is sent to the configured recognition and synthesis services; by default, both services use loopback addresses.

The server listens only on the local machine by default. Setting `MUSE_HOST=0.0.0.0` makes it reachable from other devices on the network. Muse has no user login, so only enable network access on a network you trust. A remote browser also needs HTTPS to use its microphone.

Do not commit `.env` files, Hermes profile data, TLS keys, model weights, or generated build output. These files are covered by [`.gitignore`](.gitignore).

## License

Muse is released under the [MIT License](LICENSE).
