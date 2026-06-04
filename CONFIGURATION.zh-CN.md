# 配置总览

这次重构把仓库里的配置源拆成了 6 类，并尽量让同一类配置只在一个地方定义:

| 类别 | 入口 | 用途 | 现在的统一定义 |
| --- | --- | --- | --- |
| 运行时环境变量 | `server/.env`、`runner/.env.production` | server / runner 启动参数、鉴权、路径、超时 | `server/src/config.ts`、`runner/src/config.ts` |
| 本地 JSON 配置 | `projects.json`、`directories.json` | 项目目录种子、手机端项目预设、目录创建预设 | `runner/src/catalogConfig.ts` |
| 客户端默认值 | iOS/macOS App | 默认 server URL、UserDefaults key、LaunchAgent / 本机路径读取 | `ios-app/.../AppSettings.swift`、`ios-app/.../LocalMachineModel.swift` |
| 部署模板 | `deploy/` | VPS / Caddy / launchd / 示例 env / 示例 JSON | `deploy/generate-config-examples.mjs` 生成 |
| 构建标识 | `ios-app/project.yml`、Xcode project | bundle id 前缀、target 标识 | 已改成通用前缀 `com.remoteagentworkbench` |
| 文档示例 | 本文档 + `deploy/REAL_SETUP.zh-CN.md` | 上手说明、字段含义、最小配置示例 | 与新模板保持一致 |

## 配置边界

### `ServerConfig`

文件: `server/src/config.ts`

| 字段 | 来源 | 默认值 | 必填 | 敏感 | 可出现在 UI/日志/接口 |
| --- | --- | --- | --- | --- | --- |
| `HOST` | env | `0.0.0.0` | 否 | 否 | 可 |
| `PORT` | env | `8787` | 否 | 否 | 可 |
| `PUBLIC_BASE_URL` | env | `http://127.0.0.1:8787` | 否 | 否 | 可 |
| `CORS_ORIGINS` | env | `*` | 否 | 否 | 可 |
| `DATA_ROOT` | env | `~/RemoteAgentWorkbenchServerData` | 否 | 否 | 可 |
| `DATABASE_PATH` | env | `${DATA_ROOT}/control-plane.sqlite` | 否 | 否 | 可 |
| `TASK_RETENTION_DAYS` | env | `30` | 否 | 否 | 可 |
| `USER_BEARER_TOKEN` | env | 空 | 否 | 是 | 只暴露“是否已配置” |
| `RUNNER_SHARED_SECRET` | env | 空 | 否 | 是 | 只暴露“是否已配置” |
| `RUNNER_OFFLINE_THRESHOLD_MS` | env | `45000` | 否 | 否 | 可 |
| `DEPLOY_SSH_HOST` | env | 空 | 否 | 否 | 可 |
| `DEPLOY_SSH_USER` | env | 空 | 否 | 否 | 可 |
| `DEPLOY_DIR` | env | 空 | 否 | 否 | 可 |
| `DEPLOY_ENV_FILE` | env | 空 | 否 | 否 | 可 |
| `DEPLOY_CADDYFILE` | env | 空 | 否 | 否 | 可 |

Server 现在会在启动时做:

- URL 校验: `PUBLIC_BASE_URL`、`CORS_ORIGINS`
- 路径归一化: 支持 `~`，统一转绝对路径
- 数字校验: `PORT`、保留天数、offline threshold
- 脱敏摘要: `/v1/system/summary` 只返回已配置状态和非敏感路径/域名，不返回 token / secret 本身

### `RunnerConfig`

文件: `runner/src/config.ts`

