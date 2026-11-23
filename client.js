window.__ModuleLoader__.load({
  id: 'dsh-remote-file-download',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'remoteFileDownload'
    const ROUTE = './remote-file-download/file'
    const ICON_KEY = 'remote-file-download.icon'

    const zh = {
      headerLabel: '下载',
      headerTooltip: '流式下载原文件（不限大小）',
      emptyLabel: '下载原文件',
      menuLabel: '直接下载（不限大小）',
      started: '已开始下载',
      failed: '下载失败',
    }

    const en = {
      headerLabel: 'Download',
      headerTooltip: 'Stream-download original file (no size limit)',
      emptyLabel: 'Download original file',
      menuLabel: 'Direct download (no size limit)',
      started: 'Download started',
      failed: 'Download failed',
    }

    const STYLES = `
.rfd-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-sizing: border-box;
  margin: 0;
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(128, 128, 128, 0.28));
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-family: var(--dsw-font-family, inherit);
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.rfd-btn:focus-visible {
  outline: none;
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
}
@media (hover: hover) {
  .rfd-btn:hover:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  }
}
.rfd-btn-compact {
  height: 24px;
  gap: 4px;
  padding: 0 7px;
  border-radius: var(--dsw-radius-sm, 6px);
  font-size: 11px;
  line-height: 16px;
}
.rfd-btn-prominent {
  height: 36px;
  gap: 6px;
  padding: 6px 16px;
  border-radius: var(--dsw-radius-md, 8px);
  border-color: var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.38));
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.08));
  font-size: 14px;
  line-height: 20px;
}
`

    function fileNameOf(filePath) {
      if (typeof filePath !== 'string') return 'download'
      const trimmed = filePath.replace(/[\\/]+$/, '')
      const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed) || 'download'
    }

    function downloadUrlOf(absolutePath, sessionId) {
      const params = new URLSearchParams({ path: absolutePath })
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        params.set('sessionId', sessionId)
      }
      return `${ROUTE}?${params.toString()}`
    }

    function DownloadIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 14
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('path', {
          d: 'M8 2.25V10.25M8 10.25L4.75 7M8 10.25L11.25 7M2.75 12.75H13.25',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function MenuDownloadIcon() {
      return h(DownloadIcon, { size: 14 })
    }

    function DownloadHeaderButton(props) {
      const absolutePath = props.absolutePath
      if (!absolutePath) return null
      const name = fileNameOf(absolutePath)
      return h(
        'button',
        {
          type: 'button',
          className: 'rfd-btn rfd-btn-compact',
          'data-rfd-action': 'header',
          'aria-label': `${props.t('headerLabel')}: ${name}`,
          title: `${props.t('headerTooltip')} (${name})`,
          onClick: () => props.onDownload(absolutePath, props.sessionId),
        },
        h(DownloadIcon, { size: 13 }),
        h('span', null, props.t('headerLabel')),
      )
    }

    function DownloadEmptyButton(props) {
      const absolutePath = props.absolutePath
      if (!absolutePath) return null
      const name = fileNameOf(absolutePath)
      return h(
        'button',
        {
          type: 'button',
          className: 'rfd-btn rfd-btn-prominent',
          'data-rfd-action': 'empty',
          'aria-label': `${props.t('emptyLabel')}: ${name}`,
          title: name,
          onClick: () => props.onDownload(absolutePath, props.sessionId),
        },
        h(DownloadIcon, { size: 15 }),
        h('span', null, props.t('emptyLabel')),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'remote-file-download: locale',
        )

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.rfdStyle = ''
          style.textContent = STYLES
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'remote-file-download: styles')

        const t = ctx.locale.bind(NS)

        const triggerDownload = (absolutePath, sessionId) => {
          const anchor = document.createElement('a')
          anchor.href = downloadUrlOf(absolutePath, sessionId)
          anchor.download = fileNameOf(absolutePath)
          anchor.rel = 'noopener'
          anchor.style.display = 'none'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()

          const menus = ctx.get('contextMenus')
          if (menus && typeof menus.notify === 'function') {
            menus.notify(`${t('started')}: ${fileNameOf(absolutePath)}`, true)
          }
        }

        const injected = () => ({ onDownload: triggerDownload })

        ctx.effect(
          () => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register(
            {
              name: 'sidebar.right.tab.document.actions',
              id: 'remote-file-download.header',
              locale: NS,
              inject: injected,
            },
            DownloadHeaderButton,
          )),
          'remote-file-download: header action',
        )

        ctx.effect(
          () => ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () => ctx.slots.register(
            {
              name: 'sidebar.right.tab.document.unpreviewable',
              id: 'remote-file-download.empty',
              locale: NS,
              inject: injected,
            },
            DownloadEmptyButton,
          )),
          'remote-file-download: empty-state action',
        )

        ctx.inject(['contextMenus', 'remote', 'remote.workspaceFiles'], (child) => {
          child.effect(
            () => child.slots.inject('contextMenu.icon', () => child.slots.register(
              { name: 'contextMenu.icon', key: ICON_KEY },
              MenuDownloadIcon,
            )),
            'remote-file-download: menu icon',
          )

          child.effect(
            () => child.contextMenus.register({
              id: 'remote-file-download.file',
              target: 'file',
              order: 205,
              resolve: async ({ sessionId, path }, signal) => {
                let absolutePath
                try {
                  const res = await child.remote.workspaceFiles.stat(sessionId, path, signal)
                  absolutePath = res && res.ok ? res.value.absolutePath : undefined
                } catch {
                  signal.throwIfAborted()
                }
                signal.throwIfAborted()
                const available = typeof absolutePath === 'string' && absolutePath.length > 0
                return [
                  {
                    id: 'directDownload',
                    icon: { key: ICON_KEY },
                    label: t('menuLabel'),
                    failureLabel: t('failed'),
                    disabled: !available,
                    run: () => {
                      if (!available) throw new Error('File unavailable')
                      triggerDownload(absolutePath, sessionId)
                    },
                  },
                ]
              },
            }),
            'remote-file-download: file context menu',
          )
        })
      },
    }
  },
})
