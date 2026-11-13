// Opens the review in the user's default browser. Never through a shell: the launcher's file:// URL is one argv
// element of a detached child whose failures are ignored, and only that launcher URL is ever accepted.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Only the exact file:// URL of the launcher page that this CLI run just wrote in the private state directory (see
// launcher.js), compared as a string with the one the caller computed independently, not matched against a pattern
// (a state path may legally contain @ = , ( ) and more). The browser's command line is readable by other local users,
// so it never gets the token or even a one-time ticket.
const isExpectedUrl = (url, expected) => typeof url === 'string' && typeof expected === 'string' && url === expected
  && /^file:\/\/\/[\x21-\x7e]+\/[0-9a-f]{16}\.open\.html$/.test(expected) && !expected.includes('/../');

/** { command } (an absolute path, never looked up on PATH) for this platform, or { skip: reason }. */
export function openCommand({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  let command;
  if (platform === 'darwin') command = '/usr/bin/open';
  else if (platform === 'linux') {
    if (!(env.DISPLAY || env.WAYLAND_DISPLAY)) return { skip: 'no-display' };
    command = '/usr/bin/xdg-open';
  } else return { skip: 'unsupported-platform' };
  return exists(command) ? { command } : { skip: 'opener-missing' };
}

/** @returns {{ opened: boolean, reason: string }} reason is the command used, or why nothing was started. Never throws. */
export function openBrowser(url, { expected, platform, env, spawn = nodeSpawn, exists } = {}) {
  if (!isExpectedUrl(url, expected)) return { opened: false, reason: 'bad-url' };
  const target = openCommand({ platform, env, exists });
  if (target.skip) return { opened: false, reason: target.skip };
  try {
    const child = spawn(target.command, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // xdg-open missing, etc.: ignored; the URL is printed anyway
    child.unref();
    return { opened: true, reason: path.basename(target.command) };
  } catch {
    return { opened: false, reason: 'spawn-failed' };
  }
}
