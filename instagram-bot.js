#!/usr/bin/env node
// ============================================================================
//  INSTAGRAM BOT  -  v2 (rescris)
//  Rulare:  npm install  &&  npm start
//  Comenzi consolă: login / start / stop / status / whoami / logout / help / exit
//  Comenzi în DM (doar de la contul tău): $help $status $ping $afk $reverse
//                                          $reply $stopreply $mock $stopmock
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');

// ===================== CONFIG =====================
const SESSION_FILE = path.join(__dirname, 'session.json');
const REPLY_FILE = path.join(__dirname, 'reply.txt');

const WEB = 'https://www.instagram.com';
const API = `${WEB}/api/v1`;
const IG_APP_ID = '936619743392459';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const POLL_INTERVAL_MS = 8000;   // cât de des verific inbox-ul
const SEND_COOLDOWN_MS = 2500;   // pauză minimă între 2 mesaje trimise
const REPLY_COOLDOWN_MS = 6000;  // pauză minimă per conversație la auto-reply

// ===================== STARE =====================
const state = {
  loggedIn: false,
  running: false,
  username: '',
  userId: null,          // string
  cookies: {},           // cookie jar simplu
  lastSendAt: 0,
  seenItems: new Set(),  // item_id-uri deja procesate
  startedAt: Math.floor(Date.now() / 1000),
  afk: { active: false, reason: '' },
  reverse: false,
  replyTargets: new Map(),  // userId -> username
  mockTargets: new Map(),   // userId -> username
  lastReplyAt: {},          // threadId -> ts
  replyPhrases: [],
  replyIndex: 0,
};

// ===================== UTILS =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg, type = 'info') {
  const icon =
    type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warn' ? '⚠️ ' : '📌';
  console.log(`${icon} ${new Date().toLocaleTimeString()} - ${msg}`);
}

function mockText(t) {
  return t
    .split('')
    .map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()))
    .join('');
}

function reverseText(t) {
  return t.split('').reverse().join('');
}

function loadReplyPhrases() {
  try {
    state.replyPhrases = fs
      .readFileSync(REPLY_FILE, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    state.replyPhrases = [];
  }
  return state.replyPhrases.length;
}

// ===================== COOKIE JAR =====================
function absorbCookies(res) {
  const raw = res?.headers?.['set-cookie'];
  if (!Array.isArray(raw)) return;
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!value || value === '""') delete state.cookies[name];
    else state.cookies[name] = value;
  }
}

