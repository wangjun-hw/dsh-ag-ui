/**
 * dsh-ag-ui — AG-UI protocol bridge for DeepSeek Harness.
 *
 * Host half serving `POST {routePrefix}` as the AG-UI HTTP + SSE binding:
 * one DSH Agent/Session per AG-UI thread, one DSH turn per run, projected to
 * AG-UI lifecycle, text-message, and tool-call events.
 */

import Schema from '@deepseek-ai/schemastery'
import { createAgUiServer } from './lib/server.js'

/** Plugin name registered with the Loader. */
export const name = 'dsh-ag-ui'

/** Host services required before a route or Agent exists. */
export const inject = ['agents', 'webServer']

/** Plugin configuration. */
export const Config = Schema.object({
  routePrefix: Schema.string().default('/ag-ui').description('Absolute HTTP path of the AG-UI run endpoint.'),
  authToken: Schema.string().default('').description('Require this bearer token on run requests. When empty, only loopback callers are accepted.'),
  corsOrigins: Schema.array(Schema.string()).default([]).description('Browser origins allowed to call the endpoint, for example https://app.example. Empty disables CORS; use * to allow any origin. CORS requires authToken, because a local browser page is also a loopback caller.'),
  modelProvider: Schema.string().default('').description('Model provider for AG-UI sessions; defaults to the deployment default.'),
  model: Schema.string().default('').description('Model for AG-UI sessions; defaults to the deployment default.'),
  reasoningEffort: Schema.string().default('').description('Optional reasoning effort for AG-UI sessions.'),
  maxTokens: Schema.natural().default(0).description('Optional per-request output token cap for AG-UI sessions; 0 omits it.'),
  cwd: Schema.string().default('').description('Workspace directory for AG-UI sessions; defaults to the DSH default workspace directory.'),
  agentPreset: Schema.string().default('').description('Agent preset for AG-UI sessions. Empty uses the deployment default preset, which gives the frontend that preset\u2019s full toolset.'),
  agentName: Schema.string().default('').description('Capability declaration name.'),
  agentDescription: Schema.string().default('').description('Capability declaration description.'),
  agentVersion: Schema.string().default('1.0.0').description('Capability declaration version.'),
  documentationUrl: Schema.string().default('').description('Optional documentation URL in the capability declaration.'),
  runTimeoutSeconds: Schema.natural().default(900).description('Maximum time one run may take before it is canceled and closed with RUN_ERROR.'),
  maxBodyBytes: Schema.natural().default(1048576).description('Maximum RunAgentInput request body size in bytes.'),
  maxThreads: Schema.natural().default(100).description('Maximum live thread Agents; the least-recently-used idle thread is disposed first.'),
  cancelOnDisconnect: Schema.boolean().default(true).description('Cancel the DSH turn when the SSE client disconnects.'),
})

/**
 * Mount the AG-UI server.
 * @param {object} ctx Cordis context carrying `agents` and `webServer`.
 * @param {object} config validated plugin configuration.
 */
export function apply(ctx, config) {
  const logger = ctx.logger
  if ((config.modelProvider.length > 0) !== (config.model.length > 0)) {
    logger?.warn?.('dsh-ag-ui: modelProvider and model should be set together; the missing one falls back to the deployment default.')
  }
  if (config.authToken.length === 0) {
    logger?.info?.('dsh-ag-ui: authToken is empty, so only loopback callers are accepted.')
    if (config.corsOrigins.length > 0) {
      logger?.warn?.('dsh-ag-ui: corsOrigins is set but authToken is empty; cross-origin browser calls are rejected until a token is configured.')
    }
  }
  if (config.agentPreset.length > 0) {
    const presets = ctx.get?.('agentPresets')
    if (presets !== undefined) {
      presets.resolve(config.agentPreset).catch((error) => {
        logger?.warn?.(`dsh-ag-ui: agentPreset ${JSON.stringify(config.agentPreset)} did not resolve: ${String(error)}`)
      })
    }
  }
  const server = createAgUiServer({ ctx, config, logger })
  ctx.effect(() => () => server.dispose())

  let endpoint
  try {
    endpoint = server.endpoint()
  } catch {
    endpoint = undefined
  }
  if (endpoint !== undefined) logger?.info?.(`dsh-ag-ui: AG-UI endpoint ${endpoint}`)
}
