const fs = require('fs').promises;
const spawn = require('cross-spawn');
const yaml = require('js-yaml');

function delay(time) {
  return new Promise(resolve => setTimeout(resolve, time));
}

function transifexRequest(url, {
  method = 'GET',
  responseType = 'json',
  data = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', [
      '-sSL',
      '--user',
      `api:${process.env.TRANSIFEX_TOKEN}`,
      '-X',
      method,
      '-H',
      'Content-Type: application/json',
      ...data == null ? [] : ['-d', '@-'],
      `https://www.transifex.com${url}`,
    ], { stdio: ['pipe', 'pipe', 'inherit'] });
    if (data != null) {
      child.stdin.write(JSON.stringify(data));
      child.stdin.end();
    }
    const stdoutBuffer = [];
    child.stdout.on('data', chunk => {
      stdoutBuffer.push(chunk);
    })
    child.on('exit', (code) => {
      if (code) {
        reject(code);
        return;
      }
      let result = Buffer.concat(stdoutBuffer).toString('utf8');
      if (responseType === 'json') {
        try {
          result = JSON.parse(result);
        } catch (err) {
          console.error('stdout: ' + result);
          reject(err);
          return;
        }
      }
      resolve(result);
    });
  });
}

async function getLanguages() {
  const result = await transifexRequest('/api/2/project/violentmonkey-nex/?details');
  return result.teams;
}

async function loadRemote(lang) {
  // Reference: https://docs.transifex.com/api/translations#downloading-and-uploading-translations
  // Use translated messages since we don't have enough reviewers
  const result = await transifexRequest(`/api/2/project/violentmonkey-nex/resource/messagesjson/translation/${lang}/?mode=onlytranslated`);
  const remote = JSON.parse(result.content);
  return remote;
}

async function extract(lang) {
  const remote = await loadRemote(lang);
  const fullPath = `src/_locales/${lang}/messages.yml`;
  const local = yaml.safeLoad(await fs.readFile(fullPath, 'utf8'));
  const remoteUpdate = {};
  Object.entries(local)
  .forEach(([key, value]) => {
    const remoteMessage = remote[key] && remote[key].message;
    if (remoteMessage) value.message = remoteMessage;
    else if (value.touched !== false && value.message) remoteUpdate[key] = value;
  });
  await fs.writeFile(fullPath, yaml.safeDump(local), 'utf8');
  if (Object.keys(remoteUpdate).length) {
    const strings = await transifexRequest(`/api/2/project/violentmonkey-nex/resource/messagesjson/translation/${lang}/strings/`);
    const updates = strings.filter(({ key, reviewed }) => !reviewed && remoteUpdate[key])
      .map(({ key, string_hash }) => ({
        source_entity_hash: string_hash,
        translation: remoteUpdate[key].message,
      }));
    process.stdout.write(`\n  Uploading translations for ${lang}:\n  ${JSON.stringify(updates)}\n`);
    await transifexRequest(`/api/2/project/violentmonkey-nex/resource/messagesjson/translation/${lang}/strings/`, {
      method: 'PUT',
      responseType: 'text',
      data: updates,
    });
    process.stdout.write('  finished\n');
  }
}

async function main() {
  process.stdout.write('Loading languages...');
  const codes = await getLanguages();
  process.stdout.write('OK\n');
  process.stdout.write(`Got ${codes.length} language codes\n`);
  for (const code of codes) {
    await fs.mkdir(`src/_locales/${code}`, { recursive: true });
  }
  spawn.sync('yarn', ['i18n'], { stdio: 'inherit' });
  let finished = 0;
  const showProgress = () => {
    process.stdout.write(`\rLoading translations (${finished}/${codes.length})...`);
  };
  showProgress();
  for (const code of codes) {
    await delay(500);
    try {
      await extract(code);
    } catch (err) {
      process.stderr.write(`\nError pulling ${code}\n`)
      console.error(err);
    }
    finished += 1;
    showProgress();
  }
  process.stdout.write('OK\n');
}

main();
