# dsh-remote-file-download

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) dual-face plugin (Host + Web Client) that adds direct streaming file downloads to the DSH Web UI. Designed for remote access (such as accessing a DSH host over a reverse proxy, tunnel, or mobile browser) when files cannot be rendered in the built-in previewer or exceed the 32 MiB preview byte limit.

## Features

- **Unpreviewable file empty state**: Adds a prominent **Download original file** button (`sidebar.right.tab.document.unpreviewable`) for archives, binaries, datasets, or oversized files.
- **Document preview header**: Adds a compact **Download** button (`sidebar.right.tab.document.actions`) to the top toolbar of any opened file.
- **File context menu**: Adds **Direct download (no size limit)** to file tree and path context menus.
- **Arbitrary file size & Range support**: Streams files directly over HTTP (`GET` / `HEAD`) with `Range` (`206 Partial Content`) and RFC 5987 UTF-8 filename headers, avoiding browser memory spikes and the 32 MiB `readBytes` cap.
- **Local & `dsh-remote` SSH workspaces**:
  - Streams regular files on the host machine directly from disk.
  - For sessions bound to a `dsh-remote` SSH workspace, streams live file chunks (1 MiB/chunk) through `ctx.workspaceFiles.readBytes({ range })` over SFTP, and falls back to matching local mirror copies under `$DSH_HOME/remote-workspaces`.
- **Same authentication & trust fence**: Every request checks `ctx.connection.requestRejection(req)` (DSH login cookie + Host/Origin fence) and returns `Content-Type: application/octet-stream` with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.

## Installation

### Local directory installation (recommended)

1. Clone this repository:
   ```bash
   git clone https://github.com/half-lang/dsh-remote-file-download.git
   ```
2. In DSH Web UI, open **Plugins** -> **Add plugin**, and select the cloned folder path (or install via the `plugin_manager` tool with the absolute folder path).
3. Refresh the browser page to load the Web client bundle.

## Optional Configuration

By default, any regular file readable by the host OS user (or via the session's `dsh-remote` workspace) can be downloaded.

To restrict local downloads to specific root directories, add `allowedRoots` to the `remote-file-download` row in your profile's `cordis.patch.yml`:

```yaml
- id: remote-file-download
  config:
    allowedRoots:
      - /path/to/your/workspace
```

## HTTP Endpoint

- `GET /remote-file-download/file?path=<absolute-path>&sessionId=<optional-session-id>`
- `HEAD /remote-file-download/file?path=<absolute-path>&sessionId=<optional-session-id>`

## Compatibility

Tested on `@deepseek-ai/dsh` `0.2.2-rc.5` (Desktop & Web profiles, Windows host + Linux SSH remote workspaces via `dsh-remote`).

## License

[MIT](LICENSE)
