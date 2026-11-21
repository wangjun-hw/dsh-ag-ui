# dsh-ag-ui

AG-UI protocol bridge for DeepSeek Harness. It turns a DSH agent into an
AG-UI backend: a frontend POSTs a `RunAgentInput`, and the bridge answers with
an ordered HTTP + SSE event stream (lifecycle, text messages, tool calls).

The bridge speaks **AG-UI 1.0** as defined by
`https://ag-ui.com/spec/1.0/schema.json` and the HTTP + Server-Sent Events
binding.

## Endpoints

With the default configuration the DSH web origin (for example
`http://127.0.0.1:62839`) serves:

| Path | Purpose |
|---|---|
| `POST /ag-ui` (also `/ag-ui/agent`, `/ag-ui/run`) | Run endpoint: `RunAgentInput` in, SSE events out |
| `GET /ag-ui/capabilities` | `AgentCapabilities` declaration |
| `GET /ag-ui/health` | Liveness, readiness (`ok`, `lastError`), run counters, auth/CORS state |
| `GET /ag-ui/info` | Protocol version, endpoint list, auth/CORS state |
| `GET /ag-ui/icon.svg` | Bridge icon |

```sh
curl -N http://127.0.0.1:62839/ag-ui \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"threadId":"demo","runId":"run-1","messages":[{"id":"m1","role":"user","content":"Reply with exactly AGUI-OK"}]}'
```

The stream starts with `RUN_STARTED`, carries `TEXT_MESSAGE_START` /
`TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END`, and closes with `RUN_FINISHED`
(or `RUN_ERROR`). Tool-using turns additionally stream `TOOL_CALL_START`,
`TOOL_CALL_ARGS`, `TOOL_CALL_END`, and `TOOL_CALL_RESULT`.

## Protocol coverage

| Area | Status |
|---|---|
| HTTP + SSE binding, LF frames, one JSON event per `data:` line | supported |
| `RUN_STARTED`, `RUN_FINISHED` (success/cancelled), `RUN_ERROR` | supported |
| `TEXT_MESSAGE_START/CONTENT/END` with live model deltas | supported |
| `TOOL_CALL_START/ARGS/END/RESULT` (agent-executed tools) | supported |
| `CUSTOM` warning for omitted non-text input | supported |
| `STEP_*` | omitted (a run is one DSH turn) |
| `STATE_SNAPSHOT` / `STATE_DELTA` | not implemented; declared `false` |
| Frontend tools (`RunAgentInput.tools`) | not implemented; declaration says `clientProvided: false` |
| Interrupts / `resume` | not implemented; `resume` input is rejected with HTTP 400 |
| Reasoning events | not emitted; declaration omits reasoning |
| Multimodal input | text parts only; other parts are skipped, declared `false`, and reported in a `CUSTOM` event |
| `MESSAGES_SNAPSHOT` | not emitted |

## Threads and DSH sessions

- One DSH Agent (and persisted Session) is created lazily per AG-UI
  `threadId`.
- The DSH session id is derived deterministically from the hash of `threadId`,
  so a later run resumes the same persisted Session after a plugin reload.
- One AG-UI run is one DSH turn. Only the **last user message** in
  `RunAgentInput.messages` becomes the prompt: the DSH Session is the
  authoritative thread history, and the client's message array is not replayed.
  Keep sending the full history for protocol conformance; the bridge ignores it.
- `context` entries are prepended to the prompt as application-supplied context.
- A thread accepts one run at a time; a concurrent run gets HTTP 409.
- Sessions appear in the DSH session list. Threads live in memory; up to
  `maxThreads` idle thread Agents are kept, and the least-recently-used one is
  disposed first (its Session persists).

## Configuration

Edit the bundle's fields in **Settings > Plugins**, or override the row in the
profile patch:

```yaml
- id: dsh-ag-ui
  name: dsh-ag-ui
  config:
    authToken: change-me
    agentPreset: standard
```

Saving configuration restarts the plugin; live SSE runs are truncated and can
be retried with a new `runId`.

| Field | Default | Meaning |
|---|---|---|
| `routePrefix` | `/ag-ui` | Run endpoint path. |
| `authToken` | — | Bearer token required on run requests; empty accepts loopback only. |
| `corsOrigins` | `[]` | Browser origins allowed by CORS; empty disables CORS. CORS also requires `authToken`. |
| `modelProvider`, `model`, `reasoningEffort`, `maxTokens` | deployment default | Model route for AG-UI sessions. |
| `cwd` | DSH default workspace | Workspace for AG-UI sessions. |
| `agentPreset` | deployment default | Agent preset composed for AG-UI sessions. |
| `agentName`, `agentDescription`, `agentVersion`, `documentationUrl` | generic DSH agent | Capability identity. |
| `runTimeoutSeconds` | `900` | Per-run deadline; a timeout cancels the turn and closes with `RUN_ERROR`. |
| `maxBodyBytes` | `1048576` | Request body limit. |
| `maxThreads` | `100` | Live thread Agents retained before idle eviction. |
| `cancelOnDisconnect` | `true` | Cancel the DSH turn when the SSE client disconnects. |

Turn the bundle off in **Plugins** to unregister the routes; there is no
separate `enabled` field.

## Security

Run requests drive a real DSH agent. Unless `agentPreset` names a restricted
preset, AG-UI sessions mount the deployment's default agent preset (the shipped
`standard` preset in Web), so the frontend inherits its tools: shell, file
edits, network access, subagents, and — in `standard` — plugin management.
Treat the endpoint like shell access:

- keep the DSH web server bound to loopback, or set `authToken`;
- leave `corsOrigins` empty unless a browser UI must call the endpoint; CORS
  itself requires `authToken`, because a page on the same machine is loopback;
- prefer a restricted `agentPreset` (for example `minimal`) for untrusted UIs;
- a run executes with the deployment's usual sandbox and approval policy.

## Limitations

- No shared state, frontend tools, interrupts, or reasoning events.
- Only text user content is used; images, audio, video, and documents are
  skipped with a `CUSTOM` warning.
- The client's `messages` array is not replayed into the DSH Session; deleting
  or diverging the server-side Session changes thread history.
- A run that a client abandons is a truncated run per AG-UI; with
  `cancelOnDisconnect` the bridge cancels the DSH turn instead of orphaning it.
- Tokens live in profile configuration in plaintext; OAuth and per-caller
  authorization are not implemented.
