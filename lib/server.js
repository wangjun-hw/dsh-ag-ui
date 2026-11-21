/**
 * AG-UI HTTP + SSE server.
 *
 * One DSH Agent (and persisted Session) per AG-UI `threadId`, created with a
 * stable session id derived from the thread, so a later run can resume it after
 * a plugin reload. One AG-UI run is one DSH turn; committed assistant text and
 * tool events become AG-UI events.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import {
  AgUiError,
  buildCapabilities,
  customEvent,
  parseRunInput,
  runCancelled,
  runError,
  runFinished,
  runStarted,
  sseFrame,
  textContent,
  textEnd,
  textStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart,
} from './protocol.js'

const AG_UI_SESSION_GUIDANCE =
  'An AG-UI frontend is talking to this Session. Your reply text is streamed to that UI. '
  + 'Complete the request within this turn; do not ask interactive questions, because the caller has no answer channel.'

const DEFAULT_AGENT_NAME = 'DeepSeek Harness agent'
const DEFAULT_AGENT_DESCRIPTION =
  "A DeepSeek Harness agent exposed through the AG-UI protocol. It runs with the deployment's configured agent preset and tools and streams text and tool activity."

const CLEANUP_INTERVAL_MS = 60_000

/**
 * Create the AG-UI server, register its routes, and return lifecycle control.
 * @param {{ ctx: object, config: object, logger?: object }} options plugin context and settings.
 */
