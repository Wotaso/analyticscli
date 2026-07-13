import { readConfig, resolveApiUrl, resolveAuthToken } from './config-store.js';
import type { ClientOptions, CollectClientOptions } from './types.js';

export const mapStatusToExitCode = (status: number): number => {
  if (status === 401 || status === 403) {
    return 3;
  }

  if (status >= 400 && status < 500) {
    return 2;
  }

  return 4;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const createNetworkError = (
  url: string,
  error: unknown,
): Error & { exitCode?: number; payload?: unknown } => {
  const cause =
    error instanceof Error && 'cause' in error && error.cause
      ? errorMessage(error.cause)
      : undefined;
  const detail = cause ? `${errorMessage(error)} (${cause})` : errorMessage(error);
  const message = `Could not reach AnalyticsCLI API at ${url}: ${detail}`;
  const typed = new Error(message) as Error & { exitCode?: number; payload?: unknown };
  typed.exitCode = 4;
  typed.payload = {
    error: {
      code: 'NETWORK_ERROR',
      message,
      ...(cause ? { cause } : {}),
    },
  };
  return typed;
};

const fetchWithNetworkError = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw createNetworkError(url, error);
  }
};

export const requestApi = async (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  options: ClientOptions,
): Promise<unknown> => {
  const config = await readConfig();
  const apiUrl = resolveApiUrl(config, options.apiUrl);
  const token = resolveAuthToken(config, options.token);
  const url = `${apiUrl}${path}`;

  const response = await fetchWithNetworkError(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw createResponseError(response.status, data);
  }

  return data;
};

export const requestPublicApi = async (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  options: { apiUrl?: string },
): Promise<unknown> => {
  const config = await readConfig();
  const apiUrl = resolveApiUrl(config, options.apiUrl);
  const url = `${apiUrl}${path}`;
  const response = await fetchWithNetworkError(url, {
    method,
    headers: {
      'content-type': 'application/json',
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok && response.status !== 202 && response.status !== 429) {
    throw createResponseError(response.status, data);
  }
  return data;
};

export const requestCsvExport = async (
  path: string,
  options: ClientOptions,
): Promise<{ csv: string; filename: string }> => {
  const config = await readConfig();
  const apiUrl = resolveApiUrl(config, options.apiUrl);
  const token = resolveAuthToken(config, options.token);
  const url = `${apiUrl}${path}`;

  const response = await fetchWithNetworkError(url, {
    method: 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw createResponseError(response.status, data);
  }

  const csv = await response.text();
  const contentDisposition = response.headers.get('content-disposition') ?? '';
  const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  const filename = filenameMatch?.[1] ?? 'analyticscli-events-export.csv';
  return { csv, filename };
};

export const requestFileDownload = async (
  path: string,
  options: ClientOptions,
): Promise<{ body: ReadableStream<Uint8Array>; filename: string }> => {
  const config = await readConfig();
  const apiUrl = resolveApiUrl(config, options.apiUrl);
  const token = resolveAuthToken(config, options.token);
  const url = `${apiUrl}${path}`;

  const response = await fetchWithNetworkError(url, {
    method: 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    throw createResponseError(response.status, data);
  }

  if (!response.body) {
    throw Object.assign(new Error('Download response did not include a body'), {
      exitCode: 4,
    });
  }

  const contentDisposition = response.headers.get('content-disposition') ?? '';
  const filenameMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  const filename = filenameMatch?.[1] ?? 'analyticscli-events-export.csv';
  return {
    body: response.body,
    filename,
  };
};

export const requestCollect = async (
  path: string,
  body: unknown,
  options: CollectClientOptions,
): Promise<unknown> => {
  const endpoint = options.endpoint.replace(/\/$/, '');
  const url = `${endpoint}${path}`;
  const response = await fetchWithNetworkError(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': options.apiKey,
    },
    body: JSON.stringify(body ?? {}),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw createResponseError(response.status, data);
  }

  return data;
};

const createResponseError = (
  status: number,
  payload: Record<string, unknown>,
): Error & { exitCode?: number; payload?: unknown } => {
  const message =
    typeof payload?.error === 'object' && payload.error && 'message' in payload.error
      ? String((payload.error as { message: unknown }).message)
      : `Request failed with status ${status}`;

  const error = new Error(message) as Error & { exitCode?: number; payload?: unknown };
  error.exitCode = mapStatusToExitCode(status);
  error.payload = payload;
  return error;
};
