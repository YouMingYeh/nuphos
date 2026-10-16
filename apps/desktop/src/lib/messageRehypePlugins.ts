import { defaultRehypePlugins } from 'streamdown'

import { splitRuntimeFilePaths } from './runtimeFileLink.ts'

type Node = { type: string; tagName?: string; value?: string; children?: Node[] }

// Code renders its own path links, and a link is already one.
const KEEP = new Set(['a', 'code', 'pre'])

function linkPaths(node: Node) {
  node.children = node.children?.flatMap((child): Node[] => {
    if (child.type === 'element' && !KEEP.has(child.tagName ?? '')) linkPaths(child)
    if (child.type !== 'text' || !child.value) return [child]

    return splitRuntimeFilePaths(child.value).map((part) =>
      typeof part === 'string'
        ? { type: 'text', value: part }
        : {
            type: 'element',
            tagName: 'a',
            properties: { href: part.path },
            children: [{ type: 'text', value: part.path }],
          },
    )
  })
}

/** Turns bare runtime paths in prose into file links. */
const rehypeRuntimeFilePaths = () => linkPaths

// Without `harden`: sanitize already drops unsafe protocols, and with every
// prefix allowed harden only rewrote `./a` to `/a` and blocked bare `a`, which
// is how agents cite files relative to their workspace.
export const messageRehypePlugins = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  rehypeRuntimeFilePaths,
]