export function createAgUiServer({ ctx, config, logger }) {
  const agents = ctx.agents
  const webServer = ctx.webServer
  const workingDirectory = ctx.get?.('workingDirectory')
  const defaultModel = ctx.get?.('agentDefaultModel')

  const routePrefix = normalizeRoutePrefix(config.routePrefix)
  const settings = {
    authToken: stringValue(config.authToken),
    corsOrigins: Array.isArray(config.corsOrigins) ? config.corsOrigins.filter(origin => typeof origin === 'string' && origin.length > 0) : [],
    modelProvider: stringValue(config.modelProvider),
    model: stringValue(config.model),
    reasoningEffort: stringValue(config.reasoningEffort),
    maxTokens: positiveInteger(config.maxTokens),
    cwd: stringValue(config.cwd),
    agentPreset: stringValue(config.agentPreset),
    agentName: stringValue(config.agentName) || DEFAULT_AGENT_NAME,
    agentDescription: stringValue(config.agentDescription) || DEFAULT_AGENT_DESCRIPTION,
    agentVersion: stringValue(config.agentVersion) || '1.0.0',
    documentationUrl: stringValue(config.documentationUrl),
    runTimeoutSeconds: positiveInteger(config.runTimeoutSeconds) || 900,
    maxBodyBytes: positiveInteger(config.maxBodyBytes) || 1_048_576,
    maxThreads: positiveInteger(config.maxThreads) || 100,
    cancelOnDisconnect: config.cancelOnDisconnect !== false,
  }

  /** @type {Map<string, object>} thread state by AG-UI threadId */
  const threads = new Map()
  /** @type {Map<string, object>} active job by DSH Session id */
  const jobs = new Map()
  const routeDisposers = []
  let runningRuns = 0
  let lastError
  let disposed = false

  const log = {
    warn: message => safeLog(logger, 'warn', `ag-ui: ${message}`),
    info: message => safeLog(logger, 'info', `ag-ui: ${message}`),
  }

  // ---- HTTP --------------------------------------------------------------

  const handler = async (req, res) => {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      methodNotAllowed(res, 'GET')
      return
    }
    const subpath = pathname === routePrefix ? '' : pathname.startsWith(`${routePrefix}/`) ? pathname.slice(routePrefix.length) : undefined
    if (subpath === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not found')
      return
    }
    const isRunPath = subpath === '' || subpath === '/' || subpath === '/agent' || subpath === '/run'
    const allowed = isRunPath ? 'POST, OPTIONS' : 'GET, HEAD, OPTIONS'
    if (applyCors(req, res, allowed, settings.corsOrigins, settings.authToken.length > 0, log)) return

    if (isRunPath) {
      await handleRun(req, res)
      return
    }
    if (subpath === '/capabilities') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, 'GET, HEAD, OPTIONS')
        return
      }
      writeJson(res, 200, buildCapabilities(settings), req, settings.corsOrigins)
      return
    }
    if (subpath === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, 'GET, HEAD, OPTIONS')
        return
      }
      writeJson(res, 200, {
        ok: lastError === undefined,
        protocolVersion: '1.0',
        endpoint: `${baseUrl()}${routePrefix}`,
        threads: threads.size,
        runs: runningRuns,
        authRequired: settings.authToken.length > 0,
        loopbackOnly: settings.authToken.length === 0,
        corsOrigins: settings.corsOrigins,
        ...(lastError === undefined ? {} : { lastError }),
      }, req, settings.corsOrigins)
      return
    }
    if (subpath === '/info') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, 'GET, HEAD, OPTIONS')
        return
      }
      writeJson(res, 200, {
        name: settings.agentName,
        protocolVersion: '1.0',
        transport: 'http-sse',
        authRequired: settings.authToken.length > 0,
        loopbackOnly: settings.authToken.length === 0,
        corsOrigins: settings.corsOrigins,
        endpoints: {
          run: `${baseUrl()}${routePrefix}`,
          runAliases: [`${baseUrl()}${routePrefix}/agent`, `${baseUrl()}${routePrefix}/run`],
          capabilities: `${baseUrl()}${routePrefix}/capabilities`,
          health: `${baseUrl()}${routePrefix}/health`,
          icon: `${baseUrl()}${routePrefix}/icon.svg`,
        },
        ...(lastError === undefined ? {} : { lastError }),
      }, req, settings.corsOrigins)
      return
    }
    if (subpath === '/icon.svg') {
      await serveIcon(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }

  let iconPromise
  const loadIcon = () => {
    iconPromise ??= readFile(new URL('../icon.svg', import.meta.url), 'utf8').catch((error) => {
      iconPromise = undefined
      throw error
    })
    return iconPromise
  }

  async function serveIcon(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD, OPTIONS')
      return
    }
    let svg
    try {
      svg = await loadIcon()
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('No icon')
      return
    }
    res.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-length': Buffer.byteLength(svg),
      'cache-control': 'public, max-age=3600',
      ...corsHeaders(req, settings.corsOrigins),
    })
    res.end(req.method === 'HEAD' ? undefined : svg)
  }

  try {
    routeDisposers.push(webServer.register({ kind: 'prefix', path: routePrefix, handler }))
  } catch (error) {
    throw error
  }

  const sweep = setInterval(() => {
    if (disposed) return
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const [threadId, thread] of threads) {
      if (thread.runningRun !== undefined || thread.lastUsed > cutoff) continue
      threads.delete(threadId)
      thread.handlePromise.then(handle => handle.dispose()).catch(() => {})
    }
  }, CLEANUP_INTERVAL_MS)
  sweep.unref?.()

  // ---- Run handling ------------------------------------------------------

  /** Handle one POSTed RunAgentInput and stream its events. */
  async function handleRun(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST, OPTIONS', 'content-type': 'text/plain; charset=utf-8' })
      res.end(`Method not allowed; POST a RunAgentInput to this URL. GET ${routePrefix}/info for endpoints.`)
      return
    }
    if (!authorized(req)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer realm="ag-ui"',
        ...corsHeaders(req, settings.corsOrigins),
      })
      res.end(JSON.stringify({
        error: {
          code: 'unauthorized',
          message: settings.authToken.length > 0
            ? 'A bearer token is required for this endpoint.'
            : 'This endpoint accepts loopback callers only; configure authToken to allow remote callers.',
        },
      }))
      return
    }
    let body
    try {
      body = await readBody(req, settings.maxBodyBytes)
    } catch (error) {
      if (error instanceof HttpError) {
        writeJson(res, error.status, { error: { code: 'request_too_large', message: error.message } }, req, settings.corsOrigins)
      } else {
        writeJson(res, 400, { error: { code: 'bad_request', message: 'The request body could not be read.' } }, req, settings.corsOrigins)
      }
      return
    }
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch (error) {
      writeJson(res, 400, { error: { code: 'parse_error', message: `Invalid JSON: ${error.message}` } }, req, settings.corsOrigins)
      return
    }
    let input
    try {
      input = parseRunInput(parsed)
    } catch (error) {
      if (error instanceof AgUiError) {
        writeJson(res, error.status, { error: { code: error.code, message: error.message } }, req, settings.corsOrigins)
        return
      }
      throw error
    }
    if (disposed) {
      writeJson(res, 503, { error: { code: 'shutting_down', message: 'The AG-UI bridge is shutting down.' } }, req, settings.corsOrigins)
      return
    }
    const current = threads.get(input.threadId)
    if (current?.runningRun !== undefined) {
      writeJson(res, 409, {
        error: {
          code: 'run_in_progress',
          message: `Thread ${input.threadId} already has a run in progress. Wait for it to finish or disconnect it.`,
        },
      }, req, settings.corsOrigins)
      return
    }

    const sse = openSse(req, res, settings.corsOrigins)
    sse.send(runStarted(input.threadId, input.runId))
    runningRuns += 1

    const thread = threadFor(input.threadId)
    const job = {
      threadId: input.threadId,
      runId: input.runId,
      thread,
      sse,
      agent: undefined,
      messageId: undefined,
      turn: undefined,
      lastAssistantMessageId: undefined,
      attempts: new Map(),
      liveTextByStep: new Map(),
      liveMessagesByStep: new Map(),
      messageIdByStep: new Map(),
      finalized: false,
      disconnected: false,
      timedOut: false,
      timer: undefined,
    }
    // A run could have been admitted between the check above and here only
    // through reentrancy, which this synchronous section excludes.
    thread.runningRun = job
    thread.lastUsed = Date.now()

    sse.onClose(() => {
      if (job.finalized) return
      job.disconnected = true
      if (job.agent !== undefined && settings.cancelOnDisconnect) {
        try {
          job.agent.cancel({ kind: 'user' })
        } catch {
          // The agent is already tearing down.
        }
      }
      finalizeJob(job)
    })

    if (input.unsupportedParts.length > 0) {
      sse.send(customEvent('dsh.unsupported_content', {
        types: [...new Set(input.unsupportedParts)],
        message: 'Non-text user content is not supported by this bridge and was omitted.',
      }))
    }

    let handle
    try {
      handle = await thread.handlePromise
      lastError = undefined
    } catch (error) {
      lastError = errorChain(error)
      log.warn(`could not open thread ${input.threadId}: ${errorChain(error)}`)
      finalizeJob(job, runError(`Could not create the agent for this thread: ${errorChain(error)}`, 'agent_unavailable'))
      return
    }
    if (job.disconnected) {
      finalizeJob(job)
      return
    }
    job.agent = handle.agent
    jobs.set(handle.agent.id, job)
    let message
    try {
      message = createUserMessage({ content: [{ type: 'text', text: input.prompt }], source: { kind: 'user' } })
      job.messageId = message.id
      handle.agent.followup(message)
    } catch (error) {
      finalizeJob(job, runError(`The agent did not accept this run: ${errorChain(error)}`, 'agent_rejected'))
      return
    }
    job.timer = setTimeout(() => {
      if (job.finalized) return
      job.timedOut = true
      try {
        job.agent?.cancel({ kind: 'user' })
      } catch {
        // Teardown already stopped the turn.
      }
      finalizeJob(job, runError(`The run did not finish within ${settings.runTimeoutSeconds} seconds.`, 'timeout'))
    }, settings.runTimeoutSeconds * 1000)
    job.timer.unref?.()
  }

  /** Return or create the thread state for one AG-UI threadId. */
  function threadFor(threadId) {
    const existing = threads.get(threadId)
    if (existing !== undefined) {
      existing.lastUsed = Date.now()
      return existing
    }
    const sessionId = brandString(`agui-${createHash('sha256').update(threadId).digest('hex').slice(0, 32)}`)
    const thread = {
      threadId,
      sessionId,
      handlePromise: openThreadAgent(sessionId),
      handle: undefined,
      agent: undefined,
      runningRun: undefined,
      lastUsed: Date.now(),
    }
    thread.handlePromise.then(
      (handle) => {
        thread.handle = handle
        thread.agent = handle.agent
      },
      (error) => {
        threads.delete(threadId)
        log.warn(`thread agent creation failed: ${errorChain(error)}`)
      },
    )
    evictThreads(settings.maxThreads - 1)
    threads.set(threadId, thread)
    return thread
  }

  /** Resolve a persisted Session or create a fresh one for a thread. */
  async function openThreadAgent(sessionId) {
    const agentOptions = {}
    if (settings.modelProvider.length > 0) agentOptions.provider = settings.modelProvider
    if (settings.model.length > 0) agentOptions.model = settings.model
    if (settings.reasoningEffort.length > 0) agentOptions.reasoningEffort = settings.reasoningEffort
    if (settings.maxTokens > 0) agentOptions.maxTokens = settings.maxTokens
    if (agentOptions.provider === undefined || agentOptions.model === undefined) {
      try {
        const selection = defaultModel?.currentSelection?.()
        if (selection?.provider !== undefined && agentOptions.provider === undefined) agentOptions.provider = selection.provider
        if (selection?.model !== undefined && agentOptions.model === undefined) agentOptions.model = selection.model
      } catch {
        // Leave the route to the loop's defaults.
      }
    }
    const presets = ctx.get?.('agentPresets')
    let presetId = settings.agentPreset.length > 0 ? settings.agentPreset : undefined
    if (presets !== undefined && presetId === undefined) {
      try {
        presetId = (await presets.resolve()).id
      } catch {
        // No registry default: run with the global composition only.
      }
    }
    const cwd = settings.cwd.length > 0
      ? settings.cwd
      : (workingDirectory?.defaultDirectory ?? process.cwd())
    const options = {
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      setup: async (agentCtx) => {
        if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
        try {
          agentCtx.get?.('systemPrompt')?.section?.({
            name: 'ag-ui:frontend',
            order: 3250,
            text: AG_UI_SESSION_GUIDANCE,
          })
        } catch {
          // A composition without the prompt registry still runs the turn.
        }
      },
    }
    try {
      return await agents.resume({ resumeSessionId: sessionId, ...options })
    } catch {
      return await agents.create({
        sessionId,
        meta: { cwd, ...(presetId !== undefined ? { agentPreset: presetId } : {}) },
        ...options,
      })
    }
  }

  /** Keep the thread map bounded by disposing idle, least-recently-used agents. */
  function evictThreads(targetSize) {
    if (threads.size <= targetSize) return
    const idle = [...threads.values()]
      .filter(thread => thread.runningRun === undefined)
      .sort((left, right) => left.lastUsed - right.lastUsed)
    while (threads.size > targetSize && idle.length > 0) {
      const victim = idle.shift()
      threads.delete(victim.threadId)
      victim.handlePromise.then(handle => handle.dispose()).catch(() => {})
    }
  }

  // ---- DSH event projection ---------------------------------------------

  const offSession = ctx.on('session/event', (session, event) => {
    const job = jobs.get(session.header.id)
    if (job === undefined || job.finalized || job.agent?.session !== session) return
    if (event.type === 'assistant/message') {
      if (job.turn === undefined || event.data.turn !== job.turn) return
      const step = event.data.step
      const text = assistantText(event.data.message)
      const streamed = job.liveTextByStep.get(step)
      if (streamed !== undefined) {
        const liveId = closeLiveMessage(job, step)
        job.liveTextByStep.delete(step)
        if (text.length === 0 || text === streamed) {
          if (liveId !== undefined) job.messageIdByStep.set(step, liveId)
          return
        }
      }
      if (text.length === 0) return
      const messageId = String(event.data.message.id)
      job.sse.send(textStart(messageId))
      job.sse.send(textContent(messageId, text))
      job.sse.send(textEnd(messageId))
      job.lastAssistantMessageId = messageId
      job.messageIdByStep.set(step, messageId)
      return
    }
    if (event.type === 'tool/call') {
      if (job.turn === undefined || event.data.turn !== job.turn) return
      const callId = String(event.data.callId)
      const parentMessageId = job.messageIdByStep.get(event.data.step) ?? job.lastAssistantMessageId
      job.sse.send(toolCallStart(callId, event.data.name, parentMessageId))
      job.sse.send(toolCallArgs(callId, event.data.arguments))
      job.sse.send(toolCallEnd(callId))
      return
    }
    if (event.type === 'tool/result') {
      if (job.turn === undefined || event.data.turn !== job.turn) return
      const message = event.data.message
      const content = assistantText(message)
      job.sse.send(toolCallResult(
        String(message.id),
        String(message.toolCallId),
        content.length > 0 ? content : message.isError === true ? 'The tool failed without output.' : 'The tool returned no textual output.',
      ))
      return
    }
    if (event.type === 'turn/end') {
      if (job.turn === undefined || event.data.turn !== job.turn) return
      const reason = event.data.reason
      if (job.timedOut) finalizeJob(job)
      else if (reason.kind === 'completed') finalizeJob(job, runFinished(job.threadId, job.runId))
      else if (reason.kind === 'aborted') finalizeJob(job, runCancelled(job.threadId, job.runId))
      else if (reason.kind === 'error') finalizeJob(job, runError(`The agent turn failed: ${reason.error?.message ?? 'unknown error'}`, 'agent_error'))
      else if (reason.kind === 'max-tokens') finalizeJob(job, runError('The model reached its output token limit before finishing.', 'max_tokens'))
      else if (reason.kind === 'blocked') finalizeJob(job, runError('The agent blocked this run.', 'blocked'))
      else finalizeJob(job, runError(`The agent turn ended as ${reason.kind}.`, 'agent_error'))
    }
  })

  const offClaimed = ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const job = jobs.get(agent.id)
    if (job === undefined || job.finalized || job.agent !== agent) return
    if (job.messageId === message.id) job.turn = turn
  })

  const offAssistantStream = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const job = jobs.get(agent.id)
    if (job === undefined || job.finalized || job.agent !== agent) return
    if (frame.type === 'start') {
      if (job.turn === undefined || frame.turn !== job.turn) return
      job.attempts.set(frame.attemptId, { turn: frame.turn, step: frame.step, messageId: undefined })
      return
    }
    const attempt = job.attempts.get(frame.attemptId)
    if (attempt === undefined) return
    if (frame.type === 'chunk') {
      if (frame.chunk.type !== 'text-delta' || frame.chunk.text.length === 0) return
      let messageId = job.liveMessagesByStep.get(attempt.step)
      if (messageId === undefined) {
        messageId = `agui-${frame.attemptId}`
        job.liveMessagesByStep.set(attempt.step, messageId)
        job.messageIdByStep.set(attempt.step, messageId)
        job.lastAssistantMessageId = messageId
        job.sse.send(textStart(messageId))
      }
      job.liveTextByStep.set(attempt.step, (job.liveTextByStep.get(attempt.step) ?? '') + frame.chunk.text)
      job.sse.send(textContent(messageId, frame.chunk.text))
      return
    }
    if (frame.type === 'end') {
      const closedId = closeLiveMessage(job, attempt.step)
      if (frame.outcome.kind !== 'committed') {
        job.liveTextByStep.delete(attempt.step)
        job.messageIdByStep.delete(attempt.step)
        if (job.lastAssistantMessageId === closedId) job.lastAssistantMessageId = undefined
      }
      job.attempts.delete(frame.attemptId)
    }
  })

  const offError = ctx.on('agent/error', ({ agent, turn, error }) => {
    const job = jobs.get(agent.id)
    if (job === undefined || job.finalized || job.agent !== agent) return
    if (job.turn === undefined || job.turn === turn) job.agentError = error
  })

  /** Close one live text message and return its id. */
  function closeLiveMessage(job, step) {
    const messageId = job.liveMessagesByStep.get(step)
    if (messageId === undefined) return undefined
    job.liveMessagesByStep.delete(step)
    job.sse.send(textEnd(messageId))
    job.lastAssistantMessageId = messageId
    return messageId
  }

  /** Finish one run exactly once and release its thread. */
  function finalizeJob(job, terminalEvent) {
    if (job.finalized) return
    job.finalized = true
    if (job.timer !== undefined) clearTimeout(job.timer)
    for (const step of [...job.liveMessagesByStep.keys()]) closeLiveMessage(job, step)
    if (job.agent !== undefined) jobs.delete(job.agent.id)
    if (job.thread.runningRun === job) job.thread.runningRun = undefined
    job.thread.lastUsed = Date.now()
    runningRuns = Math.max(0, runningRuns - 1)
    if (job.disconnected) return
    if (terminalEvent !== undefined) job.sse.send(terminalEvent)
    job.sse.end()
  }

  // ---- Agent card-like helpers ------------------------------------------

  function baseUrl() {
    try {
      return webServer.getOrigin()
    } catch {
      return `http://127.0.0.1${webServer.port === undefined ? '' : `:${webServer.port}`}`
    }
  }

  /** Check the configured bearer token, or loopback when no token is configured. */
  function authorized(req) {
    if (settings.authToken.length === 0) return isLoopbackAddress(req.socket?.remoteAddress)
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const given = Buffer.from(match[1], 'utf8')
    const expected = Buffer.from(settings.authToken, 'utf8')
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  // ---- Cleanup -----------------------------------------------------------

  /** Remove routes, end streams, and dispose thread agents. */
  async function dispose() {
    if (disposed) return
    disposed = true
    clearInterval(sweep)
    for (const remove of routeDisposers.splice(0)) {
      try {
        remove()
      } catch {
        // Route removal is best-effort during unload.
      }
    }
    try {
      offSession()
      offClaimed()
      offAssistantStream()
      offError()
    } catch {
      // Listener removal during context teardown.
    }
    for (const job of [...jobs.values()]) {
      job.finalized = true
      try {
        job.agent?.cancel({ kind: 'user' })
      } catch {
        // Teardown already stopped the agent.
      }
      job.sse.end()
      runningRuns = Math.max(0, runningRuns - 1)
    }
    jobs.clear()
    const handles = []
    for (const thread of threads.values()) {
      handles.push(thread.handlePromise.then(handle => handle.dispose()).catch(() => {}))
    }
    threads.clear()
    await Promise.allSettled(handles)
  }

  return {
    dispose,
    stats: () => ({ threads: threads.size, runs: runningRuns }),
    capabilities: () => buildCapabilities(settings),
    endpoint: () => `${baseUrl()}${routePrefix}`,
  }
}

