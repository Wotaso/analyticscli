import type { TimeseriesPoint } from './render.js';
import { ONBOARDING_SCREEN_EVENT_PREFIXES } from './constants.js';
import type { FlowSelectorPayload, OutputFormat } from './types.js';

export type TrendDirection = 'up' | 'down' | 'flat';

export type SeriesTrend = {
  startValue: number;
  currentValue: number;
  percentChange: number;
  direction: TrendDirection;
};

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

const computePercentChange = (startValue: number, currentValue: number): number => {
  if (!Number.isFinite(startValue) || !Number.isFinite(currentValue)) {
    return 0;
  }

  if (Math.abs(startValue) < 1e-9) {
    if (Math.abs(currentValue) < 1e-9) return 0;
    return currentValue > 0 ? 100 : -100;
  }

  return Number((((currentValue - startValue) / Math.abs(startValue)) * 100).toFixed(2));
};

export const computeTrendFromValues = (values: number[]): SeriesTrend | null => {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }

  const startValue = Number((finite[0] ?? 0).toFixed(4));
  const currentValue = Number((finite[finite.length - 1] ?? 0).toFixed(4));
  const percentChange = computePercentChange(startValue, currentValue);
  const direction: TrendDirection =
    percentChange > 0 ? 'up' : percentChange < 0 ? 'down' : 'flat';

  return {
    startValue,
    currentValue,
    percentChange,
    direction,
  };
};

export const computeTrendFromTimeseriesPoints = (points: TimeseriesPoint[]): SeriesTrend | null => {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  const sorted = [...points].sort((a, b) => a.ts.localeCompare(b.ts));
  return computeTrendFromValues(sorted.map((point) => point.value));
};

export const computeRateTrendFromTimeseriesPoints = (
  numerators: TimeseriesPoint[],
  denominators: TimeseriesPoint[],
  scale = 100,
): SeriesTrend | null => {
  if (!numerators.length || !denominators.length) {
    return null;
  }

  const numeratorByTs = new Map<string, number>();
  for (const point of numerators) {
    numeratorByTs.set(point.ts, point.value);
  }

  const denominatorByTs = new Map<string, number>();
  for (const point of denominators) {
    denominatorByTs.set(point.ts, point.value);
  }

  const timestamps = [...new Set([...numeratorByTs.keys(), ...denominatorByTs.keys()])].sort();
  if (timestamps.length === 0) {
    return null;
  }

  const values = timestamps.map((ts) => {
    const numerator = numeratorByTs.get(ts) ?? 0;
    const denominator = denominatorByTs.get(ts) ?? 0;
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
      return 0;
    }
    return (numerator / denominator) * scale;
  });

  return computeTrendFromValues(values);
};

export const formatTrendSummary = (trend: SeriesTrend | null): string => {
  if (!trend) {
    return 'n/a';
  }

  const signed = trend.percentChange > 0 ? `+${trend.percentChange.toFixed(2)}` : trend.percentChange.toFixed(2);
  return `${trend.direction} ${signed}% (start=${trend.startValue}, current=${trend.currentValue})`;
};

export const resolveTrendInterval = (last: string): '1h' | '1d' => {
  const match = /^([0-9]+)([dhm])$/.exec(String(last).trim());
  if (!match) {
    return '1d';
  }

  const amount = Number(match[1] ?? 0);
  const unit = match[2];
  if (unit === 'h') {
    return amount <= 72 ? '1h' : '1d';
  }
  if (unit === 'm') {
    return '1h';
  }
  return '1d';
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
  source?: string;
}): { flow?: FlowSelectorPayload } => {
  const flow: FlowSelectorPayload = {
    appVersion: normalizeOptionString(options.appVersion),
    onboardingFlowId: normalizeOptionString(options.flowId),
    onboardingFlowVersion: normalizeOptionString(options.flowVersion),
    experimentVariant: normalizeOptionString(options.variant),
    paywallId: normalizeOptionString(options.paywallId),
    source: normalizeOptionString(options.source),
  };

  const hasAny = Object.values(flow).some((value) => typeof value === 'string' && value.length > 0);
  return hasAny ? { flow } : {};
};

export const mergeFlowSelector = (
  base: FlowSelectorPayload | undefined,
  override: Partial<FlowSelectorPayload> | undefined,
): FlowSelectorPayload | undefined => {
  const merged: FlowSelectorPayload = {
    ...(base ?? {}),
    ...(override ?? {}),
  };

  const hasAny = Object.values(merged).some((value) => typeof value === 'string' && value.length > 0);
  return hasAny ? merged : undefined;
};

export const isPaywallJourneyEvent = (eventName: string): boolean => {
  const normalized = eventName.trim().toLowerCase();
  return (
    normalized.startsWith('paywall:') ||
    normalized.startsWith('subscription:') ||
    normalized === 'purchase:success' ||
    normalized === 'paywall:dismissed'
  );
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
