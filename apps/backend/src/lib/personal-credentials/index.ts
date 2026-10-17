// Personal Credentials: a member's own GitHub / Linear grant. The agent's two
// existing credential handouts call personalGithubToken / personalLinearToken
// with the turn's sender and fall back to the team token when they return null.
import { createHash, randomBytes } from 'node:crypto'

import { ObjectId } from 'mongodb'

import { config } from '@/config'
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshTokens } from '@/lib/byos/linear-oauth'
import { getDefaultClientCredentials, getViewer } from '@/lib/byos/linear'
import {
  decryptGithubSecret,
  decryptLinearSecret,
  encryptGithubSecret,
  encryptLinearSecret,
} from '@/lib/byos/secrets'
import { AppError } from '@/lib/errors'
import { logError } from '@/lib/observability'
import { personalCredentialPendingOAuth, personalCredentials } from '@/models'

import {
  exchangeGithubCode,
  getGithubUser,
  githubAuthorizeUrl,
  githubOAuthClient,
  githubUserInstallationIds,
  refreshGithubToken,
  revokeGithubToken,
} from './github'

import type { ProviderTokens } from './github'
import type { EncryptedSecret } from '@/lib/byos/secrets'
import type { PersonalCredential, PersonalCredentialProvider } from '@/models'

const PENDING_TTL_MS = 10 * 60 * 1000
const LINEAR_SCOPE = 'read,write'
const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke'

export const PERSONAL_CREDENTIAL_PROVIDERS = ['github', 'linear'] as const

const seal = (provider: PersonalCredentialProvider, plaintext: string) =>
  provider === 'github' ? encryptGithubSecret(plaintext) : encryptLinearSecret(plaintext)
const open = (provider: PersonalCredentialProvider, envelope: EncryptedSecret) =>
  provider === 'github' ? decryptGithubSecret(envelope) : decryptLinearSecret(envelope)

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

type Identity = Pick<PersonalCredential, 'providerUserId' | 'login' | 'workspaceId' | 'workspaceName'>

/** Exchanges the code, verifies who it belongs to, and stores it for the user that started the flow. */
export async function completePersonalCredentialOAuth(
  provider: PersonalCredentialProvider,
  state: string,
  code: string,
): Promise<PersonalCredentialSummary> {
  const pending = await personalCredentialPendingOAuth().findOneAndDelete({ _id: state, provider })

  if (!pending || pending.expiresAt.getTime() < Date.now()) {
    throw new AppError(400, 'invalid_state', 'This authorization request expired or was already used')
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

// ── Handout ──

export type PersonalToken = { token: string; expiresAt: Date | null; login: string }

const refreshing = new Map<string, Promise<PersonalToken | null>>()

function stillFresh(expiresAt: Date | null): boolean {
  return expiresAt === null || expiresAt.getTime() - 5 * 60_000 > Date.now()
}

async function refresh(doc: PersonalCredential): Promise<PersonalToken | null> {
  if (!doc.encryptedRefreshToken) return null
  const refreshToken = open(doc.provider, doc.encryptedRefreshToken)
  let tokens: ProviderTokens

  try {
    if (doc.provider === 'github') {
      tokens = await refreshGithubToken(refreshToken)
    } else {
      const client = getDefaultClientCredentials()

      if (!client) return null
      tokens = await refreshTokens(client.clientId, client.clientSecret, refreshToken)
    }
  } catch (error) {
    // Another replica may have rotated the refresh token first.
    const latest = await personalCredentials().findOne({ _id: doc._id })

    if (latest && stillFresh(latest.accessTokenExpiresAt) && latest.updatedAt > doc.updatedAt) {
      return {
        token: open(latest.provider, latest.encryptedAccessToken),
        expiresAt: latest.accessTokenExpiresAt,
        login: latest.login,
      }
    }
    // The grant is gone (revoked or expired): drop it so the team token takes over.
    logError('personal_credential.refresh_failed', error, { provider: doc.provider })
    await personalCredentials().deleteOne({ _id: doc._id, updatedAt: doc.updatedAt })

    return null
  }
  await personalCredentials().updateOne(
    { _id: doc._id },
    {
      $set: {
        encryptedAccessToken: seal(doc.provider, tokens.accessToken),
        encryptedRefreshToken: tokens.refreshToken
          ? seal(doc.provider, tokens.refreshToken)
          : doc.encryptedRefreshToken,
        accessTokenExpiresAt: tokens.expiresAt,
        updatedAt: new Date(),
      },
    },
  )

  return { token: tokens.accessToken, expiresAt: tokens.expiresAt, login: doc.login }
}

async function currentToken(doc: PersonalCredential): Promise<PersonalToken | null> {
  if (stillFresh(doc.accessTokenExpiresAt)) {
    return {
      token: open(doc.provider, doc.encryptedAccessToken),
      expiresAt: doc.accessTokenExpiresAt,
      login: doc.login,
    }
  }
  const key = doc._id.toHexString()
  const inflight = refreshing.get(key) ?? refresh(doc).finally(() => refreshing.delete(key))

  refreshing.set(key, inflight)

  return inflight
}

const installationAccess = new Map<string, number>()
const INSTALLATION_ACCESS_TTL_MS = 10 * 60 * 1000

/** The sender's GitHub token, when they connected one that can see this installation. */
export async function personalGithubToken(
  userId: string,
  installationId: number,
): Promise<PersonalToken | null> {
  const doc = await personalCredentials().findOne({ userId, provider: 'github' })
  const current = doc && (await currentToken(doc))

  if (!doc || !current) return null
  const key = `${doc._id.toHexString()}:${String(installationId)}`

  if ((installationAccess.get(key) ?? 0) > Date.now()) return current
  const visible = await githubUserInstallationIds(current.token).catch((error: unknown) => {
    logError('personal_credential.installations_failed', error, { provider: 'github' })

    return []
  })

  if (!visible.includes(installationId)) return null
  installationAccess.set(key, Date.now() + INSTALLATION_ACCESS_TTL_MS)

  return current
}

/** The sender's Linear token, when they connected the same workspace as this binding. */
export async function personalLinearToken(
  userId: string,
  workspaceId: string,
): Promise<PersonalToken | null> {
  const doc = await personalCredentials().findOne({ userId, provider: 'linear', workspaceId })

  return doc ? currentToken(doc) : null
}
