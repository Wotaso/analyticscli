export const ONBOARDING_EVENTS = {
  START: 'onboarding:start',
  STEP_VIEW: 'onboarding:step_view',
  STEP_COMPLETE: 'onboarding:step_complete',
  COMPLETE: 'onboarding:complete',
  SKIP: 'onboarding:skip',
} as const;

export const ONBOARDING_PROGRESS_EVENT_ORDER = [
  ONBOARDING_EVENTS.COMPLETE,
  ONBOARDING_EVENTS.SKIP,
] as const;

export const PAYWALL_EVENTS = {
  SHOWN: 'paywall:shown',
  SKIP: 'paywall:skip',
} as const;

export const PURCHASE_EVENTS = {
  STARTED: 'purchase:started',
  SUCCESS: 'purchase:success',
  FAILED: 'purchase:failed',
  CANCEL: 'purchase:cancel',
} as const;

export const PAYWALL_JOURNEY_EVENT_ORDER = [
  PAYWALL_EVENTS.SHOWN,
  PAYWALL_EVENTS.SKIP,
  PURCHASE_EVENTS.SUCCESS,
  PURCHASE_EVENTS.FAILED,
] as const;

export const ONBOARDING_SCREEN_EVENT_PREFIXES = ['screen:onboarding', 'screen:onboarding_'] as const;

export const PAYWALL_ANCHOR_EVENT_CANDIDATES = [PAYWALL_EVENTS.SHOWN] as const;

export const PAYWALL_SKIP_EVENT_CANDIDATES = [PAYWALL_EVENTS.SKIP] as const;

export const PURCHASE_SUCCESS_EVENT_CANDIDATES = [PURCHASE_EVENTS.SUCCESS] as const;