// ---- SSE ---------------------------------------------------------------

/** Open an SSE response and return its writer. */
function openSse(req, res, origins) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
    ...corsHeaders(req, origins),
  })
  res.flushHeaders?.()
  let closed = false
  const closeListeners = []
  const ping = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n')
  }, 15_000)
  ping.unref?.()
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(ping)
    for (const listener of closeListeners) {
      try {
        listener()
      } catch {
        // Subscriber cleanup only.
      }
    }
  }
  res.on('close', cleanup)
  return {
    send(event) {
      if (closed) return
      res.write(sseFrame(event))
    },
    end() {
      if (closed) return
      cleanup()
      try {
        res.end()
      } catch {
        // The client already closed the connection.
      }
    },
    onClose(listener) {
      closeListeners.push(listener)
    },
  }
}

// ---- Small HTTP helpers -------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function stringValue(value) {
  return typeof value === 'string' ? value : ''
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function normalizeRoutePrefix(value) {
  let prefix = stringValue(value).trim()
  if (prefix.length === 0) prefix = '/ag-ui'
  if (!prefix.startsWith('/')) prefix = `/${prefix}`
  prefix = prefix.replace(/\/+$/, '')
  return prefix.length === 0 ? '/ag-ui' : prefix
}

function safeLog(logger, level, message) {
  try {
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](message)
  } catch {
    // Logging never affects protocol behavior.
  }
}

