#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readlineSync = require('readline-sync');
const {
  IgApiClient,
  IgLoginTwoFactorRequiredError,
  IgCheckpointError,
} = require('instagram-private-api');

const SESSION_FILE = path.join(__dirname, 'session.json');
const POLL_MS = 8000;

const ig = new IgApiClient();
const state = {
  connected: false,
  running: false,
  username: '',
  userId: '',
  startedAt: Date.now(),
  seen: new Set(),
  afk: false,
  afkReason: '',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message, type = 'info') {
  const icons = { info: '•', ok: '✓', warn: '!', error: '×' };
  console.log(`[${new Date().toLocaleTimeString()}] ${icons[type]} ${message}`);
}

function saveSession() {
  const session = ig.state.serialize();
  delete session.constants;
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ username: state.username, session }, null, 2),
    { mode: 0o600 }
  );
}

function deleteSession() {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  state.connected = false;
  state.running = false;
  state.username = '';
  state.userId = '';
}

async function restoreSession() {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!saved.username || !saved.session) return false;

    state.username = saved.username;
    ig.state.generateDevice(state.username);
    await ig.state.deserialize(saved.session);
    const account = await ig.account.currentUser();
    state.userId = String(account.pk);
    state.connected = true;
    log(`Sesiune restaurată: @${account.username}`, 'ok');
    return true;
  } catch {
    log('Sesiunea salvată a expirat; este necesar un login nou.', 'warn');
    deleteSession();
    return false;
  }
}

async function completeTwoFactor(username, error) {
  const info = error.response?.body?.two_factor_info;
  if (!info?.two_factor_identifier) {
    throw new Error('Instagram nu a trimis datele necesare pentru 2FA.');
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const code = readlineSync.question(`Cod 2FA (${attempt}/3): `).replace(/\s/g, '');
    try {
      return await ig.account.twoFactorLogin({
        username,
        verificationCode: code,
        twoFactorIdentifier: info.two_factor_identifier,
        verificationMethod: info.totp_two_factor_on ? '0' : '1',
        trustThisDevice: '1',
      });
    } catch (twoFactorError) {
      if (attempt === 3) throw twoFactorError;
      log('Cod incorect. Încearcă din nou.', 'error');
    }
  }
  return null;
}

function explainLoginError(error) {
  const body = error.response?.body || {};
  if (error instanceof IgCheckpointError || body.checkpoint_url) {
    return 'Instagram cere confirmarea conectării. Deschide aplicația Instagram, aprobă încercarea și rulează din nou login.';
  }
  if (body.error_type === 'bad_password' || body.message === 'The password you entered is incorrect.') {
    return 'Parola este greșită.';
  }
  if (body.error_type === 'invalid_user') return 'Username-ul nu există.';
  if (body.message === 'challenge_required') {
    return 'Instagram a blocat temporar loginul automat. Confirmă identitatea în aplicația oficială și încearcă mai târziu.';
  }
  if (error.statusCode === 429) return 'Prea multe încercări. Așteaptă 15–30 de minute.';
  return body.message || error.message || 'Eroare necunoscută la conectare.';
}

async function login() {
  if (state.running) {
    log('Oprește botul înainte de un login nou.', 'warn');
    return false;
  }

  console.log('\nCONECTARE INSTAGRAM');
  console.log('Datele sunt citite doar aici; consola este oprită până se termină loginul.\n');
  const username = readlineSync.question('Username: ').trim().replace(/^@/, '');
  if (!username) {
    log('Username-ul nu poate fi gol.', 'error');
    return false;
  }
  const password = readlineSync.question('Parola: ', { hideEchoBack: true, mask: '•' });
  if (!password) {
    log('Parola nu poate fi goală.', 'error');
    return false;
  }

  try {
    deleteSession();
    state.username = username;
    ig.state.generateDevice(username);
    await ig.simulate.preLoginFlow();

    let account;
    try {
      account = await ig.account.login(username, password);
    } catch (error) {
      if (!(error instanceof IgLoginTwoFactorRequiredError)) throw error;
      log('Autentificarea în doi pași este activă.', 'warn');
      account = await completeTwoFactor(username, error);
    }

    if (!account) throw new Error('Instagram nu a returnat contul conectat.');
    state.userId = String(account.pk);
    state.connected = true;
    saveSession();
    ig.simulate.postLoginFlow().catch(() => {});
    log(`Conectat ca @${account.username}.`, 'ok');
    return true;
  } catch (error) {
    state.connected = false;
    log(explainLoginError(error), 'error');
    return false;
  }
}

