import { ExternalLink, Link2, PanelRight } from 'lucide-react'
import { useContext, useState } from 'react'

import { linkClickMode } from '../../lib/linkClickMode'
import { isMac } from '../../lib/platform'
import { ContextMenu } from '../ContextMenu'

import { ChatLinkMenuContext, isChatMenuLink } from './chatLinkMenuContext'

import type { ContextMenuItem } from '../ContextMenu'
import type { MouseEvent, ReactNode } from 'react'

export function ChatLink({
  link,
  onLinkClick,
  className = 'text-zViolet-accent hover:underline',
  title,
  children,
}: {
  link: string | undefined
  onLinkClick?: (href: string, beside: boolean) => boolean
  className?: string
  title?: string
  children: ReactNode
}) {
  const menuActions = useContext(ChatLinkMenuContext)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!link || !onLinkClick) return
    // ⌘-click (Ctrl elsewhere) asks to open the link beside this pane; a
    // handler that declines leaves the browser default.
    const mode = linkClickMode(event, isMac)

    if (!mode) return
    if (onLinkClick(link, mode === 'beside')) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const handleContextMenu = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!link || !menuActions || !isChatMenuLink(link)) return
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY })
  }

  const items: ContextMenuItem[] =
    link && menuActions
      ? [
          {
            key: 'open-in-app',
            label: 'Open in Nuphos',
            icon: PanelRight,
            onSelect: () => menuActions.openInApp(link),
          },
          {
            key: 'open-external',
            label: 'Open in external browser',
            icon: ExternalLink,
            onSelect: () => menuActions.openExternal(link),
          },
          { key: 'sep', separator: true },
          {
            key: 'copy-link',
            label: 'Copy link',
            icon: Link2,
            onSelect: () => menuActions.copyLink(link),
          },
        ]
      : []

  return (
    <>
      <a
        href={link}
        target="_blank"
        rel="noreferrer"
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={className}
        title={title}
      >
        {children}
      </a>
      {menu && items.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </>
  )
}
