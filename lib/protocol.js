/**
 * AG-UI protocol 1.0 values, run-input validation, event constructors, and
 * capability declaration.
 *
 * The wire format is the JSON Schema published at
 * https://ag-ui.com/spec/1.0/schema.json: one JSON event per SSE `data:`
 * frame, LF line endings, and a terminal RUN_FINISHED or RUN_ERROR.
 */

/** The protocol version this bridge declares on RUN_STARTED. */
export const PROTOCOL_VERSION = '1.0'

/** A rejected request, delivered as an HTTP error before any stream opens. */
export class AgUiError extends Error {
  /**
   * @param {number} status HTTP status.
   * @param {string} code machine-readable error code.
   * @param {string} message human-readable detail.
   */
  constructor(status, code, message) {
    super(message)
    this.name = 'AgUiError'
    this.status = status
    this.code = code
  }
}

/** Current event timestamp in milliseconds. */
function now() {
  return Date.now()
}

/** Open a run. */
export function runStarted(threadId, runId) {
  return {
    type: 'RUN_STARTED',
    threadId,
    runId,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: now(),
  }
}

/** Close a successful run. */
export function runFinished(threadId, runId) {
  return { type: 'RUN_FINISHED', threadId, runId, timestamp: now() }
}

/** Close a run the producer stopped before completion. */
export function runCancelled(threadId, runId) {
  return {
    type: 'RUN_FINISHED',
    threadId,
    runId,
    outcome: { type: 'cancelled' },
    timestamp: now(),
  }
}

/** End a failed run. */
export function runError(message, code) {
  return {
    type: 'RUN_ERROR',
    message,
    ...(code === undefined ? {} : { code }),
    timestamp: now(),
  }
}

/** Open a streamed text message. */
export function textStart(messageId, role = 'assistant') {
  return { type: 'TEXT_MESSAGE_START', messageId, role, timestamp: now() }
}

/** Append text to a streamed message. */
export function textContent(messageId, delta) {
  return { type: 'TEXT_MESSAGE_CONTENT', messageId, delta, timestamp: now() }
}

/** Close a streamed text message. */
export function textEnd(messageId) {
  return { type: 'TEXT_MESSAGE_END', messageId, timestamp: now() }
}

/** Open a tool call. */
export function toolCallStart(toolCallId, toolCallName, parentMessageId) {
  return {
    type: 'TOOL_CALL_START',
    toolCallId,
    toolCallName,
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
    timestamp: now(),
  }
}

/** Append tool arguments. */
export function toolCallArgs(toolCallId, delta) {
  return { type: 'TOOL_CALL_ARGS', toolCallId, delta, timestamp: now() }
}

/** Close a tool call's arguments. */
export function toolCallEnd(toolCallId) {
  return { type: 'TOOL_CALL_END', toolCallId, timestamp: now() }
}

/** Carry a tool result as its own tool message. */
export function toolCallResult(messageId, toolCallId, content) {
  return { type: 'TOOL_CALL_RESULT', messageId, toolCallId, content, timestamp: now() }
}

/** Pass an application-specific event through. */
export function customEvent(name, value) {
  return { type: 'CUSTOM', name, value, timestamp: now() }
}