function textFromItem(item) {
  if (typeof item.text === 'string') return item.text;
  return '';
}

async function handleMessage(thread, item) {
  const senderId = String(item.user_id || '');
  if (!senderId || senderId === state.userId) return;
  const text = textFromItem(item).trim();
  if (!text) return;

  let response = '';
  if (text.toLowerCase() === '$ping') response = 'Pong!';
  if (text.toLowerCase() === '$status') response = state.running ? 'Botul rulează.' : 'Botul este oprit.';
  if (text.toLowerCase() === '$help') response = '$ping · $status · $help';
  if (state.afk && !text.startsWith('$')) {
    response = `Sunt AFK${state.afkReason ? `: ${state.afkReason}` : '.'}`;
  }

  if (response) {
    await thread.broadcastText(response);
    log('Răspuns trimis într-o conversație.', 'ok');
  }
}

async function pollInbox() {
  const inbox = ig.feed.directInbox();
  const threads = await inbox.items();

  for (const threadInfo of threads) {
    const thread = ig.entity.directThread(threadInfo.thread_id);
    const items = [...(threadInfo.items || [])].reverse();
    for (const item of items) {
      const id = String(item.item_id || '');
      if (!id || state.seen.has(id)) continue;
      state.seen.add(id);
      const timestampMs = Number(item.timestamp || 0) / 1000;
      if (timestampMs && timestampMs < state.startedAt) continue;
      await handleMessage(thread, item);
    }
  }

  if (state.seen.size > 3000) state.seen = new Set([...state.seen].slice(-1000));
}

async function botLoop() {
  while (state.running) {
    try {
      await pollInbox();
    } catch (error) {
      log(`Citirea mesajelor a eșuat: ${error.message}`, 'error');
      if (error.statusCode === 401) {
        state.running = false;
        state.connected = false;
        log('Sesiunea a expirat. Rulează login.', 'warn');
      }
    }
    if (state.running) await sleep(POLL_MS);
  }
}

function showHelp() {
  console.log(`
INSTAGRAM BOT
────────────────────────────────
 login          conectare la cont
 start          pornește citirea DM
 stop           oprește botul
 status         afișează starea
 afk [motiv]    activează/dezactivează AFK
 logout         șterge sesiunea locală
 help           afișează comenzile
 exit           închide programul
────────────────────────────────
Comenzi DM: $help, $ping, $status
`);
}

async function command(input) {
  const [name = '', ...args] = input.trim().split(/\s+/);
  switch (name.toLowerCase()) {
    case 'login':
      await login();
      break;
    case 'start':
      if (state.running) return log('Botul rulează deja.', 'warn');
      if (!state.connected && !(await login())) return;
      state.startedAt = Date.now();
      state.running = true;
      log('Bot pornit. Citesc mesajele la fiecare 8 secunde.', 'ok');
      botLoop();
      break;
    case 'stop':
      state.running = false;
      log('Bot oprit.', 'ok');
      break;
    case 'status':
      console.log(`Conectat: ${state.connected ? `da (@${state.username})` : 'nu'} | Rulează: ${state.running ? 'da' : 'nu'} | AFK: ${state.afk ? 'da' : 'nu'}`);
      break;
    case 'afk':
      state.afk = !state.afk;
      state.afkReason = state.afk ? args.join(' ') : '';
      log(`AFK ${state.afk ? 'activat' : 'dezactivat'}.`, 'ok');
      break;
    case 'logout':
      deleteSession();
      log('Sesiune ștearsă.', 'ok');
      break;
    case 'help':
    case '?':
      showHelp();
      break;
    case 'exit':
    case 'quit':
      state.running = false;
      return false;
    case '':
      break;
    default:
      log(`Comandă necunoscută: ${name}. Scrie help.`, 'error');
  }
  return true;
}

async function main() {
  console.clear();
  showHelp();
  await restoreSession();

  let active = true;
  while (active) {
    const input = readlineSync.question('instagram-bot > ');
    active = (await command(input)) !== false;
  }
  console.log('La revedere.');
}

process.on('SIGINT', () => {
  state.running = false;
  console.log('\nProgram închis.');
  process.exit(0);
});

main().catch((error) => {
  log(error.message, 'error');
  process.exitCode = 1;
});