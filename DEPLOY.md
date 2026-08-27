# 自托管部署说明（生产环境）

本仓库是 `Tencent/openclaw-weixin` 的 fork，在 2.4.6 基线上移植了自研功能
（ack 已读回执、聊天记录、联系人管理，以及 `/whoami` `/setname` `/listusers` `/history` `/restart`
等管理命令）。以下步骤用于在 OpenClaw 网关宿主机上以 git 方式部署本 fork。

## 前置

- 宿主 OpenClaw 版本 `2026.4.24`（本 fork 的 `openclaw.install.minHostVersion` 已放宽到
  `>=2026.3.22`，与 `src/compat.ts` 的 `SUPPORTED_HOST_MIN` 一致）。
- 服务器若无法直接访问 GitHub，可用 `git bundle` + `scp` 传输（SSH 通道可达即可）。

## 部署步骤

```bash
# 1. 克隆本 fork 到插件目录
cd /root/.openclaw/extensions
git clone <fork-url> openclaw-weixin
cd openclaw-weixin

# 2. 安装运行时依赖，并显式安装与宿主一致的 peer openclaw
npm install --no-save --no-package-lock --no-audit --no-fund qrcode-terminal zod \
  --registry=https://mirrors.tencentyun.com/npm/
npm install --no-save --no-package-lock --no-audit --no-fund openclaw@2026.4.24 \
  --registry=https://mirrors.tencentyun.com/npm/

# 3. 关键：删除 openclaw 包内置的扩展目录，防止宿主把它当嵌套插件扫描
rm -rf node_modules/openclaw/dist/extensions

# 4. 重启网关并健康检查
systemctl restart openclaw-gateway
curl -s http://127.0.0.1:18789/   # 期望 200
```

验证：日志里 3 个 bot 各出现一条 `Monitor started`，随后没有 `channel exited`。

## 关键坑（为什么插件 node_modules 必须自带 openclaw）

- 宿主 2026.4.24 加载插件走 `extensions: ["./index.ts"]`（tsx）路径。
- **该模式仍要求插件 `node_modules` 里有 `openclaw` 包**：channel runtime
  （如 `dist/src/messaging/process-message.js`）以 Node ESM 规则从插件目录向上解析 `openclaw`，
  宿主**不**为该解析注入任何路径；缺包时 3 个 bot 全部报
  `Cannot find package 'openclaw'` 并 `channel exited`（自动重启循环）。
- 宿主的 `runtimeExtensions` 路径（直接加载 `dist/index.js`）在 2026.4.24 上同样不注入
  openclaw 解析，因此本 fork 已移除 `runtimeExtensions`，统一走 `extensions`。
- 运行数据（`contacts.json` / `chatlogs/` / `accounts/`）位于插件目录外的
  `/root/.openclaw/openclaw-weixin/`，替换插件目录不影响数据。