function cookieHeader() {
  return Object.entries(state.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function baseHeaders(extra = {}) {
  const h = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate', // fără "br": axios/node nu îl decodează mereu
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': '129',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Instagram-AJAX': '1',
    Origin: WEB,
    Referer: `${WEB}/`,
    ...extra,
  };
  if (state.cookies.csrftoken) h['X-CSRFToken'] = state.cookies.csrftoken;
  const ck = cookieHeader();
  if (ck) h.Cookie = ck;
  return h;
}

async function request(method, url, { data, headers, form } = {}) {
  const opts = {
    method,
    url,
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true, // gestionăm noi codurile
    headers: baseHeaders(headers),
  };
  if (form) {
    opts.data = new URLSearchParams(form).toString();
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (data !== undefined) {
    opts.data = data;
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await axios(opts);
  absorbCookies(res);
  return res;
}

// ===================== SESIUNE =====================
function saveSession() {
  try {
    fs.writeFileSync(
      SESSION_FILE,
      JSON.stringify(
        { username: state.username, userId: state.userId, cookies: state.cookies },
        null,
        2
      )
    );
  } catch (e) {
    log(`Nu am putut salva sesiunea: ${e.message}`, 'warn');
  }
}

function readSessionFile() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function clearSession() {
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {}
  state.cookies = {};
  state.loggedIn = false;
  state.username = '';
  state.userId = null;
}

// ===================== PROMPT (un singur readline la un moment dat) =====================
let cli = null;      // readline-ul de consolă
let prompting = false;

function startCli() {
  if (cli) return;
  cli = readline.createInterface({ input: process.stdin, output: process.stdout });
  cli.setPrompt('> ');
  cli.on('line', (line) => {
    if (prompting) return; // în timpul login-ului nu interpretăm comenzi
    handleConsoleCommand(line.trim()).finally(() => {
      if (cli && !prompting) cli.prompt();
    });
  });
  cli.on('close', () => process.exit(0));
  cli.prompt();
}

function stopCli() {
  if (!cli) return;
  cli.close();
  cli = null;
}

// Întreabă text simplu — închide CLI-ul ca să nu se suprapună inputurile.
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Întreabă parola cu caractere ascunse.
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);

    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const done = (result) => {
      stdin.removeListener('data', onData);
      if (stdin.isTTY) stdin.setRawMode(!!wasRaw);
      stdin.pause();
      stdout.write('\n');
      resolve(result);
    };

    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') return done(value);
        if (ch === '\u0003') { stdout.write('\n'); process.exit(0); }      // Ctrl+C
        if (ch === '\u007F' || ch === '\b') {                              // Backspace
          if (value.length) { value = value.slice(0, -1); stdout.write('\b \b'); }
          continue;
        }
        value += ch;
        stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

// ===================== LOGIN =====================
async function warmup() {
  const res = await request('GET', `${WEB}/accounts/login/`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!state.cookies.csrftoken && typeof res.data === 'string') {
    const m = res.data.match(/"csrf_token"\s*:\s*"([^"]+)"/);
    if (m) state.cookies.csrftoken = m[1];
  }
  if (!state.cookies.csrftoken) throw new Error('Nu am putut obține csrftoken de la Instagram');
}

function encPassword(password) {
  const ts = Math.floor(Date.now() / 1000); // Instagram vrea SECUNDE, nu ms
  return `#PWD_INSTAGRAM_BROWSER:0:${ts}:${password}`;
}

function applyLoginSuccess(body) {
  state.userId = String(body.userId || state.cookies.ds_user_id || '');
  state.loggedIn = true;
  saveSession();
}

async function twoFactor(username, info) {
  const identifier = info?.two_factor_identifier;
  if (!identifier) throw new Error('Instagram cere 2FA dar nu a trimis identificatorul');

  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await ask(`🔐 Cod 2FA (din app / SMS) [încercarea ${attempt}/3]: `);
    const res = await request('POST', `${API}/web/accounts/login/ajax/two_factor/`, {
      form: {
        username,
        verificationCode: code.replace(/\s+/g, ''),
        identifier,
        verification_method: String(info.sms_two_factor_on ? 1 : 3),
        queryParams: '{}',
      },
      headers: { Referer: `${WEB}/accounts/login/two_factor/` },
    });
    const body = res.data || {};
    if (body.authenticated || state.cookies.sessionid) {
      applyLoginSuccess(body);
      return true;
    }
    log(body.message || 'Cod incorect.', 'error');
  }
  return false;
}

async function login() {
  if (state.running) {
    log('Oprește botul înainte (comanda: stop).', 'warn');
    return false;
  }
  prompting = true;
  stopCli();
  try {
    // 1) Încearcă sesiunea salvată
    const saved = readSessionFile();
    if (saved?.cookies?.sessionid) {
      state.cookies = saved.cookies;
      state.username = saved.username || '';
      state.userId = saved.userId || saved.cookies.ds_user_id || null;
      log('Sesiune salvată găsită, verific...');
      if (await verifySession()) {
        state.loggedIn = true;
        log(`Reconectat ca @${state.username}`, 'success');
        return true;
      }
      log('Sesiunea a expirat. Fac login din nou.', 'warn');
      state.cookies = {};
    }

    // 2) Login nou
    const username = await ask('📱 Username Instagram: ');
    if (!username) { log('Username gol.', 'error'); return false; }
    const password = await askHidden('🔑 Parola (ascunsă): ');
    if (!password) { log('Parolă goală.', 'error'); return false; }

    state.username = username;
    await warmup();

    const res = await request('POST', `${API}/web/accounts/login/ajax/`, {
      form: {
        username,
        enc_password: encPassword(password),
        queryParams: '{}',
        optIntoOneTap: 'false',
        trustedDeviceRecords: '{}',
      },
      headers: { Referer: `${WEB}/accounts/login/` },
    });

    const body = typeof res.data === 'object' && res.data ? res.data : {};

    if (res.status === 429 || body.message === 'rate limited' || body.spam) {
      log('Instagram te-a limitat temporar (prea multe încercări). Așteaptă 10-30 min.', 'error');
      return false;
    }
    if (body.two_factor_required) {
      log('Cont cu autentificare în 2 pași.', 'warn');
      const ok = await twoFactor(username, body.two_factor_info || {});
      if (ok) log(`Conectat ca @${state.username} (ID: ${state.userId})`, 'success');
      else log('2FA eșuat.', 'error');
      return ok;
    }
    if (body.checkpoint_url || body.message === 'checkpoint_required') {
      log('Instagram cere confirmare de securitate. Deschide aplicația/website-ul, aprobă login-ul, apoi rulează din nou "login".', 'error');
      return false;
    }
    if (body.user === false) {
      log('Nu există acest username.', 'error');
      return false;
    }
    if (body.authenticated === false) {
      log('Parolă greșită.', 'error');
      return false;
    }
    if (!body.authenticated || !state.cookies.sessionid) {
      log(`Login eșuat (HTTP ${res.status}): ${body.message || 'răspuns neașteptat de la Instagram'}`, 'error');
      return false;
    }

    applyLoginSuccess(body);
    log(`Conectat ca @${state.username} (ID: ${state.userId})`, 'success');
    return true;
  } catch (e) {
    log(`Login eșuat: ${e.message}`, 'error');
    return false;
  } finally {
    prompting = false;
    startCli();
  }
}

