# Member Agent Routing and Chat Clarity Design

Date: 2026-07-29

## Goal

Make the member web experience reliably talk to the selected Hermes profile,
make the selected Agent unmistakable in the main workspace, and make message
composition follow standard chat keyboard behavior.

## Current Failure

Family AI correctly selects personal Hermes profiles by setting
`HERMES_HOME=/home/youran/hermes-personal-assistants` and passing
`-p <profile>`. The installed Hermes `zzh` alias uses the same mechanism.

The gateway then incorrectly appends one global `-m` and `--provider` pair to
Jarvis and every personal profile. Those arguments override each profile's
`config.yaml`. After the profiles were reset to `custom / gpt-5.6-terra`, the
preview still forced `sensenova / deepseek-v4-flash`.

Controlled probes established the boundary:

- `zzh` with the Family AI override failed authentication and then received a
  404 from its fallback model.
- `zzh` using its native profile configuration succeeded.
- Jarvis using its native profile configuration succeeded.

## Design

### 1. Hermes routing

The gateway will continue to use the existing `HermesCliProviderAdapter`.
Personal Agents will continue to receive `profileName`, so Hermes resolves
their isolated configuration, credentials, memories, skills, and sessions from
`profiles/<name>`.

The gateway will stop requiring or passing a global Hermes model and provider.
Jarvis, zzh, nsy, and zzg will each load the model and provider from their own
Hermes configuration.

The adapter's existing external session mapping and `--resume` behavior remain
unchanged. Direct integration with a long-running Hermes ACP server or messaging
multiplex gateway is outside this release.

### 2. Selected Agent clarity

The member workspace header will display a prominent current-Agent identity
derived from the selected assignment. Switching between zzh and Codex will
update all of the following immediately:

- current-Agent badge and display name;
- workspace title, such as `和 zzh 继续聊` or `和 Codex 继续聊`;
- composer placeholder naming the selected Agent.

The sidebar remains the selection control. The main workspace becomes the
authoritative visual confirmation of where the next message will be sent.

No per-Agent color theme or full workspace redesign is included.

### 3. Composer keyboard behavior

In both Chat and Work composers:

- Enter submits;
- Shift+Enter inserts a newline;
- Enter during IME composition does not submit;
- empty content is not submitted;
- button submission and keyboard submission use the same form path.

The existing helper text remains visible and matches the implemented behavior.

## Data Flow

1. The member selects an assignment in the sidebar.
2. The client stores the selected assignment and re-renders the workspace
   identity and composer copy.
3. Submission sends the selected assignment reference through the existing
   gateway route.
4. The provider router chooses the assigned adapter.
5. For Hermes personal Agents, the adapter invokes Hermes with `-p <profile>`
   and without a model or provider override.
6. Hermes loads the profile-local configuration and returns a session marker.
7. Family AI stores the external session reference and uses it for subsequent
   turns.

## Error Handling

- Invalid real-provider configuration still fails closed during startup.
- Missing executable or Hermes home directories remain startup errors.
- Hermes authentication, upstream, timeout, and invalid-response failures keep
  their existing public error mapping.
- A missing or invalid selected assignment continues to be rejected by the
  existing gateway authorization checks.
- UI state must not claim a message was sent when IME composition or empty
  content prevented submission.

## Tests

Implementation follows test-driven development.

Gateway and adapter coverage will prove:

- real mode starts without global Hermes model/provider variables;
- Jarvis invocation does not include `-m` or `--provider`;
- personal invocation includes `-p zzh` but no model/provider override;
- existing session continuation still includes the correct `--resume` value.

Member web coverage will prove:

- switching assignments updates the badge, title, and placeholder;
- Enter submits exactly once;
- Shift+Enter does not submit;
- IME Enter does not submit;
- Chat and Work follow the same behavior.

After focused tests pass, the existing contracts, provider, gateway, typecheck,
and build gates will run. Preview acceptance will exercise both zzh and Codex
from the member entry.

## Rollout and Safety

The first deployment target is the current preview stack on ports
8791/9080/9443. Port 8790 and its official service remain untouched.

The preview must demonstrate:

- a successful real zzh reply;
- a successful Codex reply;
- obvious selected-Agent changes in the main workspace;
- correct Enter, Shift+Enter, and IME behavior.

Repository merge and GitHub synchronization occur only after the automated
gates and preview acceptance pass.

## Non-goals

- dedicated cross-device Hermes session architecture;
- ACP or direct multiplex-gateway transport;
- authentication redesign;
- detailed Agent monitor mode;
- per-Agent visual themes.
