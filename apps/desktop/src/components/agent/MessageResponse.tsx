import { cjk as cjkPlugin } from '@streamdown/cjk'
import { createCodePlugin } from '@streamdown/code'
import clsx from 'clsx'
import { cloneElement, isValidElement, memo, useMemo } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'

import { isSynthesizedAutolink } from '../../lib/markdownAutolink'
import { messageRehypePlugins } from '../../lib/messageRehypePlugins'
import { isRuntimeFilePath } from '../../lib/runtimeFileLink'

import { ChatLink } from './ChatLink'
import { ReplyImage } from './ReplyImage'

import type { ComponentProps, ReactElement, ReactNode } from 'react'

type StreamdownComponents = ComponentProps<typeof Streamdown>['components']
type StreamdownAnimated = ComponentProps<typeof Streamdown>['animated']

const STREAMING_TEXT_ANIMATION: StreamdownAnimated = {
  animation: 'atlas-stream-in',
  duration: 240,
  easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  sep: 'word',
  stagger: 0,
}

function extractText(node: ReactNode): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode } | undefined

    return extractText(props?.children)
  }

  return ''
}

function createComponents(
  teamId?: string,
  onLinkClick?: (href: string, beside: boolean) => boolean,
  renderLink?: (href: string, children: ReactNode) => ReactNode | null,
): StreamdownComponents {
  return {
    img: ({ src, alt }) => {
      const groupId = /^https:\/\/nuphos\.ai\/_reply-images\/([a-f0-9]{24})$/.exec(
        typeof src === 'string' ? src : '',
      )?.[1]

      return groupId ? (
        <ReplyImage
          key={`${teamId ?? ''}:${groupId}`}
          groupId={groupId}
          teamId={teamId}
          alt={alt}
        />
      ) : (
        <img src={src} alt={alt} className="max-w-full rounded-lg" />
      )
    },
    p: ({ children }) => <p className="my-3 leading-[1.75] first:mt-0 last:mb-0">{children}</p>,
    ul: ({ children }) => (
      <ul className="my-3 list-outside list-disc space-y-1.5 pl-5">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-3 list-outside list-decimal space-y-1.5 pl-5">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-[1.75]">{children}</li>,
    h1: ({ children }) => (
      <h1 className="mt-3 mb-1.5 text-[16px] font-semibold text-main">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="mt-3 mb-1.5 text-[15.5px] font-semibold text-main">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="mt-2.5 mb-1 text-[15px] font-semibold text-main">{children}</h3>
    ),
    a: ({ children, href }) => {
      const link = href

      if (link && renderLink) {
        const custom = renderLink(link, children)

        if (custom != null) return <>{custom}</>
      }
      // Mention links above are matched on an explicit `https://nuphos.ai/`, so
      // they are never mistaken for a GFM-synthesized one.
      if (link && isSynthesizedAutolink(link, extractText(children))) {
        return <>{children}</>
      }

      return (
        <ChatLink link={link} onLinkClick={onLinkClick}>
          {children}
        </ChatLink>
      )
    },
    inlineCode: ({ children, className }) => {
      const text = extractText(children).trim()
      const code = <code className={className}>{children}</code>

      if (!isRuntimeFilePath(text)) return code

      return (
        <ChatLink link={text} onLinkClick={onLinkClick}>
          {code}
        </ChatLink>
      )
    },
    // A block of nothing but paths becomes file links; anything else keeps
    // Streamdown's highlighted block (its default `pre` marks the code).
    pre: ({ children }) => {
      const lines = extractText(children)
        .trim()
        .split('\n')
        .map((line) => line.trim())

      if (!lines.every(isRuntimeFilePath))
        return (
          <>
            {isValidElement(children)
              ? cloneElement(children as ReactElement<Record<string, unknown>>, {
                  'data-block': 'true',
                })
              : children}
          </>
        )

      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-zGray-900 px-3 py-2 font-mono text-[13px]">
          {lines.map((line, index) => (
            <div key={index}>
              <ChatLink link={line} onLinkClick={onLinkClick}>
                {line}
              </ChatLink>
            </div>
          ))}
        </pre>
      )
    },
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-zGray-700 pl-3 text-tertiary">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-3 border-zGray-800" />,
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-md border border-zGray-800 text-[13.5px]">
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-zGray-900">{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => (
      <th className="border-b border-zGray-800 px-2.5 py-1.5 text-left font-medium text-main">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-zGray-800 px-2.5 py-1.5 text-main last:[tr:last-child_&]:border-b-0">
        {children}
      </td>
    ),
  }
}

const codePlugin = createCodePlugin({ themes: ['github-light', 'night-owl'] })

type Props = {
  children: string
  className?: string
  streaming?: boolean
  teamId?: string
  currentUrl?: string
  onLinkClick?: (href: string, beside: boolean) => boolean
  /** Render a link as a custom node instead of the default anchor (return null to fall through). */
  renderLink?: (href: string, children: ReactNode) => ReactNode | null
}

export const MessageResponse = memo(
  ({ children, className, streaming = false, teamId, onLinkClick, renderLink }: Props) => {
    const hasReplyImages = /https:\/\/nuphos\.ai\/_reply-images\/[a-f0-9]{24}/.test(children)
    const components = useMemo(() => {
      const custom = createComponents(teamId, onLinkClick, renderLink)

      // Keep Streamdown's default images in all unrelated MessageResponse views.
      if (custom && !hasReplyImages) delete custom.img

      return custom
    }, [teamId, onLinkClick, renderLink, hasReplyImages])

    return (
      <div
        className={clsx(
          // break-words: a long unbroken token (an OAuth URL) wraps instead of
          // overflowing the column.
          'message-response min-w-0 break-words text-[14px] text-main [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          // Inline code: subtle pill (the `:not(pre)>code` selector dodges fenced code);
          // a path link's code keeps the link color.
          '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-zGray-800/70 [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[13.5px] [&_:not(pre):not(a)>code]:text-main',
          streaming && 'agent-streaming-response',
          className,
        )}
      >
        <Streamdown
          mode={streaming ? 'streaming' : 'static'}
          isAnimating={streaming}
          animated={streaming ? STREAMING_TEXT_ANIMATION : false}
          controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
          lineNumbers={false}
          // cjk: ends an autolink at CJK punctuation. Without it `https://…/ec2，然後`
          // swallows the rest of the sentence into the href.
          plugins={{ code: codePlugin, cjk: cjkPlugin }}
          rehypePlugins={messageRehypePlugins}
          components={components}
        >
          {children}
        </Streamdown>
      </div>
    )
  },
  (prev, next) =>
    prev.children === next.children &&
    prev.className === next.className &&
    prev.teamId === next.teamId &&
    prev.streaming === next.streaming &&
    prev.onLinkClick === next.onLinkClick &&
    prev.renderLink === next.renderLink,
)

MessageResponse.displayName = 'MessageResponse'
