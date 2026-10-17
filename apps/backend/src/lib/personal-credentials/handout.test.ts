import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { ObjectId } from 'mongodb'

import * as githubActual from '@/lib/personal-credentials/github'
import * as sealActual from '@/lib/personal-credentials/seal'
import * as modelsActual from '@/models'

import type { PersonalCredential } from '@/models'

// bun runs every test file in one process: snapshot the real modules now and
// restore them after the suite so these mocks do not leak.
const snapshots = {
  github: { ...githubActual },
  seal: { ...sealActual },
  models: { ...modelsActual },
}

afterAll(async () => {
  await mock.module('@/lib/personal-credentials/github', () => snapshots.github)
  await mock.module('@/lib/personal-credentials/seal', () => snapshots.seal)
  await mock.module('@/models', () => snapshots.models)
})

let rows: PersonalCredential[] = []
let visibleInstallations: number[] = []
let refreshResult: () => Promise<githubActual.ProviderTokens>

const matches = (row: PersonalCredential, filter: Record<string, unknown>) =>
  Object.entries(filter).every(([key, value]) =>
    value instanceof ObjectId
      ? (row as Record<string, unknown>)[key]?.toString() === value.toString()
      : value instanceof Date
        ? ((row as Record<string, unknown>)[key] as Date).getTime() === value.getTime()
        : (row as Record<string, unknown>)[key] === value,
  )

await mock.module('@/models', () => ({
  ...snapshots.models,
  personalCredentials: () => ({
    findOne: (filter: Record<string, unknown>) =>
      Promise.resolve(rows.find((row) => matches(row, filter)) ?? null),
    updateOne: (filter: Record<string, unknown>, update: { $set: Partial<PersonalCredential> }) => {
      rows = rows.map((row) => (matches(row, filter) ? { ...row, ...update.$set } : row))

      return Promise.resolve({})
    },
    deleteOne: (filter: Record<string, unknown>) => {
      rows = rows.filter((row) => !matches(row, filter))

      return Promise.resolve({})
    },
  }),
}))
await mock.module('@/lib/personal-credentials/seal', () => ({
  seal: (_provider: string, plaintext: string) => ({ plaintext }),
  open: (_provider: string, envelope: { plaintext: string }) => envelope.plaintext,
}))
await mock.module('@/lib/personal-credentials/github', () => ({
  ...snapshots.github,
  githubUserInstallationIds: () => Promise.resolve(visibleInstallations),
  refreshGithubToken: () => refreshResult(),
}))

const { personalGithubToken, personalLinearToken } = await import('./handout')

const sealed = (plaintext: string) =>
  ({ plaintext }) as unknown as PersonalCredential['encryptedAccessToken']

function credential(overrides: Partial<PersonalCredential>): PersonalCredential {
  const now = new Date()

  return {
    _id: new ObjectId(),
    userId: 'user-1',
    provider: 'github',
    providerUserId: '42',
    login: 'octocat',
    encryptedAccessToken: sealed('ghu_access'),
    encryptedRefreshToken: sealed('ghr_refresh'),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

beforeEach(() => {
  rows = []
  visibleInstallations = []
  refreshResult = () => Promise.reject(new Error('unexpected refresh'))
})

describe('personalGithubToken', () => {
  test('returns the member token only for an installation they can see', async () => {
    rows = [credential({})]
    visibleInstallations = [7]

    expect(await personalGithubToken('user-1', 7)).toMatchObject({
      token: 'ghu_access',
      login: 'octocat',
    })
    expect(await personalGithubToken('user-1', 8)).toBeNull()
    expect(await personalGithubToken('user-2', 7)).toBeNull()
  })

  test('refreshes an expiring token and stores the rotated pair', async () => {
    rows = [credential({ userId: 'user-3', accessTokenExpiresAt: new Date(Date.now() + 60_000) })]
    visibleInstallations = [7]
    const expiresAt = new Date(Date.now() + 8 * 60 * 60_000)

    refreshResult = () =>
      Promise.resolve({ accessToken: 'ghu_new', refreshToken: 'ghr_new', expiresAt })

    expect(await personalGithubToken('user-3', 7)).toMatchObject({ token: 'ghu_new', expiresAt })
    expect(rows[0]?.encryptedAccessToken).toEqual(sealed('ghu_new'))
    expect(rows[0]?.encryptedRefreshToken).toEqual(sealed('ghr_new'))
  })

  test('drops a grant whose refresh fails so the team token takes over', async () => {
    rows = [credential({ userId: 'user-4', accessTokenExpiresAt: new Date(Date.now() - 1000) })]
    refreshResult = () => Promise.reject(new Error('bad_refresh_token'))

    expect(await personalGithubToken('user-4', 7)).toBeNull()
    expect(rows).toHaveLength(0)
  })
})

describe('personalLinearToken', () => {
  test('applies only to the workspace the member connected', async () => {
    rows = [
      credential({
        provider: 'linear',
        workspaceId: 'org-1',
        encryptedAccessToken: sealed('lin_access'),
        accessTokenExpiresAt: null,
      }),
    ]

    expect(await personalLinearToken('user-1', 'org-1')).toMatchObject({ token: 'lin_access' })
    expect(await personalLinearToken('user-1', 'org-2')).toBeNull()
  })
})
