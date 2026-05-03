// Shared password prompt helper for CLI scripts (raw stdin — no readline echo conflict)

function askPassword(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    let password = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function onData(char) {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '') {
        // Ctrl+C
        process.stdout.write('\n');
        process.exit(0);
      } else if (char === '' || char === '\b') {
        // Backspace
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        password += char;
        process.stdout.write('*');
      }
    }

    process.stdin.on('data', onData);
  });
}

async function askNewPassword(label) {
  const bcrypt = require('bcrypt');
  while (true) {
    const pw = await askPassword(`  ${label}: `);
    if (pw.length < 8) {
      console.log('  ⚠️  Password must be at least 8 characters, try again.');
      continue;
    }
    const confirm = await askPassword('  Confirm password: ');
    if (pw !== confirm) {
      console.log('  ⚠️  Passwords do not match, try again.');
      continue;
    }
    const hash = await bcrypt.hash(pw, 12);
    return hash;
  }
}

module.exports = { askPassword, askNewPassword };
