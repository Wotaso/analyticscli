import { requestPublicApi } from './http.js';
import { openExternalUrl } from './shell.js';

type DeviceStartPayload = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

type DevicePollPayload = {
  status: 'authorization_pending' | 'slow_down' | 'authorized';
  accessToken?: string;
  interval?: number;
};

export type DeviceAuthorizationOptions = {
  apiUrl?: string;
  openBrowser?: boolean;
  writeStatus?: (message: string) => void;
  request?: typeof requestPublicApi;
  openUrl?: typeof openExternalUrl;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const requireStartPayload = (payload: unknown): DeviceStartPayload => {
  const candidate = payload as Partial<DeviceStartPayload>;
  if (
    !candidate ||
    typeof candidate.deviceCode !== 'string' ||
    typeof candidate.userCode !== 'string' ||
    typeof candidate.verificationUriComplete !== 'string' ||
    typeof candidate.expiresIn !== 'number' ||
    typeof candidate.interval !== 'number'
  ) {
    throw Object.assign(
      new Error('AnalyticsCLI API returned an invalid device authorization response.'),
      {
        exitCode: 4,
      },
    );
  }
  return candidate as DeviceStartPayload;
};

export const authorizeCliDevice = async (
  options: DeviceAuthorizationOptions = {},
): Promise<string> => {
  const request = options.request ?? requestPublicApi;
  const openUrl = options.openUrl ?? openExternalUrl;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const writeStatus =
    options.writeStatus ?? ((message: string) => process.stderr.write(`${message}\n`));

  const started = requireStartPayload(
    await request('POST', '/v1/auth/cli/device/start', {}, { apiUrl: options.apiUrl }),
  );
  writeStatus(`Authorize this CLI in your browser: ${started.verificationUriComplete}`);
  writeStatus(`Confirmation code: ${started.userCode}`);

  if (options.openBrowser !== false) {
    const opened = openUrl(started.verificationUriComplete);
    if (!opened?.ok) {
      writeStatus('The browser could not be opened automatically. Open the URL above manually.');
    }
  }

  const deadline = now() + started.expiresIn * 1000;
  let intervalSeconds = Math.max(2, started.interval);
  while (now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const payload = (await request(
      'POST',
      '/v1/auth/cli/device/token',
      { deviceCode: started.deviceCode },
      { apiUrl: options.apiUrl },
    )) as DevicePollPayload;

    if (payload.status === 'authorization_pending') continue;
    if (payload.status === 'slow_down') {
      intervalSeconds = Math.max(intervalSeconds + 2, payload.interval ?? 0);
      continue;
    }
    if (payload.status === 'authorized' && typeof payload.accessToken === 'string') {
      return payload.accessToken;
    }
    throw Object.assign(new Error('AnalyticsCLI API returned an invalid device token response.'), {
      exitCode: 4,
    });
  }

  throw Object.assign(new Error('CLI authorization expired before it was approved.'), {
    exitCode: 3,
  });
};
