import { createRequire } from 'node:module';
import { readCliEnv } from './env.js';
import {
  ONBOARDING_EVENTS,
  ONBOARDING_PROGRESS_EVENT_ORDER,
  ONBOARDING_SCREEN_EVENT_PREFIXES as SHARED_ONBOARDING_SCREEN_EVENT_PREFIXES,
  PAYWALL_ANCHOR_EVENT_CANDIDATES,
  PAYWALL_JOURNEY_EVENT_ORDER as SHARED_PAYWALL_JOURNEY_EVENT_ORDER,
  PAYWALL_SKIP_EVENT_CANDIDATES,
  PURCHASE_SUCCESS_EVENT_CANDIDATES,
} from './shared-contract.js';

export const env = readCliEnv();
export const CLI_WRITE_COMMANDS_ENABLED = env.ANALYTICSCLI_CLI_ENABLE_WRITE_COMMANDS;
export const CLI_DEV_COMMANDS_ENABLED = env.ANALYTICSCLI_CLI_ENABLE_DEV_COMMANDS;

const packageManifest = createRequire(import.meta.url)('../package.json') as {
  version: string;
};

// Keep runtime telemetry, update checks, Commander output, and release tags on
// the same source of truth. Changesets updates package.json during releases.
export const CLI_VERSION = packageManifest.version;
export const SKILL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SKILL_SYNC_TIMEOUT_MS = 4000;
export const CLI_VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CLI_VERSION_CHECK_TIMEOUT_MS = 2500;
export const SKILLS_PUBLIC_REPO_SLUG = 'wotaso/analyticscli-skills';
export const SKILLS_PUBLIC_REPO_URL = `https://github.com/${SKILLS_PUBLIC_REPO_SLUG}`;
export const OPENCLAW_GROWTH_SKILL_NAME = 'openclaw-growth-engineer' as const;
export const OPENCLAW_GROWTH_SKILL_PUBLIC_REPO_SLUG = 'Wotaso/openclaw-growth-engineer-skill';
export const ANALYTICSCLI_SETUP_SKILL_NAMES = ['analyticscli-cli', 'analyticscli-ts-sdk'] as const;
export const ANALYTICSCLI_OPENCLAW_SETUP_SKILL_NAMES = [OPENCLAW_GROWTH_SKILL_NAME] as const;
export const ANALYTICSCLI_AUTO_REFRESH_SKILL_NAMES = ['analyticscli-cli'] as const;
export const ANALYTICSCLI_OPENCLAW_AUTO_REFRESH_SKILL_NAMES = [] as const;
export const CLAWHUB_SITE_URL = 'https://clawhub.com';
export const KEYCHAIN_SERVICE = 'com.analyticscli.cli.token';
export const KEYCHAIN_ACCOUNT = process.env.USER ?? process.env.USERNAME ?? 'default';
export const SELF_TRACKING_ENABLED = Boolean(env.ANALYTICSCLI_SELF_TRACKING_ENABLED);
export const LEGACY_SELF_TRACKING_ENDPOINT = env.ANALYTICSCLI_SELF_TRACKING_ENDPOINT?.replace(/\/$/, '');
export const LEGACY_SELF_TRACKING_ENABLED = Boolean(
  SELF_TRACKING_ENABLED &&
    LEGACY_SELF_TRACKING_ENDPOINT &&
    env.ANALYTICSCLI_SELF_TRACKING_PROJECT_ID &&
    env.ANALYTICSCLI_SELF_TRACKING_API_KEY,
);

export const CLI_RUN_ID = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
export const CLI_ANON_ID = `cli-${CLI_RUN_ID}`;
export const CLI_SESSION_ID = `cli-session-${CLI_RUN_ID}`;

export const ONBOARDING_START_EVENT = ONBOARDING_EVENTS.START;
export const ONBOARDING_CORE_EVENTS = ONBOARDING_PROGRESS_EVENT_ORDER;
export const PAYWALL_JOURNEY_EVENT_ORDER = SHARED_PAYWALL_JOURNEY_EVENT_ORDER;
export const ONBOARDING_SCREEN_EVENT_PREFIXES = SHARED_ONBOARDING_SCREEN_EVENT_PREFIXES;
export const PAYWALL_ANCHOR_EVENTS = PAYWALL_ANCHOR_EVENT_CANDIDATES;
export const PAYWALL_SKIP_EVENTS = PAYWALL_SKIP_EVENT_CANDIDATES;
export const PURCHASE_SUCCESS_EVENTS = PURCHASE_SUCCESS_EVENT_CANDIDATES;
export const ONBOARDING_PAYWALL_SOURCE = 'onboarding' as const;
