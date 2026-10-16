import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'

import { messageRehypePlugins } from './messageRehypePlugins.ts'

const render = (markdown: string) =>
  renderToStaticMarkup(
    createElement(Streamdown, {
      mode: 'static',
      rehypePlugins: messageRehypePlugins,
      components: { a: ({ href, children }) => createElement('a', { href }, children) },
      children: markdown,
    }),
  )

test('relative file links keep their href as written', () => {
  const html = render('[a](src/a.ts) [b](./docs/b.md:3) [c](/workspace/c.md)')

  assert.match(html, /href="src\/a\.ts"/)
  assert.match(html, /href="\.\/docs\/b\.md:3"/)
  assert.match(html, /href="\/workspace\/c\.md"/)
})

test('unsafe protocols and event handlers are still stripped', () => {
  const html = render(
    '[x](javascript:alert(1)) [y](data:text/html,x) <img src="data:image/png;base64,AAAA" onerror="alert(1)">',
  )

  assert.doesNotMatch(html, /javascript:|data:|onerror/)
})

test('bare paths in prose become file links, code and links are left to their renderers', () => {
  const html = render(
    '檔案在 /data/workspace/a.mp4。\n\n`/data/workspace/b.md` [c](https://x.dev/data/c)\n\n```\n/data/workspace/d.md\n```',
  )

  assert.match(html, /<a href="\/data\/workspace\/a\.mp4">\/data\/workspace\/a\.mp4<\/a>。/)
  assert.doesNotMatch(html, /href="\/data\/workspace\/[bd]\.md"/)
  assert.doesNotMatch(html, /href="\/data\/c"/)
})
