# dsh-remote-file-download

[English](README.md) | 中文

一款面向 DeepSeek Harness（DSH）网页端的双面插件（Host 后端 + Web 前端），用于在远程访问 DSH（如内网穿透、反向代理、手机浏览器等场景）时，直接流式下载宿主机文件以及 `dsh-remote` 远端 SSH 工作区中的文件，解决无法渲染或超过 32 MiB 上限的文件打不开、下不了的问题。

## 功能亮点

- **无法预览提示页**：在压缩包、二进制文件、数据集、超大文件等无法渲染的空状态页中，提供醒目的 **「下载原文件」** 按钮（`sidebar.right.tab.document.unpreviewable`）。
- **预览栏顶部工具栏**：在任意已打开文件的顶部工具栏提供紧凑 **「下载」** 按钮（`sidebar.right.tab.document.actions`）。
- **文件右键菜单**：在文件树和预览路径右键菜单中增加 **「直接下载（不限大小）」**。
- **真正流式下载 + 断点续传**：走独立的受鉴权 HTTP 路由（支持 `GET` / `HEAD` / `Range` `206 Partial Content` 和 RFC 5987 中文文件名），不受内置 `readBytes` 32 MiB 上限限制，不占浏览器大块内存。
- **同时支持本机文件与 `dsh-remote` 远端文件**：
  - 本机绝对路径直接从宿主机磁盘流式输出。
  - 绑定了 `dsh-remote` SSH 远端工作区的会话，优先通过 `ctx.workspaceFiles.readBytes({ range })` 分块（1 MiB/块）实时拉取远端 SFTP 文件（未同步到本地也能下），并自动回退到 `$DSH_HOME/remote-workspaces` 下的本地镜像副本。
- **复用 DSH 安全护栏**：每个请求都会先执行 `ctx.connection.requestRejection(req)`（校验登录 Cookie 与 Host/Origin 信任边界），响应强制携带 `Content-Type: application/octet-stream`、`Content-Disposition: attachment` 与 `X-Content-Type-Options: nosniff`。

## 安装方式

1. 克隆本仓库到本地：
   ```bash
   git clone https://github.com/half-lang/dsh-remote-file-download.git
   ```
2. 在 DSH 网页端打开 **插件（Plugins）** → **添加插件（Add plugin）**，选择刚才克隆的目录路径完成安装。
3. 刷新浏览器页面，即可在预览页和文件右键菜单中看到下载按钮。

## 可选配置

默认允许下载宿主机当前系统用户可读的普通文件（以及当前会话对应的 `dsh-remote` 远端文件）。

如需把本机下载范围限制在指定目录内，可在对应 profile 的 `cordis.patch.yml` 中为 `remote-file-download` 配置 `allowedRoots`：

```yaml
- id: remote-file-download
  config:
    allowedRoots:
      - /path/to/your/workspace
```

## 接口说明

- `GET /remote-file-download/file?path=<绝对路径>&sessionId=<可选会话ID>`
- `HEAD /remote-file-download/file?path=<绝对路径>&sessionId=<可选会话ID>`

## 兼容性

已在 `@deepseek-ai/dsh` `0.2.2-rc.5`（Desktop / Web profile，Windows 宿主机 + `dsh-remote` Linux SSH 远端工作区）实测通过。

## 开源协议

[MIT](LICENSE)
