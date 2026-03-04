import { readCliEnv } from '@prodinfos/config';

export const env = readCliEnv();

export const CLI_VERSION = '0.1.0';
export const SKILL_ID = 'prodinfos';
export const SKILL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SKILL_SYNC_TIMEOUT_MS = 4000;
export const OPENCLAW_SKILL_PAGE_URL = 'https://clawhub.ai/skills/prodinfos';
export const KEYCHAIN_SERVICE = 'com.prodinfos.cli.token';
export const KEYCHAIN_ACCOUNT = process.env.USER ?? process.env.USERNAME ?? 'default';
export const SELF_TRACKING_ENDPOINT = env.PRODINFOS_SELF_TRACKING_ENDPOINT?.replace(/\/$/, '');
export const SELF_TRACKING_ENABLED = Boolean(
  env.PRODINFOS_SELF_TRACKING_ENABLED &&
    SELF_TRACKING_ENDPOINT &&
    env.PRODINFOS_SELF_TRACKING_PROJECT_ID &&
    env.PRODINFOS_SELF_TRACKING_API_KEY,
);

export const CLI_RUN_ID = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
export const CLI_ANON_ID = `cli-${CLI_RUN_ID}`;
export const CLI_SESSION_ID = `cli-session-${CLI_RUN_ID}`;

export const ONBOARDING_START_EVENT = 'onboarding:start';
export const ONBOARDING_CORE_EVENTS = [
  'onboarding:complete',
  'onboarding:skip',
] as const;
export const PAYWALL_JOURNEY_EVENT_ORDER = [
  'paywall:shown',
  'paywall:skip',
  'subscription:purchase_success',
  'subscription:purchase_failed',
] as const;
export const ONBOARDING_SCREEN_EVENT_PREFIXES = ['screen:onboarding', 'screen:onboarding_'] as const;
export const PAYWALL_ANCHOR_EVENTS = ['paywall:shown', 'paywall:entry'] as const;
export const PAYWALL_SKIP_EVENTS = ['paywall:skip', 'paywall:dismissed'] as const;
export const PURCHASE_SUCCESS_EVENTS = ['subscription:purchase_success', 'purchase:success'] as const;
export const ONBOARDING_PAYWALL_SOURCE = 'onboarding' as const;
