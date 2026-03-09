import { readConfig, resolveAuthToken } from './config-store.js';
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

export const requestApi = async (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  options: ClientOptions,
): Promise<unknown> => {
  const config = await readConfig();
  const apiUrl = (options.apiUrl ?? config.apiUrl).replace(/\/$/, '');
  const token = resolveAuthToken(config, options.token);

  const response = await fetch(`${apiUrl}${path}`, {
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

export const requestCsvExport = async (
  path: string,
  options: ClientOptions,
): Promise<{ csv: string; filename: string }> => {
  const config = await readConfig();
  const apiUrl = (options.apiUrl ?? config.apiUrl).replace(/\/$/, '');
  const token = resolveAuthToken(config, options.token);

  const response = await fetch(`${apiUrl}${path}`, {
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
  const filename = filenameMatch?.[1] ?? 'prodinfos-events-export.csv';
  return { csv, filename };
};

export const requestFileDownload = async (
  path: string,
  options: ClientOptions,
): Promise<{ body: ReadableStream<Uint8Array>; filename: string }> => {
  const config = await readConfig();
  const apiUrl = (options.apiUrl ?? config.apiUrl).replace(/\/$/, '');
  const token = resolveAuthToken(config, options.token);

  const response = await fetch(`${apiUrl}${path}`, {
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
  const filename = filenameMatch?.[1] ?? 'prodinfos-events-export.csv';
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
  const response = await fetch(`${endpoint}${path}`, {
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

export const exchangeClerkJwtForReadonlyToken = async (
  apiUrl: string,
  clerkJwt: string,
): Promise<{ token: string; tenantId?: unknown; projectIds?: unknown }> => {
  const response = await fetch(`${apiUrl}/v1/auth/exchange-clerk`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${clerkJwt}`,
    },
    body: JSON.stringify({}),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.token !== 'string') {
    const err = new Error('Failed to exchange Clerk token') as Error & {
      exitCode?: number;
      payload?: unknown;
    };
    err.exitCode = mapStatusToExitCode(response.status);
    err.payload = payload;
    throw err;
  }

  return {
    token: payload.token,
    tenantId: payload.tenantId,
    projectIds: payload.projectIds,
  };
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
