<div align="center">
  <img src="public/muse.svg" alt="Muse" width="76" height="76" />
  <h1>Muse</h1>
  <p>为 Hermes Agent 打造的本地优先 Web 对话界面。</p>
  <p><a href="README.md">English</a></p>
</div>

Muse 为 Hermes 提供简洁、适配移动设备的聊天界面，支持保存对话、流式回复、工具授权提示和可选的本地语音。应用运行在自己的设备上，通过 Agent Client Protocol（ACP）连接 Hermes。

## 功能

- 响应式 Vue 界面，可安装为 PWA。
- 对话记录保存在当前浏览器的本地存储中。
- 实时回复、停止当前轮次，并显示工具活动。
- Hermes 请求执行操作时显示授权提示。
- 可选接入本地 FunASR 语音识别与 CosyVoice 流式语音合成。

## 环境要求

- Node.js 22.12 或更新版本。
- 在同一台设备上安装并配置 [Hermes Agent](https://github.com/NousResearch/hermes-agent)。
- 语音功能需要 macOS、Python 3.10，以及 [`voice-stack/README.md`](voice-stack/README.md) 中介绍的本地语音服务。

## 快速开始

```sh
git clone https://github.com/vancezhong/muse-hermes.git
cd muse-hermes
npm install
npm run dev
```

打开 Vite 输出的本地地址。Muse 默认启动 Hermes 的 `default` profile。需要使用其他 profile 时，在启动前设置 `HERMES_PROFILE`：

```sh
HERMES_PROFILE=work npm run dev
```

启动生产模式的本地服务器：

```sh
npm run build
npm start
```

生产服务器默认只监听本机地址 `127.0.0.1`，并从 `dist/` 提供构建文件。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HERMES_BIN` | `hermes` | Hermes 可执行文件路径 |
| `HERMES_PROFILE` | `default` | 要启动的 Hermes profile |
| `MUSE_HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `4173` | HTTP 端口 |
| `MUSE_HTTPS_PORT` | `4174` | 启用 TLS 时使用的 HTTPS 端口 |
| `MUSE_TLS_CERT` | — | TLS 证书路径 |
| `MUSE_TLS_KEY` | — | 对应的私钥路径 |

启用 HTTPS 时需要同时设置两个 TLS 变量。脚本 [`voice-stack/create-lan-certificate-macos.sh`](voice-stack/create-lan-certificate-macos.sh) 可为受信任的局域网设备创建本地证书。

## 隐私与网络访问

项目不包含模型凭据。Hermes 会在本机管理 profile、模型服务配置和身份验证信息。对话记录保存在当前浏览器的本地存储中。语音数据会发送到所配置的识别和合成服务；默认情况下，这两项服务都使用本机回环地址。

服务器默认只监听本机。设置 `MUSE_HOST=0.0.0.0` 后，局域网内的其他设备也可以访问。Muse 没有用户登录功能，请只在可信网络中开启局域网访问。远程设备的浏览器还需要 HTTPS 才能使用麦克风。

不要提交 `.env` 文件、Hermes profile 数据、TLS 私钥、模型权重或构建产物。它们已列入 [`.gitignore`](.gitignore)。

## 许可证

Muse 使用 [MIT 许可证](LICENSE)发布。
