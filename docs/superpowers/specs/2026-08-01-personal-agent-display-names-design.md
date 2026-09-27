# Personal Agent Display Names

Date: 2026-08-01  
Target: `/home/youran/Development/family-ai-platform` on `admin-yr`

## Goal

Personal Hermes profiles use account-oriented technical identifiers such as
`zzh` and `nsy`. Those identifiers must never be presented as the assistant's
name. All user-facing interaction surfaces will instead use:

| Internal Hermes profile | User-facing Agent name |
|---|---|
| `zzh` | 于途 |
| `nsy` | 乔晶晶 |

Unmapped profiles, including the currently configured `zzg`, retain their
normalized profile name until a product name is explicitly approved.

## Identity boundary

This is a display-only change. The following durable and Provider-facing
identities remain unchanged:

- Hermes profile names `zzh` and `nsy`;
- Agent refs `agent:hermes-zzh` and `agent:hermes-nsy`;
- Provider refs `provider-profile:hermes-zzh` and
  `provider-profile:hermes-nsy`;
- existing assignments, Threads, Work conversations, Provider sessions,
  messages, attachments, and synchronization events.

The Gateway will derive the display name from a small server-owned allowlist
while building the configured Agent runtime. The existing catalog
reconciliation path will update stored Agent display names idempotently at
startup without a schema or data migration.

## Interaction surfaces

Every interactive surface must consume the catalog display name rather than
reconstructing a name from a profile or Agent ref. This includes:

- Member Agent selectors on desktop and mobile;
- selected-Agent workspace headings and identity indicators;
- Chat and Work composer placeholders, status copy, empty states, and details;
- Assistant message actor labels in Chat and Work;
- Admin Agent catalog, monitor, member mounts, add menus, remove confirmations,
  defaults, and Admin workspace surfaces.

Generic role copy may remain where it describes a role rather than an
identity, but the visible sender of a concrete reply must be the selected
Agent name (`于途` or `乔晶晶`).

## Compatibility and fallback

The mapping is exact and case-normalized after the existing Hermes profile
normalization. Unknown profiles fall back to their normalized identifier. No
new environment variable is introduced, so Preview and future production use
the same deterministic names.

## Testing and acceptance

Implementation follows test-first development:

1. A Gateway configuration test must first fail while expecting `于途` and
   `乔晶晶` from the existing `zzh,nsy` runtime.
2. Member rendering tests must first fail while expecting the concrete Agent
   display name on Assistant Chat and Work message bubbles.
3. Existing routing assertions must continue proving that Hermes receives
   profile arguments `zzh` and `nsy` and that Agent/Provider refs do not change.
4. Admin and Member module tests must remain green so both products consume the
   reconciled catalog name.
5. Preview acceptance must show the renamed Agent in the selector, workspace,
   message actor, and Admin mount UI while preserving the existing conversation
   history.

Only the isolated Preview ports `8791`, `9080`, and `9443` may be restarted for
acceptance. Formal `127.0.0.1:8790` must remain byte-identical to its captured
baseline. The change is committed locally first and is pushed only after user
approval.