async function verifySession() {
  try {
    const res = await request('GET', `${API}/users/web_profile_info/?username=${encodeURIComponent(state.username)}`);
    if (res.status === 200 && res.data?.data?.user) {
      state.userId = String(res.data.data.user.id);
      return true;
    }
    const inbox = await request('GET', `${API}/direct_v2/inbox/?limit=1&thread_message_limit=1`);
    return inbox.status === 200 && inbox.data?.status === 'ok';
  } catch {
    return false;
  }
}

// ===================== API HELPERS =====================
async function getUserIdByUsername(uname) {
  const clean = uname.replace(/^@/, '');
  const res = await request('GET', `${API}/users/web_profile_info/?username=${encodeURIComponent(clean)}`);
  const id = res.data?.data?.user?.id;
  return id ? String(id) : null;
}

async function sendToThread(threadId, text) {
  const wait = SEND_COOLDOWN_MS - (Date.now() - state.lastSendAt);
  if (wait > 0) await sleep(wait);
  state.lastSendAt = Date.now();

  const res = await request('POST', `${API}/direct_v2/threads/broadcast/text/`, {
    form: {
      action: 'send_item',
      thread_ids: `[${threadId}]`,
      client_context: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
      text,
    },
    headers: { Referer: `${WEB}/direct/t/${threadId}/` },
  });

  if (res.status === 200 && res.data?.status === 'ok') return true;
  log(`Trimitere eșuată (HTTP ${res.status}): ${res.data?.message || ''}`, 'error');
  if (res.status === 401 || res.status === 403) {
    state.loggedIn = false;
    state.running = false;
    log('Sesiune invalidă. Rulează "login" din nou.', 'error');
  }
  return false;
}

// ===================== MONITORIZARE DM =====================
async function pollInbox() {
  const res = await request(
    'GET',
    `${API}/direct_v2/inbox/?persistentBadging=true&folder=0&limit=20&thread_message_limit=10`
  );

  if (res.status === 401 || res.status === 403) {
    state.loggedIn = false;
    state.running = false;
    log('Sesiunea a expirat. Rulează "login".', 'error');
    return;
  }
  if (res.status !== 200 || !res.data?.inbox) {
    log(`Nu am putut citi inbox-ul (HTTP ${res.status})`, 'warn');
    return;
  }

  const threads = res.data.inbox.threads || [];
  for (const thread of threads) {
    const threadId = thread.thread_id;
    // items vin de la cel mai nou la cel mai vechi
    const items = [...(thread.items || [])].reverse();

    for (const item of items) {
      const id = String(item.item_id || `${threadId}:${item.timestamp}`);
      if (state.seenItems.has(id)) continue;
      state.seenItems.add(id);

      // ignoră tot ce a fost trimis înainte de pornirea botului
      const tsSec = Number(item.timestamp || 0) / 1e6;
      if (tsSec && tsSec < state.startedAt) continue;

      const senderId = String(item.user_id || '');
      if (!senderId || senderId === String(state.userId)) continue; // nu răspunde la tine
      if (item.item_type !== 'text') continue;

      const text = String(item.text || '');
      const senderName =
        (thread.users || []).find((u) => String(u.pk) === senderId)?.username || 'unknown';

      try {
        if (text.startsWith('$')) {
          await handleDmCommand({ threadId, senderId, senderName, text });
        } else {
          await handleAutoResponses({ threadId, senderId, senderName, text });
        }
      } catch (e) {
        log(`Eroare la procesarea mesajului: ${e.message}`, 'error');
      }
    }
  }

  // nu lăsăm setul să crească la infinit
  if (state.seenItems.size > 5000) {
    state.seenItems = new Set([...state.seenItems].slice(-2000));
  }
}

