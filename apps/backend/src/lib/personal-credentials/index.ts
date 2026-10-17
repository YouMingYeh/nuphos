// Personal Credentials: a member's own GitHub / Linear grant. Connect,
// list and disconnect live here; the agent-facing handout is in ./handout.
import { createHash, randomBytes } from 'node:crypto'

import { ObjectId } from 'mongodb'

import { config } from '@/config'
import { getDefaultClientCredentials, getViewer } from '@/lib/byos/linear'
import { buildAuthorizeUrl, exchangeCodeForTokens } from '@/lib/byos/linear-oauth'
import { AppError } from '@/lib/errors'
import { logError } from '@/lib/observability'
import { personalCredentialPendingOAuth, personalCredentials } from '@/models'

import {
  exchangeGithubCode,
  getGithubUser,
  githubAuthorizeUrl,
  githubOAuthClient,
  revokeGithubToken,
} from './github'
import { open, seal } from './seal'

import type { ProviderTokens } from './github'
import type { PersonalCredential, PersonalCredentialProvider } from '@/models'

const PENDING_TTL_MS = 10 * 60 * 1000
const LINEAR_SCOPE = 'read,write'
const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke'

export const PERSONAL_CREDENTIAL_PROVIDERS = ['github', 'linear'] as const

/** The callback sits on the same public origin as the provider's existing setup redirect. */
function callbackUrl(provider: PersonalCredentialProvider): string | null {
  const setup =
    provider === 'github' ? config.byos.github.setupRedirect : config.byos.linear.setupRedirect

  return setup ? `${new URL(setup).origin}/personal-credentials/${provider}/callback` : null
}

function notConfigured(provider: PersonalCredentialProvider): AppError {
  return new AppError(
    503,
    'personal_credential_not_configured',
    `Personal Credentials for ${provider === 'github' ? 'GitHub' : 'Linear'} are not configured on this server`,
  )
}

export type PersonalCredentialSummary = {
  provider: PersonalCredentialProvider
  login: string
  workspaceName: string | null
  connectedAt: string
}

export async function listPersonalCredentials(
  userId: string,
): Promise<PersonalCredentialSummary[]> {
  const docs = await personalCredentials()
    .find({ userId }, { projection: { provider: 1, login: 1, workspaceName: 1, createdAt: 1 } })
    .toArray()

  return docs.map((doc) => ({
    provider: doc.provider,
    login: doc.login,
    workspaceName: doc.workspaceName ?? null,
    connectedAt: doc.createdAt.toISOString(),
  }))
}

export async function startPersonalCredentialOAuth(
  userId: string,
  provider: PersonalCredentialProvider,
): Promise<{ authorizeUrl: string; state: string }> {
  const redirectUri = callbackUrl(provider)
  const state = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS)

  if (provider === 'github') {
    const client = githubOAuthClient()

    if (!client || !redirectUri || !config.byos.github.encryptionKey) throw notConfigured(provider)
    const verifier = randomBytes(32).toString('base64url')

    await personalCredentialPendingOAuth().insertOne({
      _id: state,
      userId,
      provider,
      encryptedCodeVerifier: seal(provider, verifier),
      expiresAt,
    })

    return {
      state,
      authorizeUrl: githubAuthorizeUrl({
        clientId: client.clientId,
        redirectUri,
        state,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      }),
    }
  }
  const client = getDefaultClientCredentials()

  if (!client || !redirectUri || !config.byos.linear.encryptionKey) throw notConfigured(provider)
  await personalCredentialPendingOAuth().insertOne({ _id: state, userId, provider, expiresAt })

  return {
    state,
    authorizeUrl: buildAuthorizeUrl({
      clientId: client.clientId,
      redirectUri,
      state,
      scope: LINEAR_SCOPE,
      actor: 'user',
    }),
  }
}

type Identity = Pick<
  PersonalCredential,
  'providerUserId' | 'login' | 'workspaceId' | 'workspaceName'
>

/** Exchanges the code, verifies who it belongs to, and stores it for the user that started the flow. */
export async function completePersonalCredentialOAuth(
  provider: PersonalCredentialProvider,
  state: string,
  code: string,
): Promise<PersonalCredentialSummary> {
  const pending = await personalCredentialPendingOAuth().findOneAndDelete({ _id: state, provider })

  if (!pending || pending.expiresAt.getTime() < Date.now()) {
    throw new AppError(
      400,
      'invalid_state',
      'This authorization request expired or was already used',
    )
  }
  const redirectUri = callbackUrl(provider)
  let tokens: ProviderTokens
  let identity: Identity

  if (provider === 'github') {
    const client = githubOAuthClient()

    if (!client || !redirectUri || !pending.encryptedCodeVerifier) throw notConfigured(provider)
    tokens = await exchangeGithubCode({
      ...client,
      code,
      redirectUri,
      codeVerifier: open(provider, pending.encryptedCodeVerifier),
    })
    const user = await getGithubUser(tokens.accessToken)

    identity = { providerUserId: user.id, login: user.login }
  } else {
    const client = getDefaultClientCredentials()

    if (!client || !redirectUri) throw notConfigured(provider)
    tokens = await exchangeCodeForTokens(client.clientId, client.clientSecret, code, redirectUri)
    const viewer = await getViewer(tokens.accessToken)

    identity = {
      providerUserId: viewer.user.id,
      login: viewer.user.name ?? viewer.user.id,
      workspaceId: viewer.organization.id,
      workspaceName: viewer.organization.name,
    }
  }
  const now = new Date()
  const previous = await personalCredentials().findOneAndUpdate(
    { userId: pending.userId, provider },
    {
      $set: {
        ...identity,
        encryptedAccessToken: seal(provider, tokens.accessToken),
        encryptedRefreshToken: tokens.refreshToken ? seal(provider, tokens.refreshToken) : null,
        accessTokenExpiresAt: tokens.expiresAt,
        updatedAt: now,
      },
      $setOnInsert: { _id: new ObjectId(), createdAt: now },
    },
    { upsert: true, returnDocument: 'before' },
  )

  if (previous) void revokeQuietly(previous)

  return {
    provider,
    login: identity.login,
    workspaceName: identity.workspaceName ?? null,
    connectedAt: (previous?.createdAt ?? now).toISOString(),
  }
}

async function revokeAtProvider(doc: PersonalCredential): Promise<void> {
  const token = open(doc.provider, doc.encryptedAccessToken)

  if (doc.provider === 'github') return revokeGithubToken(token)
  await fetch(LINEAR_REVOKE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  })
}

function revokeQuietly(doc: PersonalCredential): Promise<void> {
  return revokeAtProvider(doc).catch((error: unknown) => {
    logError('personal_credential.revoke_failed', error, { provider: doc.provider })
  })
}

export async function deletePersonalCredential(
  userId: string,
  provider: PersonalCredentialProvider,
): Promise<void> {
  const doc = await personalCredentials().findOneAndDelete({ userId, provider })

  if (doc) await revokeQuietly(doc)
}

export async function deleteAllPersonalCredentials(userId: string): Promise<void> {
  await Promise.all(PERSONAL_CREDENTIAL_PROVIDERS.map((p) => deletePersonalCredential(userId, p)))
}

export { personalGithubToken, personalLinearToken } from './handout'
export type { PersonalToken } from './handout'
