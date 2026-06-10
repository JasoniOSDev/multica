# 接入内网自建 Multica（fork 版 + ccrcode）操作指南

> 给本地 agent 执行：把**当前这台机器**接入内网自建 Multica（devBox），注册成一个 agent runtime。
> 用 fork 源码版（带原生 `ccrcode`），与机器上已装的官方 Multica App **共存、互不影响**。
> 每一步都给了验证命令；某步失败先按「故障排查」处理，不要跳过验证。

## 已知信息

| 项 | 值 |
|---|---|
| 内网 API | `http://10.37.16.72:18081` |
| 内网 UI | `http://10.37.16.72:3000` |
| workspace | `Happy_Inhouse`（id `767b6df7-d6fe-4360-86da-5cf123329f39`）|
| 账号 | `417033420@qq.com`（无 SMTP，登录验证码是 devBox `.env` 里的 `MULTICA_DEV_VERIFICATION_CODE` 固定码）|
| fork 仓库 | `https://github.com/JasoniOSDev/multica` |
| 接入脚本 | 仓库内 `scripts/join-inhouse.sh` |

## 前提（与官方 App 共存的原则）

官方 App 自带一个 `multica`、跑自己的 daemon 连**云端**；我们要装的 fork 版是**另一个二进制**（命名为 `multica-dev`），跑独立 profile 连**内网**。两者不同二进制 / 不同 profile / 不同服务器，互不冲突。**全程只调用 `multica-dev`，不要动官方的 `multica`。**

---

## 步骤

### 0. 确认能连到内网服务器
```bash
curl -fsS -o /dev/null -w "%{http_code}\n" http://10.37.16.72:18081/health
```
期望 `200`。若不通：这台机器不在内网 / 没连 VPN，先解决网络，否则后面都白搭。

### 1. 安装 Go（fork 是源码编译，需 Go 1.26+）
```bash
# macOS
brew install go
# Linux (Debian/Ubuntu 示例，或用官方 tarball)
#   sudo snap install go --classic   # 或从 https://go.dev/dl 安装到 /usr/local/go 并加 PATH
go version          # 期望 go1.26 及以上
```

### 2. 安装 Agent CLI（至少一个；要 ccrcode 必须装 ccr）
```bash
# 至少装一个：claude / codex / openclaw（按你已有的来）
# ccrcode 需要 claude-code-router：
npm install -g @musistudio/claude-code-router
ccr code --version          # 期望输出类似 2.x.x (Claude Code)
```
> ccr 的模型路由（provider / model / API key）是它自己的配置（`~/.claude-code-router/config.json` 之类），按你现有那套配好即可——本指南不覆盖 ccr 内部配置。

### 3. 编译 fork 版 CLI，并命名为 `multica-dev`
```bash
git clone https://github.com/JasoniOSDev/multica
cd multica
make build                                  # 产物 server/bin/multica
mkdir -p ~/.local/bin
ln -sf "$PWD/server/bin/multica" ~/.local/bin/multica-dev
# 确保 ~/.local/bin 在 PATH（zsh 示例）：
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc; export PATH="$HOME/.local/bin:$PATH";; esac
multica-dev version                         # 期望 v0.3.16-ccrcode-... （带 ccrcode 的版本）
```
关键：用 `multica-dev` 这个名字，**不要**覆盖官方的 `multica`。

### 4. 拿一个 PAT（如果还没有）
浏览器开 `http://10.37.16.72:3000`，用 `417033420@qq.com` + 固定验证码登录 → 设置 → Tokens → 生成一个 Personal Access Token（`mul_...`）。已有 PAT 直接复用。

### 5. 一条命令接入
```bash
# 在 fork 仓库目录下：
bash scripts/join-inhouse.sh mul_你的PAT
```
脚本自动：优先用 `multica-dev` → 剥掉官方 App 注入的 `MULTICA_*` 环境变量 → 检查可达 → 用 PAT 登录 → 切到 Happy_Inhouse → 起 daemon → 打印 runtime 状态。

### 6. 验证
```bash
multica-dev --profile inhouse daemon status     # 期望 running
multica-dev --profile inhouse runtime list      # 期望看到 claude/codex/openclaw/ccrcode 中本机已装的，状态 online
```
再到 UI（用 `417033420@qq.com` 登录、进 `Happy_Inhouse` workspace）→ 设置 → Runtimes，应能看到这台机器的 runtime（名字带本机主机名，含一条 `ccrcode`）。

---

## 与官方 App 共存（确认无干扰）
- 调用的是 `multica-dev`（fork），官方 `multica` 原样不动、继续连云端。
- 共用的 `~/.multica/daemon.id` 不会冲突：runtime 注册带服务器维度，云端 / 内网各算各的。
- 想多台机器都接：每台重复步骤 1–6 即可，runtime 名字带各自主机名，不会混。

## 故障排查
- **`multica-dev: command not found`** → `~/.local/bin` 没进 PATH，或 symlink 没建。重做步骤 3 最后两行，`source ~/.zshrc`。
- **`make build` 报 `go: command not found` 或版本低** → Go 没装好 / 不在 PATH（步骤 1）。
- **登录/请求跑到了云端（看到 `api.multica.ai`）** → 官方 App 注入的 `MULTICA_*` 环境变量没剥。脚本已自动剥；手动跑命令时前面加 `env -u MULTICA_TOKEN -u MULTICA_SERVER_URL -u MULTICA_WORKSPACE_ID`。
- **`daemon start` 报 `not authenticated`** → 该 profile 没登录，重跑步骤 5 的 login（或脚本）。
- **`runtime list` 里没有 `ccrcode`** → 没装 `ccr`（步骤 2），或用成了官方 CLI（步骤 3 确认是 `multica-dev` 且版本号带 `ccrcode`）。
- **UI 里看不到这台机器** → 确认浏览器登录的是 `417033420@qq.com`、且在 `Happy_Inhouse` workspace（账号/workspace 选错是最常见原因）。
- **重启电脑后 runtime 掉了** → 手动起的 daemon 不会开机自启，重跑 `bash scripts/join-inhouse.sh mul_你的PAT` 即可。

## 一键参数速查
- 改服务器 / workspace：`MULTICA_INHOUSE_SERVER=... MULTICA_INHOUSE_WS=... bash scripts/join-inhouse.sh mul_PAT`
- 自定义 profile 名（默认 `inhouse`）：`bash scripts/join-inhouse.sh mul_PAT 我的profile名`