| 字段 | 来源 | 默认值 | 必填 | 敏感 | 可出现在 UI/日志/接口 |
| --- | --- | --- | --- | --- | --- |
| `SERVER_BASE_URL` | env | `http://127.0.0.1:8787` | 否 | 否 | 可 |
| `RUNNER_SHARED_SECRET` | env | 空 | 否 | 是 | 只暴露“是否已配置” |
| `RUNNER_ID` | env | `runner-local-mac` | 否 | 否 | 可 |
| `RUNNER_NAME` | env | `Local Mac Runner` | 否 | 否 | 可 |
| `RUNNER_LABELS` | env | `local,mac,codex` | 否 | 否 | 可 |
| `RUNNER_CAPABILITIES` | env | `codex_app_server,codex_cli,git_guard,xcodebuild` | 否 | 否 | 可 |
| `RUNNER_VERSION` | env | `0.1.0` | 否 | 否 | 可 |
| `RUNNER_HEARTBEAT_INTERVAL_MS` | env | `15000` | 否 | 否 | 可 |
| `RUNNER_POLL_INTERVAL_MS` | env | `4000` | 否 | 否 | 可 |
| `RUNNER_DATA_ROOT` | env | `~/RemoteAgentWorkbenchData` | 否 | 否 | 可 |
| `RUNNER_REPO_CACHE_DIR` | env | `${RUNNER_DATA_ROOT}/repos` | 否 | 否 | 可 |
| `RUNNER_WORKSPACE_DIR` | env | `${RUNNER_DATA_ROOT}/worktrees` | 否 | 否 | 可 |
| `RUNNER_TASKS_DIR` | env | `${RUNNER_DATA_ROOT}/tasks` | 否 | 否 | 可 |
| `RUNNER_PROJECTS_FILE` | env | `${RUNNER_DATA_ROOT}/projects.json` | 否 | 否 | 可 |
| `RUNNER_DIRECTORIES_FILE` | env | `${RUNNER_DATA_ROOT}/directories.json` | 否 | 否 | 可 |
| `RUNNER_LOCK_ROOT_DIR` | env | `${RUNNER_DATA_ROOT}/locks` | 否 | 否 | 可 |
| `RUNNER_REQUEST_JOURNAL_PATH` | env | `${RUNNER_DATA_ROOT}/logs/runner-requests.jsonl` | 否 | 否 | 可 |
| `RUNNER_LOCAL_TASK_RETENTION_DAYS` | env | `30` | 否 | 否 | 可 |
| `RUNNER_GIT_PUSH_TIMEOUT_MS` | env | `120000` | 否 | 否 | 可 |
| `GITLAB_BASE_URL` | env | `https://gitlab.com` | 否 | 否 | 可 |
| `GITLAB_TOKEN` | env | 空 | 否 | 是 | 只暴露“是否已配置” |
| `RUNNER_REPORTS_REPO_URL` | env | 空 | 否 | 否 | 可 |
| `RUNNER_REPORTS_BRANCH` | env | `main` | 否 | 否 | 可 |
| `RUNNER_REPORTS_REPO_DIR` | env | `${RUNNER_DATA_ROOT}/report-publisher` | 否 | 否 | 可 |
| `RUNNER_REPORTS_PUBLIC_BASE_URL` | env | 空 | 否 | 否 | 可 |
| `RUNNER_REPORTS_ROOT_DIR` | env | `plans` | 否 | 否 | 可 |
| `RUNNER_CODEX_HOME` | env | 空 | 否 | 是 | 不直接展示，只展示 live 目录摘要 |
| `RUNNER_CODEX_PROFILES_ROOT` | env | `~/Desktop/codex config` | 否 | 否 | 可 |
| `RUNNER_CODEX_PROFILE_TEMPLATE` | env | `1000` | 否 | 否 | 可 |
| `RUNNER_CODEX_RESTART_TIMEOUT_MS` | env | `5000` | 否 | 否 | 可 |
| `RUNNER_CODEX_RESTART_POLL_INTERVAL_MS` | env | `100` | 否 | 否 | 可 |

Runner 现在新增了几个明确分组:

- `identity`: runner 身份、标签、能力、版本
- `timings`: 心跳、轮询、本地任务保留、git push 超时
- `paths`: data root、repo cache、worktree、tasks、locks、journal、catalog 文件
- `gitlab`: base URL + token
- `reports`: 报告仓库与公开地址
- `codex`: `configuredHome`、`liveDirectory`、profiles root、template、受保护 profile、重启参数

### `CodexConfig`

Codex 专项配置现在由 `RunnerConfig.codex` 和 `/v1/system/summary.codexConfig` 共同表示:

- live 目录规则:
  - `RUNNER_CODEX_HOME` 为空时，live 目录是 `~/.codex`
  - `RUNNER_CODEX_HOME` 非空时，live 目录是该路径
- profile 仓库:
  - `RUNNER_CODEX_PROFILES_ROOT`
  - `RUNNER_CODEX_PROFILE_TEMPLATE`
- 受保护 profile:
  - `1000`
  - `plus`
- 重启策略:
  - `RUNNER_CODEX_RESTART_TIMEOUT_MS`
  - `RUNNER_CODEX_RESTART_POLL_INTERVAL_MS`

iOS 设置页不再写死 `1000/plus`，而是优先使用 server summary 返回的 `protectedProfileNames`。

### `SeedCatalogConfig`

文件: `runner/src/catalogConfig.ts`

#### `projects.json`

默认种子: `[]`

示例模板: `deploy/examples/projects.example.json`

字段:

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | 无 | 项目标识，建议短且稳定 |
| `name` | 是 | 无 | UI 显示名 |
| `repo` | 是 | 无 | 本地绝对路径、`~/...`，或 Git remote |
| `baseBranch` | 是 | 无 | 默认基线分支 |
| `deliveryMode` | 否 | `review_required` | `review_required` / `direct_commit` |
| `autoPush` | 否 | `true` | Direct Commit 完成后是否自动 push 已存在远端分支 |
| `defaultTaskTitle` | 是 | 无 | 手机端默认标题 |
| `defaultPrompt` | 是 | 无 | 手机端默认 prompt |
| `isFeatured` | 否 | `false` | 是否置顶展示 |
| `reportNamespace` | 否 | 空 | 报告仓库路径前缀，不配则回退到 `id` |

#### `directories.json`

默认种子: `[]`

示例模板: `deploy/examples/directories.example.json`

字段:

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | 无 | 目录 preset 标识 |
| `label` | 是 | 无 | UI 显示名 |
| `rootPath` | 是 | 无 | 必须是绝对路径或 `~/...` |

### `ClientConfig`