async function handleAutoResponses({ threadId, senderId, senderName, text }) {
  const last = state.lastReplyAt[threadId] || 0;
  if (Date.now() - last < REPLY_COOLDOWN_MS) return;

  let out = null;

  if (state.mockTargets.has(senderId)) {
    out = mockText(text);
  } else if (state.replyTargets.has(senderId) && state.replyPhrases.length) {
    out = state.replyPhrases[state.replyIndex % state.replyPhrases.length];
    state.replyIndex++;
  } else if (state.afk.active) {
    out = `💤 Sunt AFK${state.afk.reason ? ` (${state.afk.reason})` : ''}. Revin mai târziu.`;
  }

  if (!out) return;
  if (state.reverse) out = reverseText(out);

  state.lastReplyAt[threadId] = Date.now();
  await sendToThread(threadId, out);
  log(`Răspuns automat către @${senderName}`);
}

// ===================== COMENZI DIN DM =====================
const HELP_DM = `🤖 Comenzi bot (prefix $)

• $help — acest mesaj
• $status — starea botului
• $ping — test răspuns
• $afk [motiv] — pornește/oprește AFK
• $reverse — inversează textul răspunsurilor
• $reply @user — auto-reply cu fraze din reply.txt
• $stopreply [@user] — oprește auto-reply
• $mock @user — răspunde cu tExT aLtErNaT
• $stopmock [@user] — oprește mock`;

async function handleDmCommand({ threadId, senderId, senderName, text }) {
  // Comenzile funcționează DOAR de la contul proprietarului
  if (String(senderId) !== String(state.userId)) {
    log(`Comandă ignorată de la @${senderName} (nu ești tu)`, 'warn');
    return;
  }

  const parts = text.slice(1).trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);
  const reply = (m) => sendToThread(threadId, m);

  log(`Comandă $${cmd} de la @${senderName}`);

  switch (cmd) {
    case 'help':
    case 'list':
      return reply(HELP_DM);

    case 'ping':
      return reply('🏓 Pong!');

    case 'status':
      return reply(
        `📊 Status\n` +
          `• Cont: @${state.username}\n` +
          `• Rulează: ${state.running ? 'da' : 'nu'}\n` +
          `• AFK: ${state.afk.active ? `da${state.afk.reason ? ` (${state.afk.reason})` : ''}` : 'nu'}\n` +
          `• Reverse: ${state.reverse ? 'da' : 'nu'}\n` +
          `• Reply: ${state.replyTargets.size} ținte, ${state.replyPhrases.length} fraze\n` +
          `• Mock: ${state.mockTargets.size} ținte`
      );

    case 'afk': {
      state.afk.active = !state.afk.active;
      state.afk.reason = state.afk.active ? args.join(' ') : '';
      return reply(
        `AFK ${state.afk.active ? '🟢 activat' : '🔴 dezactivat'}` +
          (state.afk.reason ? ` (${state.afk.reason})` : '')
      );
    }

    case 'reverse':
      state.reverse = !state.reverse;
      return reply(`Reverse ${state.reverse ? '🟢 activat' : '🔴 dezactivat'}`);

    case 'reply': {
      if (!args.length) return reply('Folosește: $reply @username');
      const uname = args[0].replace(/^@/, '');
      const id = await getUserIdByUsername(uname);
      if (!id) return reply(`❌ Nu am găsit @${uname}`);
      if (loadReplyPhrases() === 0)
        return reply('❌ Fișierul reply.txt e gol sau lipsește (o frază pe linie).');
      state.replyTargets.set(id, uname);
      return reply(`✅ Auto-reply pornit pentru @${uname} (${state.replyPhrases.length} fraze)`);
    }

    case 'stopreply': {
      if (!args.length) {
        state.replyTargets.clear();
        return reply('✅ Auto-reply oprit pentru toți');
      }
      const uname = args[0].replace(/^@/, '');
      const id = await getUserIdByUsername(uname);
      if (id && state.replyTargets.delete(id)) return reply(`✅ Auto-reply oprit pentru @${uname}`);
      return reply(`⚠️ @${uname} nu era în listă`);
    }

    case 'mock': {
      if (!args.length) return reply('Folosește: $mock @username');
      const uname = args[0].replace(/^@/, '');
      const id = await getUserIdByUsername(uname);
      if (!id) return reply(`❌ Nu am găsit @${uname}`);
      state.mockTargets.set(id, uname);
      return reply(`✅ Mock pornit pentru @${uname}`);
    }

    case 'stopmock': {
      if (!args.length) {
        state.mockTargets.clear();
        return reply('✅ Mock oprit pentru toți');
      }
      const uname = args[0].replace(/^@/, '');
      const id = await getUserIdByUsername(uname);
      if (id && state.mockTargets.delete(id)) return reply(`✅ Mock oprit pentru @${uname}`);
      return reply(`⚠️ @${uname} nu era în listă`);
    }

    default:
      return reply(`❌ Comandă necunoscută: $${cmd}\nScrie $help pentru listă.`);
  }
}

