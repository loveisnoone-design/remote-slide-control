import { execFile } from 'node:child_process';

/** Run AppleScript or JXA through osascript and return stdout. */
export function osascript(script: string, opts: { jxa?: boolean; args?: string[]; timeoutMs?: number } = {}): Promise<string> {
  const argv = [...(opts.jxa ? ['-l', 'JavaScript'] : []), '-e', script, ...(opts.args ?? [])];
  return new Promise((resolve, reject) => {
    execFile('osascript', argv, { timeout: opts.timeoutMs ?? 8000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).trim();
        // -1743: the user has not allowed this app to control the target app (System Settings → Privacy → Automation)
        // -1719 / -25211: assistive access (Accessibility) is needed for keystrokes
        reject(new Error(friendlyAppleScriptError(msg)));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

export function friendlyAppleScriptError(msg: string): string {
  if (/-1743/.test(msg)) return 'macOS blocked control of the presentation app. Allow it in System Settings → Privacy & Security → Automation.';
  if (/-1719|-25211|assistive/i.test(msg)) return 'Keystrokes need Accessibility access. Allow Slide Relay Agent in System Settings → Privacy & Security → Accessibility.';
  return msg || 'AppleScript failed';
}

/** Quote a JS value for embedding into a JXA script. */
export function js(v: unknown): string {
  return JSON.stringify(v);
}

/** Quote a string for embedding into AppleScript. */
export function as(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Keystrokes through System Events (needs Accessibility). With an app name the
 * app is brought to the front first; with null the keys go to the frontmost app.
 */
export async function macKeys(appName: string | null, keys: Array<{ code?: number; text?: string }>): Promise<void> {
  const lines = keys.map((k) => (k.code !== undefined ? `key code ${k.code}` : `keystroke ${as(k.text ?? '')}`)).join('\n    ');
  const activate = appName ? `tell application ${as(appName)} to activate\ndelay 0.05\n` : '';
  const script = `
${activate}tell application "System Events"
    ${lines}
end tell`;
  await osascript(script, { timeoutMs: 5000 });
}

export const KEY = { right: 124, left: 123, down: 125, up: 126, ret: 36 } as const;

/** Is an app running? Uses JXA's running(), which does not need Automation permission. */
export async function isRunning(appName: string): Promise<boolean> {
  try {
    const out = await osascript(`Application(${js(appName)}).running()`, { jxa: true, timeoutMs: 3000 });
    return out === 'true';
  } catch {
    return false;
  }
}
