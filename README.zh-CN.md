# RemoteAgentWorkbench

[English](./README.md) · **简体中文**

![RemoteAgentWorkbench developer workflow](./docs/assets/remote-agent-workbench-promo.png)

一个独立于现有仓库的全新工作区，用来实现“iPhone 控制 Mac 上编码代理”的平台基线。

## 补充文档

- [Cookbook（中文操作手册）](./docs/COOKBOOK.zh-CN.md)
- [Configuration（配置说明）](./CONFIGURATION.zh-CN.md)
- [Real Setup（真实部署步骤）](./deploy/REAL_SETUP.zh-CN.md)
- [Contributing（贡献指南，英文）](./CONTRIBUTING.md)

## 目录

- `ios-app/`：SwiftUI iPhone 客户端（同一工程也构建配套的 macOS App）
- `server/`：TypeScript 控制面服务
- `runner/`：常驻在 Mac 上的 Runner 进程
- `docs/`：操作手册、流程说明、后续扩展文档
- `deploy/`：VPS、Caddy、systemd、launchd 等部署模板

## 当前主 Workflow

这一版已经切到“项目优先 + 本地历史 + 轻量手机状态 + GitHub 报告”的主路径：

1. Mac 端维护固定项目清单，写入 `~/RemoteAgentWorkbenchData/projects.json`
2. Runner 启动后把项目清单同步到 Server，iPhone 首页直接展示项目列表
3. iPhone 从项目页发起任务，不再频繁填写 `repo` / `baseBranch`
4. 你可以在项目清单里把少数高频项目标成 `isFeatured`，手机端会优先展示
5. iPhone 可以从目录 preset 直接创建文件夹，并让 Runner 自动把新文件夹加入 Projects
6. Runner 锁定真实项目 repo 或普通本地文件夹；有 Git 时按 Git 流程执行，没有 Git 时也能直接在文件夹里干活
7. 反复 review 流程会先跑只读 planning turn，手机端审批 plan 后进入实现 turn
8. Runner 把完整本地历史写入 `~/RemoteAgentWorkbenchData/tasks/<taskId>/`
9. Direct Submit 会自动从 plan 进入实现；Git repo 成功本地 commit 后完成，普通文件夹保存完变更后完成
10. 每次 plan 生成、实现完成或 Git 动作完成后，Runner 更新 `report.md`，并可推送到独立 GitHub 报告仓库
11. 手机端任务详情只同步最近轻量事件；完整本地历史仍保留在 Mac
12. Mac App 直接读本地任务目录与 `~/.codex/sessions` 展示完整历史；手机端只看轻量任务状态和 GitHub 报告链接

## 当前能力

- iPhone 项目列表、项目详情、项目内发任务、审批、报告跳转
- Runner 注册、心跳、离线判定
- Server 使用轻量 SQLite 持久化项目索引、任务元数据、审批、最近事件和报告 URL
- 已完成任务默认保留 30 天轻量元数据，自动清理
- 本地 repo 路径、普通本地文件夹与远程 Git URL 三种工作区来源
- 真实项目 repo / 普通文件夹执行 + 任务级工作区锁
- `coding_session` 内支持两种交付模式：
  - `review_required`：保持当前流程，commit / PR / MR 继续走审批
  - `direct_commit` / Direct Submit：Git repo 可在检查通过后直接本地 commit；普通文件夹不要求 Git，保存完变更并总结检查后即可完成
- Codex CLI `new thread` 与 `resume thread`
- `commit / rebase / push / create PR / MR` 审批流
- Runner 本地完整历史目录：
  - `task.json`
  - `events.jsonl`
  - `artifacts/`
  - `report.md`
  - `session.json`
- Mac App 本地 Projects 窗口与 Local History 窗口
- GitHub 报告自动发布与 `reportURL` 回填
- SSE 任务详情实时更新，手机端按项目范围拉取而不是全局轮询
- 手机端会根据仓库 `origin` 自动显示 `Create PR` 或 `Create MR`

## 当前边界

