/**
 * Host half of dsh-remote-file-download:
 * Streams host regular files AND dsh-remote SSH mirror/remote files over an
 * authenticated HTTP route on `ctx.webServer`, supporting Range requests,
 * RFC 5987 filenames, and arbitrary file sizes.
 */

import { createReadStream } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

export const name = 'remote-file-download'
export const inject = ['webServer', 'connection']

const ROUTE_PATH = '/remote-file-download/file'
const CHUNK_SIZE = 1024 * 1024 // 1 MiB per SFTP/workspaceFiles range read

function sendJson(res, status, payload) {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function buildContentDisposition(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/')
  const rawName = posix.basename(normalized) || basename(filePath) || 'download'
  const cleanName = rawName.replace(/[\x00-\x1f\x7f"\\]/g, '_').trim() || 'download'
  const ext = extname(cleanName).replace(/[^\x20-\x7e]/g, '')
  const asciiStem = cleanName
    .slice(0, ext ? cleanName.length - ext.length : cleanName.length)
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  const fallback = (asciiStem || 'download') + ext
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(cleanName)}`
}

function parseSingleByteRange(header, totalSize) {
  if (typeof header !== 'string' || !header.startsWith('bytes=')) return null
  const spec = header.slice(6).trim()
  if (!spec || spec.includes(',')) return null
  const dash = spec.indexOf('-')
  if (dash === -1) return { invalid: true }
  const startText = spec.slice(0, dash).trim()
  const endText = spec.slice(dash + 1).trim()
  if (totalSize === 0) return { invalid: true }

  let start
  let end
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true }
    start = Math.max(0, totalSize - suffix)
    end = totalSize - 1
  } else {
    start = Number(startText)
    if (!Number.isSafeInteger(start) || start < 0 || start >= totalSize) return { invalid: true }
    if (endText === '') {
      end = totalSize - 1
    } else {
      end = Number(endText)
      if (!Number.isSafeInteger(end) || end < start) return { invalid: true }
      if (end >= totalSize) end = totalSize - 1
    }
  }
  return { invalid: false, start, end }
}

function isWithinRoot(targetReal, rootReal) {
  const normTarget = process.platform === 'win32' ? targetReal.toLowerCase() : targetReal
  const normRoot = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal
  if (normTarget === normRoot) return true
  const prefix = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`
  return normTarget.startsWith(prefix)
}

async function checkAllowedRoots(resolvedPath, allowedRoots) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return true
  let targetReal
  try {
    targetReal = await realpath(resolvedPath)
  } catch {
    return false
  }
  for (const entry of allowedRoots) {
    if (typeof entry !== 'string' || entry.trim() === '') continue
    try {
      const rootReal = await realpath(resolve(entry))
      if (isWithinRoot(targetReal, rootReal)) return true
    } catch {
      // Skip non-existent configured root.
    }
  }
  return false
}

/** Resolve a sessionId to its workspaceRoot using live sessions or persistence. */
async function resolveSessionWorkspaceRoot(ctx, sessionId) {
  if (!sessionId) return undefined
  try {
    const sessions = ctx.get('sessions')
    const live = sessions?.get?.(sessionId)?.header
    if (live?.cwd) return live.cwd
    const persistence = ctx.get('sessionPersistence')
    const stored = await persistence?.stat?.(sessionId)
    if (stored?.header?.cwd) return stored.header.cwd
  } catch {
    // Ignore lookup failure.
  }
  return undefined
}

/** Check if a directory contains a dsh-remote mirror metadata file. */
async function readRemoteMeta(dir) {
  try {
    const text = await readFile(join(dir, '.dsh-remote-meta.json'), 'utf8')
    const meta = JSON.parse(text)
    if (meta && typeof meta.remotePath === 'string' && meta.remotePath.length > 0) {
      return meta
    }
  } catch {
    // Not a mirror directory.
  }
  return null
}

/** Map a POSIX remote path to a local mirror file path if it lies under remotePath. */
function mapRemoteToMirror(mirrorDir, remoteRoot, remoteTarget) {
  const normRoot = posix.normalize(remoteRoot).replace(/\/+$/, '') || '/'
  const normTarget = posix.normalize(remoteTarget)
  const rel = posix.relative(normRoot, normTarget)
  if (!rel || rel.startsWith('..') || posix.isAbsolute(rel)) return null
  const parts = rel.split('/').filter(Boolean)
  if (parts.length === 0) return null
  const root = resolve(mirrorDir)
  const candidate = resolve(root, ...parts)
  const back = relative(root, candidate)
  if (!back || back.startsWith('..') || isAbsolute(back)) return null
  return candidate
}

/** Scan `$DSH_HOME/remote-workspaces/<machine>/<workspace>/.dsh-remote-meta.json` for a matching local mirror copy. */
async function findInRemoteMirrors(remoteTarget, preferredMirrorDir) {
  const checked = new Set()
  const tryMirror = async (dir) => {
    if (!dir) return null
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (checked.has(key)) return null
    checked.add(key)
    const meta = await readRemoteMeta(dir)
    if (!meta) return null
    const candidate = mapRemoteToMirror(dir, meta.remotePath, remoteTarget)
    if (!candidate) return null
    try {
      const info = await stat(candidate)
      if (info.isFile()) return { filePath: candidate, info }
    } catch {
      // Not present in this mirror.
    }
    return null
  }

  // 1. Prefer the session's own mirror directory first.
  const preferred = await tryMirror(preferredMirrorDir)
  if (preferred) return preferred

  // 2. Fall back to scanning all known remote-workspaces mirrors under DSH_HOME.
  const dshHome = process.env.DSH_HOME
  if (!dshHome) return null
  const rwRoot = join(dshHome, 'remote-workspaces')
  let machineDirs
  try {
    machineDirs = await readdir(rwRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const mEntry of machineDirs) {
    if (!mEntry.isDirectory()) continue
    const mPath = join(rwRoot, mEntry.name)
    let wsDirs
    try {
      wsDirs = await readdir(mPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const wEntry of wsDirs) {
      if (!wEntry.isDirectory()) continue
      const hit = await tryMirror(join(mPath, wEntry.name))
      if (hit) return hit
    }
  }
  return null
}

/** Stream a file from the local filesystem with optional byte Range support. */
async function streamLocalFile(req, res, filePath, info, downloadNamePath) {
  const totalSize = info.size
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined
  const range = rangeHeader ? parseSingleByteRange(rangeHeader, totalSize) : null

  if (range && range.invalid) {
    res.statusCode = 416
    res.setHeader('content-range', `bytes */${totalSize}`)
    res.setHeader('cache-control', 'no-store')
    res.end()
    return
  }

  res.setHeader('content-type', 'application/octet-stream')
  res.setHeader('content-disposition', buildContentDisposition(downloadNamePath || filePath))
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')

  let streamOptions
  if (range) {
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${range.start}-${range.end}/${totalSize}`)
    res.setHeader('content-length', String(range.end - range.start + 1))
    streamOptions = { start: range.start, end: range.end }
  } else {
    res.statusCode = 200
    res.setHeader('content-length', String(totalSize))
  }

  if (req.method === 'HEAD' || totalSize === 0) {
    res.end()
    return
  }

  await new Promise((done) => {
    const stream = createReadStream(filePath, streamOptions)
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      done()
    }
    res.on('close', () => {
      if (!stream.destroyed) stream.destroy()
      finish()
    })
    res.on('finish', finish)
    stream.on('error', (error) => {
      if (!res.headersSent) {
        const code = error && typeof error === 'object' ? error.code : undefined
        sendJson(
          res,
          code === 'EACCES' || code === 'EPERM' ? 403 : 500,
          { code: 'read-failed', message: 'Failed to read file' },
        )
      } else {
        res.destroy(error)
      }
      finish()
    })
    stream.pipe(res)
  })
}

/**
 * Stream a file through `ctx.workspaceFiles` (which dsh-remote wraps over SFTP
 * for remote sessions), chunk by chunk via `readBytes({ range })` so arbitrary
 * file sizes work without hitting the 32 MiB complete-file cap.
 */
async function streamViaWorkspaceFiles(ctx, req, res, sessionId, workspaceRoot, targetPath) {
  const wf = ctx.get('workspaceFiles')
  if (!wf || typeof wf.stat !== 'function' || typeof wf.readBytes !== 'function') {
    return false
  }
  const ac = new AbortController()
  res.on('close', () => { ac.abort() })

  const scope = { sessionId, workspaceRoot }
  let statRes
  try {
    statRes = await wf.stat(scope, targetPath, ac.signal)
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code === 'workspace-file/not-found') {
      sendJson(res, 404, { code: 'not-found', message: 'File not found on remote workspace' })
      return true
    }
    if (code === 'workspace-file/not-regular-file') {
      sendJson(res, 400, { code: 'not-regular-file', message: 'Path is not a regular file' })
      return true
    }
    return false
  }

  const totalSize = typeof statRes?.bytes === 'number' ? statRes.bytes : undefined
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined
  const range = rangeHeader && totalSize !== undefined ? parseSingleByteRange(rangeHeader, totalSize) : null

  if (range && range.invalid) {
    res.statusCode = 416
    res.setHeader('content-range', `bytes */${totalSize}`)
    res.setHeader('cache-control', 'no-store')
    res.end()
    return true
  }

  res.setHeader('content-type', 'application/octet-stream')
  res.setHeader('content-disposition', buildContentDisposition(statRes?.absolutePath || targetPath))
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  if (totalSize !== undefined) {
    res.setHeader('accept-ranges', 'bytes')
  }

  let offset = 0
  let endInclusive = totalSize !== undefined ? totalSize - 1 : Infinity
  if (range) {
    res.statusCode = 206
    offset = range.start
    endInclusive = range.end
    res.setHeader('content-range', `bytes ${range.start}-${range.end}/${totalSize}`)
    res.setHeader('content-length', String(range.end - range.start + 1))
  } else {
    res.statusCode = 200
    if (totalSize !== undefined) {
      res.setHeader('content-length', String(totalSize))
    }
  }

  if (req.method === 'HEAD' || totalSize === 0) {
    res.end()
    return true
  }

  try {
    while (offset <= endInclusive && !ac.signal.aborted) {
      const remaining = Number.isFinite(endInclusive) ? endInclusive - offset + 1 : CHUNK_SIZE
      const length = Math.min(CHUNK_SIZE, remaining)
      const chunk = await wf.readBytes(scope, targetPath, { range: { offset, length } }, ac.signal)
      const data = chunk?.data
      if (!data || data.length === 0) break
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      if (!res.write(buf)) {
        await new Promise((resolveDrain) => {
          const onDone = () => {
            res.off('drain', onDone)
            res.off('close', onDone)
            resolveDrain()
          }
          res.on('drain', onDone)
          res.on('close', onDone)
        })
      }
      offset += buf.length
      if (chunk.eof) break
    }
    if (!res.writableEnded) res.end()
  } catch (error) {
    if (!ac.signal.aborted) {
      if (!res.headersSent) {
        sendJson(res, 500, { code: 'remote-read-failed', message: String(error?.message || error) })
      } else {
        res.destroy(error)
      }
    }
  }
  return true
}

export function apply(ctx, config = {}) {
  const allowedRoots = Array.isArray(config?.allowedRoots) ? config.allowedRoots : []

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.setHeader('cache-control', 'no-store')
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD')
        res.end()
        return
      }

      let targetParam
      let sessionId
      try {
        const parsed = new URL(String(req.url ?? '/'), 'http://localhost')
        targetParam = parsed.searchParams.get('path')
        sessionId = parsed.searchParams.get('sessionId') || undefined
      } catch {
        sendJson(res, 400, { code: 'bad-request', message: 'Invalid request URL' })
        return
      }

      if (!targetParam || targetParam.includes('\0') || (!isAbsolute(targetParam) && !targetParam.startsWith('/'))) {
        sendJson(res, 400, { code: 'invalid-path', message: 'An absolute file path is required' })
        return
      }

      const sessionWorkspaceRoot = await resolveSessionWorkspaceRoot(ctx, sessionId)

      // Path A: Remote POSIX path on Windows (e.g. /path/to/remote/file) or a session bound to a remote mirror
      const isPosixOnWin = process.platform === 'win32' && targetParam.startsWith('/') && !targetParam.startsWith('//')
      const sessionMeta = sessionWorkspaceRoot ? await readRemoteMeta(sessionWorkspaceRoot) : null

      if (isPosixOnWin || sessionMeta) {
        // 1. Prefer live remote stream via workspaceFiles (dsh-remote SFTP) when sessionId is known so content is always fresh
        //    and works even for files that were never mirrored locally.
        if (sessionId && sessionWorkspaceRoot && sessionMeta) {
          const handled = await streamViaWorkspaceFiles(ctx, req, res, sessionId, sessionWorkspaceRoot, targetParam)
          if (handled) return
        }

        // 2. Fall back to matching local mirror copy under $DSH_HOME/remote-workspaces (fast local disk stream,
        //    also works when sessionId wasn't passed or SSH is offline).
        const mirrorHit = await findInRemoteMirrors(targetParam, sessionWorkspaceRoot)
        if (mirrorHit) {
          if (allowedRoots.length > 0 && !(await checkAllowedRoots(mirrorHit.filePath, allowedRoots))) {
            sendJson(res, 403, { code: 'outside-allowed-roots', message: 'File is outside allowedRoots' })
            return
          }
          await streamLocalFile(req, res, mirrorHit.filePath, mirrorHit.info, targetParam)
          return
        }

        // 3. If still not found and we have a sessionId, try workspaceFiles directly as last resort.
        if (sessionId && sessionWorkspaceRoot) {
          const handled = await streamViaWorkspaceFiles(ctx, req, res, sessionId, sessionWorkspaceRoot, targetParam)
          if (handled) return
        }

        sendJson(res, 404, { code: 'not-found', message: 'File not found locally or in remote workspaces' })
        return
      }

      // Path B: Ordinary local host absolute path
      const resolvedPath = resolve(targetParam)
      let info
      try {
        info = await stat(resolvedPath)
      } catch (error) {
        const code = error && typeof error === 'object' ? error.code : undefined
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          sendJson(res, 404, { code: 'not-found', message: 'File not found' })
        } else if (code === 'EACCES' || code === 'EPERM') {
          sendJson(res, 403, { code: 'permission-denied', message: 'Permission denied' })
        } else {
          sendJson(res, 500, { code: 'stat-failed', message: 'Unable to access file' })
        }
        return
      }

      if (!info.isFile()) {
        sendJson(res, 400, { code: 'not-regular-file', message: 'Path is not a regular file' })
        return
      }

      if (allowedRoots.length > 0 && !(await checkAllowedRoots(resolvedPath, allowedRoots))) {
        sendJson(res, 403, { code: 'outside-allowed-roots', message: 'File is outside allowedRoots' })
        return
      }

      await streamLocalFile(req, res, resolvedPath, info, resolvedPath)
    },
  }), `remote-file-download: GET ${ROUTE_PATH}`)
}
