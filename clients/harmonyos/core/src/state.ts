export interface PersonalContextSummary {
  personDisplayName: string;
  familyDisplayName: string;
  deviceDisplayName: string;
}

export type AppState =
  | { kind: 'launching' }
  | { kind: 'needsPairing' }
  | { kind: 'pairing'; phase: 'input' | 'preview' | 'claiming' }
  | { kind: 'restoringSession' }
  | {
      kind: 'authenticated';
      context: PersonalContextSummary;
      sessionExpiresAt: string;
    }
  | {
      kind: 'offline';
      cachedContext: PersonalContextSummary | null;
      lastSyncedAt: string | null;
    }
  | { kind: 'locked'; protectedState: Extract<AppState, { kind: 'authenticated' | 'offline' }> }
  | { kind: 'authorizationRevoked' }
  | { kind: 'fatalConfigurationError' };

export type AppAction =
  | { type: 'BOOTSTRAP_NO_DEVICE' }
  | { type: 'START_PAIRING' }
  | { type: 'PAIRING_PREVIEWED' }
  | { type: 'PAIRING_CLAIMING' }
  | { type: 'RESTORE_SESSION' }
  | {
      type: 'AUTHENTICATED';
      context: PersonalContextSummary;
      sessionExpiresAt: string;
    }
  | {
      type: 'TRANSPORT_OFFLINE';
      cachedContext: PersonalContextSummary | null;
      lastSyncedAt: string | null;
    }
  | { type: 'LOCK_REQUIRED' }
  | { type: 'UNLOCKED' }
  | { type: 'DEVICE_REVOKED' }
  | { type: 'ACKNOWLEDGE_REVOCATION' }
  | { type: 'FATAL_CONFIGURATION' };

export function initialAppState(): AppState {
  return { kind: 'launching' };
}

export function reduceAppState(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'BOOTSTRAP_NO_DEVICE':
      return { kind: 'needsPairing' };
    case 'START_PAIRING':
      return { kind: 'pairing', phase: 'input' };
    case 'PAIRING_PREVIEWED':
      return { kind: 'pairing', phase: 'preview' };
    case 'PAIRING_CLAIMING':
      return { kind: 'pairing', phase: 'claiming' };
    case 'RESTORE_SESSION':
      return { kind: 'restoringSession' };
    case 'AUTHENTICATED':
      return {
        kind: 'authenticated',
        context: action.context,
        sessionExpiresAt: action.sessionExpiresAt
      };
    case 'TRANSPORT_OFFLINE':
      return {
        kind: 'offline',
        cachedContext: action.cachedContext,
        lastSyncedAt: action.lastSyncedAt
      };
    case 'LOCK_REQUIRED':
      if (state.kind === 'authenticated' || state.kind === 'offline') {
        return { kind: 'locked', protectedState: state };
      }
      return state;
    case 'UNLOCKED':
      return state.kind === 'locked' ? state.protectedState : state;
    case 'DEVICE_REVOKED':
      return { kind: 'authorizationRevoked' };
    case 'ACKNOWLEDGE_REVOCATION':
      return state.kind === 'authorizationRevoked' ? { kind: 'needsPairing' } : state;
    case 'FATAL_CONFIGURATION':
      return { kind: 'fatalConfigurationError' };
  }
}