- `Open in Codex App` 目前是打开工作区，不会直接把 thread 注入桌面 App
- 手机端 v1 不支持完整编辑项目清单；但可以通过“Create Folder”让 Runner 自动创建文件夹并加入 Projects，项目主数据源仍然是 Mac 本地 `projects.json`
- 手机端 v1 不提供“删除任务”按钮；依赖 Server 轻量元数据和自动清理来控磁盘
- Server 不保存完整 transcript、Codex JSONL、stdout/stderr 全文
- GitHub 报告自动 push 需要额外配置独立报告仓库
- `direct_commit` 对 Git repo 只放开本地 commit；成功本地 commit 会把任务标成 `completed`，但不会自动创建 PR / MR。对普通文件夹，保存完变更即可完成，不要求 Git。
- GitHub PR 依赖本机安装并登录 `gh`
- GitLab MR 依赖 Mac Runner 上配置 `GITLAB_TOKEN`
- iPhone App 默认会连本机开发地址 `http://127.0.0.1:8787`；如果你要接自己的 control plane，再去 `Settings` 改成可访问的公网或局域网地址

## 架构思路

这一套是按“可移植、可扩展、多 workflow”设计的：

- `server/` 只做极简 control plane：项目索引、任务元数据、审批、轻量事件、SSE
- `runner/` 负责本机能力：真实项目 repo 执行、Codex、Git、本地完整历史、GitHub 报告发布
- `ios-app/` 负责项目级 orchestration UI：发起、观察、审批、继续
- `RemoteAgentWorkbenchMac` 直接读取本地任务目录和 `~/.codex/sessions`，不依赖 server 存全文

后续如果要接第二条、第三条 workflow，优先沿着这条边界扩展：

- 在 `server/src/domain/models.ts` 增加新的任务命令与结果类型
- 在 `server/src/services/taskService.ts` 增加新的状态机分支
- 在 `runner/src/index.ts` 新增新的 assignment handler
- 在 iOS 新增对应表单和 detail 操作

## 快速启动

### 1. Server

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

默认地址：`http://127.0.0.1:8787`

推荐补充环境变量：

- `DATA_ROOT=~/RemoteAgentWorkbenchServerData`
- `DATABASE_PATH=~/RemoteAgentWorkbenchServerData/control-plane.sqlite`
- `TASK_RETENTION_DAYS=30`

### 2. Runner

```bash
cd runner
npm install
cp .env.example .env
npm run dev
```

默认会把运行时数据放在：

- `~/RemoteAgentWorkbenchData/repos`
- `~/RemoteAgentWorkbenchData/worktrees`（仅兼容旧数据，不再作为真实执行目录）
- `~/RemoteAgentWorkbenchData/tasks`
- `~/RemoteAgentWorkbenchData/projects.json`
- `~/RemoteAgentWorkbenchData/report-publisher`

如果你希望迁移到新电脑时一起搬走 Runner 状态，可以把这些目录改到你自己的同步或备份位置。

如果你要在手机上创建 review request：

- GitHub：在 Mac Runner 上先执行 `gh auth login`
- GitLab：在 Mac Runner 的环境变量里加 `GITLAB_TOKEN`
- 自建 GitLab：再额外设置 `GITLAB_BASE_URL=https://你的-gitlab-域名`

手机端不需要保存 GitHub 或 GitLab token，Server 也不保存；review request 只会在 Mac Runner 上创建。

### 3. iOS App

```bash
cd ios-app
xcodegen generate
open RemoteAgentWorkbench.xcodeproj
```

首次运行时默认会使用 `http://127.0.0.1:8787`，也可以在 `Settings` 中改成你自己的服务端地址。

> 安全提示：`.env` 已被 gitignore，切勿提交真实密钥。把 server 暴露到 localhost 之外时，请把 `RUNNER_SHARED_SECRET` 设为一段长随机串（两端留空则关闭 runner 鉴权，仅适合本地开发）。

## 验证命令

```bash
cd server && npm test && npm run build
cd runner && npm test && npm run build
cd ios-app && xcodebuild -project RemoteAgentWorkbench.xcodeproj \
  -scheme RemoteAgentWorkbench -destination 'generic/platform=iOS Simulator' build
```

## 贡献

欢迎贡献，详见 [CONTRIBUTING.md](./CONTRIBUTING.md)（本地搭建、测试与约定）。

## 许可证

[MIT](./LICENSE)
