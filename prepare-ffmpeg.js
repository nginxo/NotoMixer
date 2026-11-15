const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (process.platform === 'win32') {
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'prepare-ffmpeg.ps1')
  ], { stdio: 'inherit' });
} else if (process.platform === 'darwin') {
  import('./installer/ffmpeg-macos.mjs')
    .then(({ prepareMacFfmpeg }) => prepareMacFfmpeg())
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