/** Serialize one event as an SSE frame. */
export function sseFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`
}

/**
 * Validate and project one `RunAgentInput`.
 *
 * Only the last user message becomes this run's prompt: the DSH Session is the
 * authoritative thread history, and the client's message array is not replayed
 * into it. Frontend tools and shared state are not implemented; their input is
 * accepted and ignored, except a last message that is a tool result, which has
 * no user turn to run.
 *
 * @param {unknown} body parsed JSON request body.
 * @returns {{ threadId: string, runId: string, prompt: string, userMessageId: string, unsupportedParts: string[] }}
 */
export function parseRunInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgUiError(400, 'invalid_run_input', 'RunAgentInput must be a JSON object')
  }
  const threadId = requireString(body.threadId, 'threadId')
  const runId = requireString(body.runId, 'runId')
  if (body.protocolVersion !== undefined) {
    if (typeof body.protocolVersion !== 'string') {
      throw new AgUiError(400, 'invalid_run_input', 'protocolVersion must be a string')
    }
    const major = body.protocolVersion.split('.')[0]
    if (major !== '1' && major !== '0') {
      throw new AgUiError(400, 'unsupported_protocol_version', `Unsupported protocolVersion ${body.protocolVersion}`)
    }
  }
  if (Array.isArray(body.resume) && body.resume.length > 0) {
    throw new AgUiError(400, 'resume_unsupported', 'Interrupt resume is not supported by this agent')
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AgUiError(400, 'invalid_run_input', 'messages must be a non-empty array')
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new AgUiError(400, 'invalid_run_input', 'tools must be an array when present')
  }
  if (body.context !== undefined && !Array.isArray(body.context)) {
    throw new AgUiError(400, 'invalid_run_input', 'context must be an array when present')
  }
  const messages = body.messages
  const last = messages[messages.length - 1]
  if (last === null || typeof last !== 'object' || Array.isArray(last)) {
    throw new AgUiError(400, 'invalid_run_input', 'the last message must be an object')
  }
  if (last.role !== 'user') {
    throw new AgUiError(
      400,
      'last_message_not_user',
      `The last message has role ${JSON.stringify(last.role)}; frontend tool results and non-user tails are not supported. Send a user message to start a run.`,
    )
  }
  const userMessageId = requireString(last.id, 'messages[].id')
  const { text, unsupportedParts } = contentText(last.content)
  const contextLines = contextText(body.context)
  const prompt = contextLines.length > 0
    ? `Application context provided for this run:\n${contextLines}\n\n${text}`
    : text
  return { threadId, runId, prompt, userMessageId, unsupportedParts }
}

/** Require a non-empty string no longer than 512 characters. */
function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgUiError(400, 'invalid_run_input', `${field} must be a non-empty string`)
  }
  if (value.length > 512) throw new AgUiError(400, 'invalid_run_input', `${field} is too long`)
  return value
}

/**
 * Convert user message content to one prompt string.
 * @param {unknown} content a string or an ordered ContentPart array.
 * @returns {{ text: string, unsupportedParts: string[] }}
 */
function contentText(content) {
  if (typeof content === 'string') {
    if (content.length === 0) throw new AgUiError(400, 'invalid_run_input', 'the user message is empty')
    return { text: content, unsupportedParts: [] }
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw new AgUiError(400, 'invalid_run_input', 'the user message content must be a string or a non-empty parts array')
  }
  const texts = []
  const unsupported = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.length > 0) texts.push(part.text)
      continue
    }
    if (typeof part.type === 'string') unsupported.push(part.type)
  }
  if (texts.length === 0) {
    if (unsupported.length === 0) throw new AgUiError(400, 'invalid_run_input', 'the user message contained no content')
    // AG-UI requires skipping unusable content rather than failing the run.
    return {
      text: `[The user sent content this agent cannot read: ${[...new Set(unsupported)].join(', ')}.]`,
      unsupportedParts: unsupported,
    }
  }
  return { text: texts.join('\n\n'), unsupportedParts: unsupported }
}

/** Render AG-UI context entries for the prompt. */
function contextText(context) {
  if (!Array.isArray(context) || context.length === 0) return ''
  return context
    .filter(entry => entry !== null && typeof entry === 'object')
    .map((entry) => {
      const description = typeof entry.description === 'string' ? entry.description : 'Context'
      const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value)
      return `- ${description}: ${value}`
    })
    .join('\n')
}

/**
 * Build the AgentCapabilities declaration for GET /capabilities.
 * @param {object} settings resolved plugin settings.
 */
export function buildCapabilities(settings) {
  return {
    identity: {
      name: settings.agentName,
      type: 'deepseek-harness',
      description: settings.agentDescription,
      version: settings.agentVersion,
      provider: 'DeepSeek Harness',
      ...(settings.documentationUrl.length > 0 ? { documentationUrl: settings.documentationUrl } : {}),
    },
    transport: {
      streaming: true,
      websocket: false,
      httpBinary: false,
      pushNotifications: false,
      resumable: false,
    },
    tools: {
      supported: true,
      clientProvided: false,
    },
    output: {
      supportedMimeTypes: ['text/plain'],
    },
    state: {
      snapshots: false,
      deltas: false,
      memory: false,
      persistentState: false,
    },
    multiAgent: {
      supported: true,
      delegation: true,
      handoffs: false,
    },
    multimodal: {
      input: {
        image: false,
        audio: false,
        video: false,
        pdf: false,
        file: false,
      },
      output: {
        image: false,
        audio: false,
      },
    },
    execution: {
      codeExecution: true,
      maxExecutionTime: settings.runTimeoutSeconds * 1000,
    },
    humanInTheLoop: {
      supported: false,
      approvals: false,
      interventions: false,
      feedback: false,
      interrupts: false,
      approveWithEdits: false,
    },
    custom: {
      dsh: {
        threadSessions: true,
        sharedState: false,
        frontendTools: false,
      },
    },
  }
}
