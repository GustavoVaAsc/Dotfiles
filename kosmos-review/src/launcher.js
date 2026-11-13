// The launcher page that carries the one-time ticket to the browser. A browser's command line (/proc/<pid>/cmdline)
// is readable by other local users for as long as it runs, and a ticket in it could be redeemed for the token. So
// the browser is handed only the file:// URL of this page: a 0600 file in the private state directory that redirects
// to http://127.0.0.1:<port>/#ticket=<ticket>. The server deletes it when the ticket is used and after a short time.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^[0-9a-f]{16}$/;
const TICKET_URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/#ticket=[A-Za-z0-9_-]{16,64}$/;

const launcherFile = (dir, id) => {
  if (!ID_RE.test(id)) throw new Error('invalid review id');
  return path.join(dir, `${id}.open.html`);
};

/** @returns {Promise<{file:string, url:string}>} url is the file:// URL to hand to the opener. */
export async function writeLauncher(dir, id, ticketUrl) {
  if (typeof ticketUrl !== 'string' || !TICKET_URL_RE.test(ticketUrl)) throw new Error('refusing to write anything but our own loopback ticket URL');
  const file = launcherFile(dir, id);
  await fs.rm(file, { force: true }); // a symlink planted at the name is removed, never followed
  const html = `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${ticketUrl}">
<title>Opening the review…</title>
<p>Opening the review… <a href="${ticketUrl}">Click here</a> if nothing happens (the link works once).</p>
`;
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = constants;
  const handle = await fs.open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(html);
  } finally {
    await handle.close();
  }
  return { file, url: pathToFileURL(file).href };
}

export const removeLauncher = (dir, id) => fs.rm(launcherFile(dir, id), { force: true });
