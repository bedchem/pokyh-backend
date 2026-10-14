// Writes dist/build-info.json: which commit this build was made from and
// when. The cluster compares it across nodes to roll updates out
// (src/cluster/updates.ts). The commit comes from POKYH_COMMIT (passed into
// image builds) or from git when the source is a checkout; unknown otherwise.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

const candidate = (process.env.POKYH_COMMIT || '').trim() || gitCommit();
const info = {
  commit: /^[0-9a-f]{40}$/.test(candidate) ? candidate : '',
  builtAt: new Date().toISOString(),
};
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync(path.join('dist', 'build-info.json'), `${JSON.stringify(info)}\n`);
