// Starts Google Chrome with a dedicated e2e profile and remote debugging, so Playwright
// can attach to it. Sign in to Google Photos and to sso.by.vincent.mahn.ke in this window
// once; the profile (outside the repo) keeps the sessions. No credentials pass through
// the tests. Usage: npm run e2e:browser
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9333);
export const PROFILE = process.env.E2E_PROFILE || path.join(os.homedir(), '.cache', 'editor-photos-e2e-chrome');
const CHROME = process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');

if (import.meta.url === `file://${process.argv[1]}`) {
    mkdirSync(PROFILE, { recursive: true });
    const child = spawn(CHROME, [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--no-first-run',
        '--no-default-browser-check',
        'https://photos.google.com/',
        'http://localhost:3024/',
    ], { stdio: 'ignore', detached: true });
    child.unref();
    console.log(`Chrome started with profile ${PROFILE} on CDP port ${CDP_PORT}.`);
    console.log('Sign in to Google Photos and to the editor (SSO) in that window, then run: npm run e2e');
}
