import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const writeEnvValue = async (
  filePath: string,
  name: string,
  value: string,
): Promise<string> => {
  if (!ENV_NAME_PATTERN.test(name)) {
    throw Object.assign(new Error('--env-name must be a valid environment variable name.'), {
      exitCode: 2,
    });
  }

  const target = resolve(filePath);
  let current = '';
  try {
    current = await readFile(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current}${current.length > 0 && !current.endsWith('\n') ? '\n' : ''}${line}\n`;

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, next, { encoding: 'utf8', mode: 0o600 });
  await chmod(target, 0o600).catch(() => {
    // Best effort for filesystems without POSIX permissions.
  });
  return target;
};