#### iOS / iPad App

文件: `ios-app/RemoteAgentWorkbench/App/AppSettings.swift`

- `Server URL` 默认值为 `http://127.0.0.1:8787`
- 历史上存过的 `http://127.0.0.1:8787` / `http://localhost:8787` 会在启动时归一到默认本机开发地址
- UserDefaults key 集中在 `WorkbenchAppDefaults.UserDefaultsKeys`
- log subsystem 改成 `Bundle.main.bundleIdentifier` 派生，不再写死个人 bundle id

#### macOS App 本机观察器

文件: `ios-app/RemoteAgentWorkbenchMac/App/LocalMachineModel.swift`

新增单一宿主机配置来源:

- 默认读取 `~/RemoteAgentWorkbenchData/runner-host.env`
- 同时影响:
  - `workbenchRoot`
  - `dataRoot`
  - `logRoot`
  - `runnerEnvFile`
  - `RUNNER_NODE_BIN`
  - `RUNNER_LAUNCH_AGENT_LABEL`
  - LaunchAgent plist 路径
  - Mac App 观察的任务 / 日志 / project catalog 路径

### `DeploymentConfig`

所有模板都由 `deploy/generate-config-examples.mjs` 生成。不要手改模板后又忘了同步。

生成命令:

```bash
node deploy/generate-config-examples.mjs
```

生成结果:

- `deploy/server/env.production.example`
- `deploy/server/remote-agent-workbench.service`
- `deploy/caddy/remote-agent-workbench.Caddyfile.example`
- `deploy/runner/env.production.example`
- `deploy/runner/runner-host.env.example`
- `deploy/runner/run-runner.sh`
- `deploy/runner/run-runner.sh.example`
- `deploy/runner/com.remote-agent-workbench.runner.plist.example`
- `deploy/examples/projects.example.json`
- `deploy/examples/directories.example.json`

## 最小配置示例

### 1. 本机开发

适合: server 和 runner 都在同一台 Mac 上

```bash
cp deploy/runner/runner-host.env.example ~/RemoteAgentWorkbenchData/runner-host.env
cp deploy/runner/env.production.example runner/.env.production
cp deploy/examples/projects.example.json ~/RemoteAgentWorkbenchData/projects.json
cp deploy/examples/directories.example.json ~/RemoteAgentWorkbenchData/directories.json
```

关键改动:

- `WORKBENCH_ROOT`
- `SERVER_BASE_URL=http://127.0.0.1:8787`
- `RUNNER_PROJECTS_FILE`
- `RUNNER_DIRECTORIES_FILE`

### 2. 单 Mac 局域网

适合: Mac 跑 server + runner，手机走同一局域网

- server:
  - `HOST=0.0.0.0`
  - `PUBLIC_BASE_URL=http://<你的 Mac 局域网 IP>:8787`
- iPhone:
  - `Server URL` 填同一个 `PUBLIC_BASE_URL`

### 3. VPS 公网部署

适合: VPS 跑 server，Mac 常驻 runner

- server 用 `deploy/server/env.production.example`
- Caddy 用 `deploy/caddy/remote-agent-workbench.Caddyfile.example`
- runner 用 `deploy/runner/env.production.example`
- launchd 用:
  - `deploy/runner/runner-host.env.example`
  - `deploy/runner/run-runner.sh`
  - `deploy/runner/com.remote-agent-workbench.runner.plist.example`

### 4. 自建 GitLab

只需要改 runner:

- `GITLAB_BASE_URL=https://gitlab.your-company.com`
- `GITLAB_TOKEN=<你的 PAT>`

### 5. 自定义 Codex profile

- 把 profile 仓库放到 `RUNNER_CODEX_PROFILES_ROOT`
- 指定模板 `RUNNER_CODEX_PROFILE_TEMPLATE`
- 如果不想动当前用户 `~/.codex`，显式设置 `RUNNER_CODEX_HOME`
- 如果 `RUNNER_CODEX_HOME` 非空，需要先执行:

```bash
CODEX_HOME=/your/custom/codex-home codex login
```

## 启动前自检

新增脚本: `scripts/check-config.mjs`

建议用法:

```bash
node scripts/check-config.mjs \
  --server-env deploy/server/env.production.example \
  --runner-env deploy/runner/env.production.example \
  --host-env deploy/runner/runner-host.env.example \
  --projects deploy/examples/projects.example.json \
  --directories deploy/examples/directories.example.json
```

会检查:

- URL 是否合法
- 数字配置是否为正整数
- 必填路径 / 文件是否非空
- `projects.json` / `directories.json` 是否满足 schema

## 迁移说明

如果你是从旧版本迁移:

1. 删除仓库里任何仍然引用真实生产域名、个人 bundle id、个人绝对路径的本地私有副本。
2. 复制新的 `deploy/runner/runner-host.env.example` 到 `~/RemoteAgentWorkbenchData/runner-host.env`。
3. 用新的 `deploy/examples/projects.example.json` / `deploy/examples/directories.example.json` 重建 catalog。
4. iOS / macOS App 不再内置 Fernando 的项目预设，项目列表现在来自 runner 同步的 `projects.json`。