// ===================== BUCLA BOTULUI =====================
async function botLoop() {
  while (state.running) {
    try {
      await pollInbox();
    } catch (e) {
      log(`Eroare în buclă: ${e.message}`, 'error');
    }
    for (let i = 0; i < POLL_INTERVAL_MS / 500 && state.running; i++) await sleep(500);
  }
  log('Bucla s-a oprit.');
}

// ===================== COMENZI CONSOLĂ =====================
const HELP_CONSOLE = `
╔════════════════════════════════════════════════╗
║  INSTAGRAM BOT — comenzi consolă               ║
╠════════════════════════════════════════════════╣
║  login    conectare (sau reconectare)          ║
║  start    pornește monitorizarea DM            ║
║  stop     oprește monitorizarea                ║
║  status   starea curentă                       ║
║  whoami   contul conectat                      ║
║  logout   șterge sesiunea salvată              ║
║  help     acest mesaj                          ║
║  exit     închide programul                    ║
╚════════════════════════════════════════════════╝
Comenzi în DM (doar de la contul tău): $help`;

async function handleConsoleCommand(input) {
  if (!input) return;
  const cmd = input.toLowerCase();

  switch (cmd) {
    case 'login':
      await login();
      return;

    case 'start': {
      if (state.running) return log('Botul deja rulează.', 'warn');
      if (!state.loggedIn) {
        const ok = await login();
        if (!ok) return;
      }
      loadReplyPhrases();
      state.startedAt = Math.floor(Date.now() / 1000);
      state.running = true;
      log('🚀 Bot pornit. Monitorizez DM-urile. ("stop" ca să oprești)', 'success');
      botLoop();
      return;
    }

    case 'stop':
      if (!state.running) return log('Botul nu rulează.', 'warn');
      state.running = false;
      log('🛑 Opresc botul...');
      return;

    case 'status':
      console.log(
        `\n  Conectat : ${state.loggedIn ? `da (@${state.username})` : 'nu'}\n` +
          `  Rulează  : ${state.running ? 'da' : 'nu'}\n` +
          `  AFK      : ${state.afk.active ? `da${state.afk.reason ? ` (${state.afk.reason})` : ''}` : 'nu'}\n` +
          `  Reverse  : ${state.reverse ? 'da' : 'nu'}\n` +
          `  Reply    : ${state.replyTargets.size} ținte (${state.replyPhrases.length} fraze)\n` +
          `  Mock     : ${state.mockTargets.size} ținte\n`
      );
      return;

    case 'whoami':
      return console.log(
        state.loggedIn ? `  @${state.username} (ID: ${state.userId})\n` : '  Neconectat\n'
      );

    case 'logout':
      state.running = false;
      clearSession();
      log('Sesiune ștearsă.', 'success');
      return;

    case 'help':
    case '?':
      return console.log(HELP_CONSOLE);

    case 'exit':
    case 'quit':
      state.running = false;
      log('Pa!');
      process.exit(0);
      return;

    default:
      console.log(`❌ Comandă necunoscută: "${input}". Scrie "help".`);
  }
}

// ===================== PORNIRE =====================
console.log(HELP_CONSOLE);
if (readSessionFile()) console.log('💾 Există o sesiune salvată — scrie "start" sau "login".\n');
else console.log('💡 Scrie "login" pentru a te conecta, apoi "start".\n');

loadReplyPhrases();
startCli();

process.on('SIGINT', () => {
  state.running = false;
  console.log('\n🛑 Închid...');
  setTimeout(() => process.exit(0), 300);
});
process.on('uncaughtException', (err) => log(`Eroare necapturată: ${err.message}`, 'error'));
process.on('unhandledRejection', (err) =>
  log(`Promisiune respinsă: ${err?.message || err}`, 'error')
);