function corsHeaders(req, origins) {
  const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin : undefined
  if (origin === undefined) return {}
  if (isSameOrigin(req, origin)) return {}
  if (!origins.includes('*') && !origins.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'vary': 'origin',
    'access-control-allow-headers': 'authorization, content-type, accept, ag-ui-version',
    'access-control-allow-methods': 'POST, GET, HEAD, OPTIONS',
    'access-control-expose-headers': 'content-type',
  }
}

/** Whether the request's Origin names the authority the request was sent to. */
function isSameOrigin(req, origin) {
  try {
    const parsed = new URL(origin)
    const host = req?.headers?.host
    return typeof host === 'string' && host.length > 0 && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Answer a CORS preflight or reject a cross-origin request.
 *
 * Cross-origin access requires both an allowed origin and an auth token:
 * a browser page on the same machine is loopback, so an open CORS policy
 * without a token would let any visited page drive the agent.
 *
 * @returns true when the request was answered and must not continue.
 */
function applyCors(req, res, methods, origins, authConfigured, log) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  if (origin === undefined) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': methods, 'access-control-max-age': '600' })
      res.end()
      return true
    }
    return false
  }
  if (isSameOrigin(req, origin)) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': methods, 'access-control-max-age': '600' })
      res.end()
      return true
    }
    return false
  }
  const allowed = origins.includes('*') || origins.includes(origin)
  if (!authConfigured) {
    log?.warn(`rejected cross-origin request from ${origin}: CORS requires authToken`)
    writeJson(res, 403, {
      error: {
        code: 'cors_requires_auth',
        message: 'CORS is disabled until authToken is configured; set a token to allow browser clients.',
      },
    }, req, origins)
    return true
  }
  if (!allowed) {
    log?.warn(`rejected cross-origin request from ${origin}: origin is not in corsOrigins`)
    writeJson(res, 403, {
      error: {
        code: 'cors_origin_rejected',
        message: `Origin ${origin} is not allowed by this bridge's corsOrigins.`,
        origin,
      },
    }, req, origins)
    return true
  }
  const headers = corsHeaders(req, origins)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...headers, 'access-control-allow-methods': methods, 'access-control-max-age': '600' })
    res.end()
    return true
  }
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  return false
}

function writeJson(res, status, value, req, origins) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders(req, origins),
  })
  res.end(req?.method === 'HEAD' ? undefined : body)
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'content-type': 'text/plain; charset=utf-8' })
  res.end(`Method not allowed; expected ${allow}`)
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.toLowerCase()
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

/** Join the text blocks of a DSH message. */
function assistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Read a bounded request body as UTF-8 text. */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'Request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
