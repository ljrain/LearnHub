// Standalone background job: refresh all topics, and if new articles landed,
// pop a Windows desktop notification. Designed to be run by Task Scheduler.
// Runs independently of the web server (shares the same SQLite database).
import { execFile } from 'node:child_process';
import { refreshAll } from './src/refresh.js';

function notifyWindows(title, text) {
  if (process.platform !== 'win32') return;
  // Dependency-free toast via a NotifyIcon balloon (rendered as a toast on
  // Windows 10/11). Title/text are passed via env to avoid quoting issues.
  const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.BalloonTipTitle = $env:LH_TITLE
$n.BalloonTipText = $env:LH_TEXT
$n.ShowBalloonTip(15000)
Start-Sleep -Seconds 7
$n.Dispose()`;
  execFile(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', ps],
    { env: { ...process.env, LH_TITLE: title, LH_TEXT: text }, windowsHide: true },
    () => {}
  );
}

(async () => {
  const stamp = new Date().toISOString();
  try {
    const { added, newItems } = await refreshAll(true);
    if (added > 0) {
      const lines = newItems.slice(0, 5).map((i) => '• ' + i.title);
      if (newItems.length > 5) lines.push(`…and ${newItems.length - 5} more`);
      notifyWindows(
        `Learn Hub — ${added} new article${added === 1 ? '' : 's'}`,
        lines.join('\n')
      );
    }
    console.log(`[${stamp}] refresh complete — ${added} new item(s).`);
  } catch (err) {
    console.error(`[${stamp}] refresh failed: ${err.message}`);
    process.exitCode = 1;
  }
})();
