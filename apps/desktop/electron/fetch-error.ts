type ErrorLike = {
  name?: unknown
  message?: unknown
  code?: unknown
  cause?: unknown
  errors?: unknown
  socket?: unknown
}

type SocketInfo = {
  localAddress?: unknown
  localPort?: unknown
  remoteAddress?: unknown
  remotePort?: unknown
  bytesWritten?: unknown
  bytesRead?: unknown
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function endpoint(address: unknown, port: unknown): string | undefined {
  if (typeof address !== 'string' || !address) return undefined

  return typeof port === 'number' ? `${address}:${String(port)}` : address
}

function describeSocket(socket: unknown): string | undefined {
  if (!socket || typeof socket !== 'object') return undefined
  const s = socket as SocketInfo
  const local = endpoint(s.localAddress, s.localPort)
  const remote = endpoint(s.remoteAddress, s.remotePort)
  const parts = [
    local && `local=${local}`,
    remote && `remote=${remote}`,
    typeof s.bytesWritten === 'number' && `written=${String(s.bytesWritten)}`,
    typeof s.bytesRead === 'number' && `read=${String(s.bytesRead)}`,
  ].filter(Boolean)

  return parts.length ? parts.join(' ') : undefined
}

function describeCause(cause: unknown, depth: number): string | undefined {
  if (!cause || typeof cause !== 'object' || depth > 3) return text(cause)
  const e = cause as ErrorLike
  const code = text(e.code)
  const message = text(e.message)
  const name = text(e.name)
  const fallback = message ?? code ?? (name === 'Error' ? undefined : name)
  const head = code && message && !message.includes(code) ? `${code}: ${message}` : fallback
  // Happy-eyeballs connects throw an AggregateError with an empty message.
  const children = Array.isArray(e.errors)
    ? e.errors.map((child) => describeCause(child, depth + 1)).filter(Boolean)
    : []
  const nested = describeCause(e.cause, depth + 1)
  const parts = [
    head,
    children.length ? `[${children.join('; ')}]` : undefined,
    describeSocket(e.socket),
    nested && nested !== head ? `<- ${nested}` : undefined,
  ].filter(Boolean)

  return parts.length ? parts.join(' ') : undefined
}

/** undici's "fetch failed" with the cause it hides (code, sub-errors, socket). */
export function describeFetchError(error: unknown): string {
  const message = text((error as ErrorLike | undefined)?.message) ?? String(error)
  const cause = describeCause((error as ErrorLike | undefined)?.cause, 0)

  return cause ? `${message} (${cause})` : message
}

/** Rethrow a transport failure so its cause survives the IPC boundary, which keeps only `message`. */
export function fetchFailure(error: unknown): unknown {
  if (!(error instanceof Error) || error.name === 'AbortError' || error.name === 'TimeoutError')
    return error
  if (!(error as ErrorLike).cause) return error

  return new Error(describeFetchError(error), { cause: error })
}
