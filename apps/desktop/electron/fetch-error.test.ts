import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeFetchError, fetchFailure } from './fetch-error.ts'

function undiciFetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

test('a socket closed under a request names the code and both ends of the socket', () => {
  /* eslint-disable sonarjs/no-hardcoded-ip -- socket fixture; no network request */
  const cause = Object.assign(new Error('other side closed'), {
    name: 'SocketError',
    code: 'UND_ERR_SOCKET',
    socket: {
      localAddress: '198.18.0.1',
      localPort: 63507,
      remoteAddress: '172.67.147.68',
      remotePort: 443,
      bytesWritten: 812,
      bytesRead: 0,
    },
  })
  /* eslint-enable sonarjs/no-hardcoded-ip */

  assert.equal(
    describeFetchError(undiciFetchFailed(cause)),
    'fetch failed (UND_ERR_SOCKET: other side closed local=198.18.0.1:63507 remote=172.67.147.68:443 written=812 read=0)',
  )
})

test('an empty-message AggregateError lists every address that failed to connect', () => {
  const cause = Object.assign(
    new AggregateError(
      [
        Object.assign(new Error('connect ETIMEDOUT 104.21.65.167:443'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('connect ETIMEDOUT 172.67.147.68:443'), { code: 'ETIMEDOUT' }),
      ],
      // eslint-disable-next-line unicorn/error-message -- undici's happy-eyeballs error really has none
      '',
    ),
    { code: 'ETIMEDOUT' },
  )

  assert.equal(
    describeFetchError(undiciFetchFailed(cause)),
    'fetch failed (ETIMEDOUT [connect ETIMEDOUT 104.21.65.167:443; connect ETIMEDOUT 172.67.147.68:443])',
  )
})

test('a failure without a cause keeps its own message', () => {
  assert.equal(describeFetchError(new Error('Not signed in')), 'Not signed in')
})

test('the rethrown failure carries its cause in the message, the only part IPC keeps', () => {
  const wrapped = fetchFailure(
    undiciFetchFailed(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
  )

  assert.ok(wrapped instanceof Error)
  assert.equal(wrapped.message, 'fetch failed (read ECONNRESET)')
})

test('aborts pass through untouched so cancel handling still recognises them', () => {
  const abort = new DOMException('This operation was aborted', 'AbortError')

  assert.equal(fetchFailure(abort), abort)
})
