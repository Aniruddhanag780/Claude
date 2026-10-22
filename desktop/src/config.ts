import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface DesktopConfig {
  port?: number;
  theme?: 'dark' | 'light' | 'system';
  // BCP-47 locale mirrored from the dashboard (en, zh-CN, fr, es, pt-BR).
  locale?: string;
  // Bind the embedded server to 0.0.0.0 instead of 127.0.0.1 so other devices
  // on the LAN / Tailscale can reach it (#442, #418). Off by default: exposes
  // the API, guarded only by the unified key. Applied at next server start.
  lanAccess?: boolean;
  // App version the "macOS is hiding your menu-bar icon" notice was last shown
  // for (#807). Explaining the fix once per version is enough; the tray can stay
  // hidden for as long as the user wants it hidden.
  trayHiddenNoticeVersion?: string;
  // Show the app in the Dock as well as the menu bar. On by default: the tray
  // icon alone is a poor "is it running?" signal, and macOS 26 can hide it
  // outright (#807). Users who want the lean menu-bar-only look turn it off.
  showInDock?: boolean;
  // Set once the dashboard has been opened at startup to show a first-time
  // Windows user the app is running; the tray icon starts out hidden in the
  // overflow flyout there (#1353).
  launchDashboardShown?: boolean;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

// A missing file is a first run and yields defaults. A file that exists but
// cannot be read or parsed is NOT treated as empty: the next saveConfig would
// overwrite it with defaults and the user's settings would be gone without a
// trace. Move it aside so it survives for inspection, and say so loudly.
export function loadConfig(): DesktopConfig {
  const file = configPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[desktop] could not read ${file}; using defaults for this session:`, err);
    }
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as DesktopConfig;
    throw new Error('config root is not a JSON object');
  } catch (err) {
    const quarantined = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, quarantined);
      console.error(`[desktop] ${file} is corrupt; moved it to ${quarantined} and using defaults:`, err);
    } catch (renameErr) {
      console.error(`[desktop] ${file} is corrupt and could not be moved aside; using defaults:`, err, renameErr);
    }
    return {};
  }
}

// Write to a temp file in the same directory and rename it over config.json,
// so a crash or full disk mid-write can never leave a truncated config behind.
export function saveConfig(cfg: DesktopConfig): void {
  const file = configPath();
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    console.error('[desktop] could not persist config:', err);
  }
}
