import { Hono } from 'hono'

import { desktopCallbackResponse } from '@/lib/desktop-callback-page'
import { AppError } from '@/lib/errors'
import { logError } from '@/lib/observability'
import {
  completePersonalCredentialOAuth,
  deletePersonalCredential,
  listPersonalCredentials,
  PERSONAL_CREDENTIAL_PROVIDERS,
  startPersonalCredentialOAuth,
} from '@/lib/personal-credentials'
import { requireAuth } from '@/middleware/auth'

import type { AuthVariables } from '@/middleware/auth'
import type { PersonalCredentialProvider } from '@/models'

// A member's own GitHub / Linear grants. Only a signed-in user session reaches
// these: conversation tokens are not accepted by requireAuth, so an agent can
// never start, list or remove a Personal Credential.
export const personalCredentialRoutes = new Hono<{ Variables: AuthVariables }>()

// Brings the app forward; the open Settings section refetches on focus.
const DESKTOP_RETURN = 'nuphos://open'

function providerParam(value: string | undefined): PersonalCredentialProvider {
  if (!PERSONAL_CREDENTIAL_PROVIDERS.includes(value as PersonalCredentialProvider)) {
    throw new AppError(404, 'not_found', 'Unknown Personal Credential provider')
  }

  return value as PersonalCredentialProvider
}

personalCredentialRoutes.get('/', requireAuth, async (c) =>
  c.json({ credentials: await listPersonalCredentials(c.get('userId')) }),
)

personalCredentialRoutes.post('/:provider/start', requireAuth, async (c) =>
  c.json(
    await startPersonalCredentialOAuth(c.get('userId'), providerParam(c.req.param('provider'))),
  ),
)

personalCredentialRoutes.delete('/:provider', requireAuth, async (c) => {
  await deletePersonalCredential(c.get('userId'), providerParam(c.req.param('provider')))

  return c.body(null, 204)
})

// Public: the provider redirects the browser here. The state ties the code to
// the member who started the flow; it is single-use and expires in 10 minutes.
personalCredentialRoutes.get('/:provider/callback', async (c) => {
  const provider = providerParam(c.req.param('provider'))
  const state = c.req.query('state') ?? ''
  const code = c.req.query('code') ?? ''
  const back = (params: Record<string, string>) =>
    desktopCallbackResponse(c, DESKTOP_RETURN, params)

  if (!state || !code) return back({ error: c.req.query('error') ?? 'missing_code' })
  try {
    await completePersonalCredentialOAuth(provider, state, code)

    return back({ connected: provider })
  } catch (error) {
    logError('personal_credential.callback_failed', error, { provider })

    return back({ error: error instanceof AppError ? error.code : 'exchange_failed' })
  }
})
