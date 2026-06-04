# Real Setup Guide

这份文档保留“真实部署步骤”的最短路径，配置字段总表请先看仓库根目录的 `CONFIGURATION.zh-CN.md`。

## 0. 先生成并复制模板

```bash
node deploy/generate-config-examples.mjs
mkdir -p ~/RemoteAgentWorkbenchData
cp deploy/runner/runner-host.env.example ~/RemoteAgentWorkbenchData/runner-host.env
cp deploy/runner/env.production.example runner/.env.production
cp deploy/examples/projects.example.json ~/RemoteAgentWorkbenchData/projects.json
cp deploy/examples/directories.example.json ~/RemoteAgentWorkbenchData/directories.json
```

然后按你的环境改这些文件:

- `~/RemoteAgentWorkbenchData/runner-host.env`
- `runner/.env.production`
- `~/RemoteAgentWorkbenchData/projects.json`
- `~/RemoteAgentWorkbenchData/directories.json`

## 1. VPS 部署 control plane

### 1.1 上传并安装 server

```bash
./deploy/server/package-server-release.sh
scp server/remote-agent-workbench-server-min.tgz root@<your-vps>:/opt/remote-agent-workbench/server/
ssh root@<your-vps>
mkdir -p /opt/remote-agent-workbench/server
cd /opt/remote-agent-workbench/server
tar xzf remote-agent-workbench-server-min.tgz
npm ci --omit=dev
```

### 1.2 配置 server env

```bash
cp deploy/server/env.production.example /opt/remote-agent-workbench/server/.env
```

至少改这些字段:

- `PUBLIC_BASE_URL`
- `RUNNER_SHARED_SECRET`
- `USER_BEARER_TOKEN`（如果你希望手机端访问需要鉴权）
- `DEPLOY_SSH_HOST`
- `DEPLOY_DIR`
- `DEPLOY_CADDYFILE`

### 1.3 安装 systemd

把 `deploy/server/remote-agent-workbench.service` 放到:

```text
/etc/systemd/system/remote-agent-workbench.service
```

然后:

```bash
systemctl daemon-reload
systemctl enable --now remote-agent-workbench
systemctl status remote-agent-workbench
```

### 1.4 配置 Caddy

把 `deploy/caddy/remote-agent-workbench.Caddyfile.example` 的内容追加到你的 Caddyfile，然后重载 Caddy。

## 2. Mac 上安装 runner

### 2.1 构建 runner

```bash
cd runner
npm ci
npm run build
```

### 2.2 检查 runner host config

`~/RemoteAgentWorkbenchData/runner-host.env` 至少要确认:

- `WORKBENCH_ROOT`
- `WORKBENCH_DATA_ROOT`
- `WORKBENCH_LOG_ROOT`
- `RUNNER_ENV_FILE`
- `RUNNER_NODE_BIN`
- `RUNNER_LAUNCH_AGENT_LABEL`

### 2.3 检查 runner env

`runner/.env.production` 至少要确认:

- `SERVER_BASE_URL`
- `RUNNER_SHARED_SECRET`
- `RUNNER_ID`
- `RUNNER_NAME`
- `RUNNER_PROJECTS_FILE`
- `RUNNER_DIRECTORIES_FILE`
- `RUNNER_CODEX_PROFILES_ROOT`
- `GITLAB_BASE_URL` / `GITLAB_TOKEN`（如需 GitLab MR）
- `RUNNER_REPORTS_REPO_URL` / `RUNNER_REPORTS_PUBLIC_BASE_URL`（如需报告仓库）

### 2.4 登录工具

```bash
codex login
gh auth login          # 如果要创建 GitHub PR
```

如果使用自定义 `RUNNER_CODEX_HOME`:

```bash
CODEX_HOME=/your/custom/codex-home codex login
```

## 3. 安装 launchd

先复制 plist 模板:

```bash
cp deploy/runner/com.remote-agent-workbench.runner.plist.example ~/Library/LaunchAgents/com.remoteagentworkbench.runner.plist
```

再加载:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.remoteagentworkbench.runner.plist
launchctl enable "gui/$(id -u)/com.remoteagentworkbench.runner"
launchctl kickstart -k "gui/$(id -u)/com.remoteagentworkbench.runner"
```

注意:

- plist 依赖 `~/RemoteAgentWorkbenchData/runner-host.env`
- stdout / stderr 日志会根据 `WORKBENCH_LOG_ROOT` 落到同一个目录
- Mac App 本地观察器也会读取同一份 `runner-host.env`

## 4. 启动前自检

```bash
node scripts/check-config.mjs \
  --server-env deploy/server/env.production.example \
  --runner-env runner/.env.production \
  --host-env ~/RemoteAgentWorkbenchData/runner-host.env \
  --projects ~/RemoteAgentWorkbenchData/projects.json \
  --directories ~/RemoteAgentWorkbenchData/directories.json
```

## 5. 验证链路

### VPS

```bash
curl https://<your-domain>/health
curl https://<your-domain>/v1/system/summary
```

### Runner

```bash
tail -f ~/Library/Logs/RemoteAgentWorkbench/runner.stdout.log
tail -f ~/Library/Logs/RemoteAgentWorkbench/runner.stderr.log
```

### 手机 / iPad

- `Settings -> Server URL` 指向你的 `PUBLIC_BASE_URL`
- 首次刷新后，项目列表应该来自 `projects.json`
- `Settings` 页可以看到脱敏后的 deployment / codex config 摘要
