import type { TimeseriesPoint } from './render.js';
import { ONBOARDING_SCREEN_EVENT_PREFIXES } from './constants.js';
import type { FlowSelectorPayload, OutputFormat } from './types.js';

export const formatOutput = (format: OutputFormat, payload: unknown): string => {
  if (format === 'json') {
    return JSON.stringify(payload, null, 2);
  }

  if (typeof payload === 'string') {
    return payload;
  }

  return JSON.stringify(payload, null, 2);
};

export const asTimeseriesPoints = (payload: unknown): TimeseriesPoint[] => {
  if (!payload || typeof payload !== 'object' || !('points' in payload)) {
    return [];
  }

  const points = (payload as { points?: unknown }).points;
  if (!Array.isArray(points)) {
    return [];
  }

  return points
    .map((point) => {
      if (!point || typeof point !== 'object') {
        return null;
      }

      const ts = (point as { ts?: unknown }).ts;
      const value = (point as { value?: unknown }).value;
      if (typeof ts !== 'string' || typeof value !== 'number') {
        return null;
      }

      return { ts, value };
    })
    .filter((point): point is TimeseriesPoint => point !== null);
};

export const print = (format: OutputFormat, payload: unknown): void => {
  process.stdout.write(`${formatOutput(format, payload)}\n`);
};

export const parseJsonObjectOption = (
  value: string | undefined,
  optionName: string,
): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error(`${optionName} must be a valid JSON object`), { exitCode: 2 });
  }
};

export const resolveProjectOption = (project: string | undefined): { projectId?: string } => {
  if (!project) {
    return {};
  }

  return { projectId: project };
};

export const normalizeOptionString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const resolveFlowSelectorOption = (options: {
  appVersion?: string;
  flowId?: string;
  flowVersion?: string;
  variant?: string;
  paywallId?: string;
}): { flow?: FlowSelectorPayload } => {
  const flow: FlowSelectorPayload = {
    appVersion: normalizeOptionString(options.appVersion),
    onboardingFlowId: normalizeOptionString(options.flowId),
    onboardingFlowVersion: normalizeOptionString(options.flowVersion),
    experimentVariant: normalizeOptionString(options.variant),
    paywallId: normalizeOptionString(options.paywallId),
  };

  const hasAny = Object.values(flow).some((value) => typeof value === 'string' && value.length > 0);
  return hasAny ? { flow } : {};
};

export const toPercent = (value: number, total: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Number(((value / total) * 100).toFixed(2));
};

export const pickBetterAlias = (
  primaryEventName: string,
  primaryCount: number,
  fallbackEventName: string,
  fallbackCount: number,
): { eventName: string; count: number } => {
  if (fallbackCount > primaryCount) {
    return {
      eventName: fallbackEventName,
      count: fallbackCount,
    };
  }

  return {
    eventName: primaryEventName,
    count: primaryCount,
  };
};

export const isOnboardingScreenEvent = (eventName: string): boolean => {
  const normalized = eventName.toLowerCase();
  return ONBOARDING_SCREEN_EVENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

export const parseIntegerOption = (
  value: unknown,
  optionName: string,
  min: number,
  max: number,
): number => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw Object.assign(
      new Error(`${optionName} must be an integer between ${min} and ${max}.`),
      { exitCode: 2 },
    );
  }
  return numeric;
};

export const parseRetentionDaysOption = (value: unknown): number[] => {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(
      new Error('--days must be a comma-separated list like 1,7,30'),
      { exitCode: 2 },
    );
  }

  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const day = Number(entry);
      if (!Number.isInteger(day) || day < 1 || day > 365) {
        throw Object.assign(
          new Error('--days must only contain integers between 1 and 365'),
          { exitCode: 2 },
        );
      }
      return day;
    });

  const uniqueSorted = [...new Set(parsed)].sort((a, b) => a - b);
  if (uniqueSorted.length === 0 || uniqueSorted.length > 30) {
    throw Object.assign(
      new Error('--days must contain between 1 and 30 unique values'),
      { exitCode: 2 },
    );
  }

  return uniqueSorted;
};
