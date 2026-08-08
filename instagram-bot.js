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
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SPAM_NOTES_FILE = path.join(DATA_DIR, 'spam_notepad.txt');
const REPLY_NOTES_FILE = path.join(DATA_DIR, 'reply_notepad.txt');
const BEEF_NOTES_FILE = path.join(DATA_DIR, 'beef_notepad.txt');
const GROUP_NOTES_FILE = path.join(DATA_DIR, 'group_notepad.txt');

const SCRIPT_NAME = 'Finesse Instagram';
const PREFIXES = ['$', '=', '!'];
const POLL_MS = 6000;

const ig = new IgApiClient();

const state = {
  connected: false,
  running: false,
  username: '',
  userId: '',
  startedAt: Date.now(),
  bootTime: Date.now(),
  seen: new Set(),

  afk: false,
  afkReason: '',
  reverse: false,
  antitrap: false,
  autoseen: true,

  replyTargets: new Set(),      // auto-răspuns cu linii din notepad
  customReply: {},              // userId -> text fix
  mockTargets: new Set(),       // rescrie aLtErNaTiNg
  copyTargets: new Set(),       // repetă mesajul
  reactTargets: {},             // userId -> emoji
  mentionTarget: null,

  replyDelay: 2000,
  lastReply: {},

  spam: { running: false, threadId: '', text: '', delay: 3000, left: 0 },
  repeat: { running: false, threadId: '', text: '', delay: 5000 },
  typing: new Map(),            // threadId -> interval

  snipe: {},                    // threadId -> ultimul mesaj sters/primit
  lastMsg: {},                  // threadId -> ultim mesaj
  threadNames: {},              // threadId -> nume prietenos
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(message, type = 'info') {
  const icons = { info: '•', ok: '✓', warn: '!', error: '×' };
  console.log(`[${new Date().toLocaleTimeString()}] ${icons[type] || '•'} ${message}`);
}

function uptime() {
  const s = Math.floor((Date.now() - state.bootTime) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

function loadLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function appendLine(file, line) {
  fs.appendFileSync(file, `${line}\n`, 'utf8');
}

function pick(list, fallback) {
  if (!list.length) return fallback;
  return list[Math.floor(Math.random() * list.length)];
}

function mockText(text) {
  return [...text].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');
}

/* ─────────────── SESIUNE / LOGIN ─────────────── */

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
  if (!info?.two_factor_identifier) throw new Error('Instagram nu a trimis datele pentru 2FA.');
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
    return 'Instagram cere confirmarea conectării. Aprobă în aplicație și rulează din nou login.';
  }
  if (body.error_type === 'bad_password') return 'Parola este greșită.';
  if (body.error_type === 'invalid_user') return 'Username-ul nu există.';
  if (body.message === 'challenge_required') return 'Instagram a blocat temporar loginul automat.';
  if (error.statusCode === 429) return 'Prea multe încercări. Așteaptă 15–30 de minute.';
  return body.message || error.message || 'Eroare necunoscută la conectare.';
}

async function login() {
  if (state.running) {
    log('Oprește botul înainte de un login nou.', 'warn');
    return false;
  }
  console.log('\nCONECTARE INSTAGRAM\n');
  const username = readlineSync.question('Username: ').trim().replace(/^@/, '');
  if (!username) return log('Username-ul nu poate fi gol.', 'error'), false;
  const password = readlineSync.question('Parola: ', { hideEchoBack: true, mask: '•' });
  if (!password) return log('Parola nu poate fi goală.', 'error'), false;

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

/* ─────────────── HELP ─────────────── */

const HELP_DOLLAR = `${SCRIPT_NAME} — comenzi $
$help / $list          lista comenzilor
$ping                  test rapid
$status                starea botului
$uptime                de cât timp rulează
$afk [motiv]           răspuns automat AFK
$afkcheck              afișează starea AFK
$reply [userID]        auto-răspuns din notepad reply
$stopreply [userID]    oprește auto-răspunsul
$customreply [id] [txt] răspuns fix pentru un user
$stopcustomreply [id]  oprește răspunsul fix
$listcustomreply       lista răspunsurilor fixe
$replydelay [sec]      delay între răspunsuri
$mock [userID]         rescrie mesajele aLtErNaTiNg
$stopmock [userID]     oprește mock
$copymsg [userID]      repetă tot ce scrie
$stopcopy [userID]     oprește copymsg
$reverse               răspunde cu textul inversat
$stopreverse           oprește reverse
$mention [userID]      marchează un target
$stopmention           oprește mention
$autoreact [id] [emoji] reacționează automat
$stopautoreact [id]    oprește reacția
$antitrap              blochează linkurile suspecte
$snipe                 ultimul mesaj șters/retras
$seen                  marchează conversațiile ca citite
$typing                typing fals în conversație
$stoptyping            oprește typing fals
$listtargets           toți targeții activi
$clearall              resetează tot`;

const HELP_EQUAL = `${SCRIPT_NAME} — comenzi =
=start [text] [nr] [sec]  trimite text de N ori în conversație
=stop                     oprește trimiterea
=repeat [text] [sec]      repetă text la interval
=stoprepeat               oprește repeat
=delay [sec]              delay pentru start
=groupname [nume]         schimbă numele grupului
=members                  membrii conversației
=tagall [text]            menționează toți membrii
=info                     info conversație
=avatar [user]            poza de profil
=profile [user]           info profil public
=weather [oras]           vremea`;

const HELP_EXCL = `${SCRIPT_NAME} — comenzi !
!notepadspam [linie]   adaugă linie în notepad spam
!notepadreply [linie]  adaugă linie în notepad reply
!notepadbeef [linie]   adaugă linie în notepad beef
!notepadgroup [linie]  adaugă linie în notepad grup
!listnotepad [tip]     afișează notepad (spam/reply/beef/group)
!clearnotepad [tip]    golește notepad
!unsend                retrage ultimul mesaj trimis
!id                    ID-ul conversației și al userului
!ping                  latență
!help                  lista comenzilor !`;

/* ─────────────── HELPERS INSTAGRAM ─────────────── */

async function send(thread, text) {
  if (!text) return;
  try {
    await thread.broadcastText(String(text).slice(0, 900));
  } catch (error) {
    log(`Trimitere eșuată: ${error.message}`, 'error');
  }
}

async function resolveUser(arg) {
  if (!arg) return null;
  const clean = String(arg).replace(/^@/, '');
  if (/^\d+$/.test(clean)) return { pk: clean, username: clean };
  try {
    const user = await ig.user.searchExact(clean);
    return { pk: String(user.pk), username: user.username };
  } catch {
    return null;
  }
}

async function getWeather(city) {
  const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3&m`);
  return res.text();
}

/* ─────────────── ROUTER COMENZI DM ─────────────── */

async function handleCommand(thread, threadInfo, prefix, cmd, args, senderId) {
  const argText = args.join(' ');
  const threadId = threadInfo.thread_id;

  // ── comenzi $ ──
  if (prefix === '$') {
    switch (cmd) {
      case 'help':
      case 'list':
        return send(thread, HELP_DOLLAR);
      case 'ping':
        return send(thread, 'Pong!');
      case 'status':
        return send(thread, `conectat: @${state.username} | rulează: ${state.running ? 'da' : 'nu'} | afk: ${state.afk ? 'da' : 'nu'} | reverse: ${state.reverse ? 'da' : 'nu'}`);
      case 'uptime':
        return send(thread, `uptime: ${uptime()} | @${state.username}`);
      case 'afk':
        state.afk = !state.afk;
        state.afkReason = state.afk ? argText : '';
        return send(thread, `afk ${state.afk ? `activat${state.afkReason ? ` (${state.afkReason})` : ''}` : 'dezactivat'}`);
      case 'afkcheck':
        return send(thread, state.afk ? `afk activ${state.afkReason ? `: ${state.afkReason}` : ''}` : 'afk inactiv');
      case 'reply': {
        const user = await resolveUser(args[0]);
        if (!user) return send(thread, '$reply [userID/username]');
        state.replyTargets.add(user.pk);
        return send(thread, `auto-reply activat: ${user.username}`);
      }
      case 'stopreply': {
        if (!args.length) { state.replyTargets.clear(); return send(thread, 'auto-reply oprit pentru toți'); }
        const user = await resolveUser(args[0]);
        if (user) state.replyTargets.delete(user.pk);
        return send(thread, 'auto-reply oprit');
      }
      case 'customreply': {
        const user = await resolveUser(args[0]);
        if (!user || args.length < 2) return send(thread, '$customreply [user] [text]');
        state.customReply[user.pk] = args.slice(1).join(' ');
        return send(thread, `customreply activat: ${user.username}`);
      }
      case 'stopcustomreply': {
        const user = await resolveUser(args[0]);
        if (user) delete state.customReply[user.pk];
        return send(thread, 'customreply oprit');
      }
      case 'listcustomreply': {
        const keys = Object.keys(state.customReply);
        return send(thread, keys.length ? keys.map((k) => `${k}: ${state.customReply[k]}`).join('\n') : 'niciun customreply');
      }
      case 'replydelay': {
        const sec = Number(args[0]);
        if (!sec) return send(thread, `delay curent: ${state.replyDelay / 1000}s`);
        state.replyDelay = Math.max(1, sec) * 1000;
        return send(thread, `delay setat: ${sec}s`);
      }
      case 'mock': {
        const user = await resolveUser(args[0]);
        if (!user) return send(thread, '$mock [user]');
        state.mockTargets.add(user.pk);
        return send(thread, `mock activat: ${user.username}`);
      }
      case 'stopmock': {
        if (!args.length) { state.mockTargets.clear(); return send(thread, 'mock oprit pentru toți'); }
        const user = await resolveUser(args[0]);
        if (user) state.mockTargets.delete(user.pk);
        return send(thread, 'mock oprit');
      }
      case 'copymsg': {
        const user = await resolveUser(args[0]);
        if (!user) return send(thread, '$copymsg [user]');
        state.copyTargets.add(user.pk);
        return send(thread, `copymsg activat: ${user.username}`);
      }
      case 'stopcopy': {
        if (!args.length) { state.copyTargets.clear(); return send(thread, 'copymsg oprit pentru toți'); }
        const user = await resolveUser(args[0]);
        if (user) state.copyTargets.delete(user.pk);
        return send(thread, 'copymsg oprit');
      }
      case 'reverse':
        state.reverse = !state.reverse;
        return send(thread, `reverse ${state.reverse ? 'activat' : 'dezactivat'}`);
      case 'stopreverse':
        state.reverse = false;
        return send(thread, 'reverse dezactivat');
      case 'mention': {
        if (!args.length) return send(thread, `mention: ${state.mentionTarget || 'niciunul'}`);
        const user = await resolveUser(args[0]);
        if (!user) return send(thread, 'user negăsit');
        state.mentionTarget = user.username;
        return send(thread, `mention activat: @${user.username}`);
      }
      case 'stopmention':
        state.mentionTarget = null;
        return send(thread, 'mention dezactivat');
      case 'autoreact': {
        const user = await resolveUser(args[0]);
        if (!user || !args[1]) return send(thread, '$autoreact [user] [emoji]');
        state.reactTargets[user.pk] = args[1];
        return send(thread, `autoreact ${args[1]} activat: ${user.username}`);
      }
      case 'stopautoreact': {
        const user = await resolveUser(args[0]);
        if (user) delete state.reactTargets[user.pk];
        return send(thread, 'autoreact oprit');
      }
      case 'antitrap':
        state.antitrap = !state.antitrap;
        return send(thread, `antitrap ${state.antitrap ? 'activat' : 'dezactivat'}`);
      case 'stopantitrap':
        state.antitrap = false;
        return send(thread, 'antitrap dezactivat');
      case 'snipe': {
        const s = state.snipe[threadId];
        if (!s) return send(thread, 'niciun mesaj în cache');
        const ago = Math.floor((Date.now() - s.at) / 1000);
        return send(thread, `${s.user} (${ago}s în urmă): ${s.text}`);
      }
      case 'seen':
        try { await thread.markItemSeen(threadInfo.items?.[0]?.item_id); } catch {}
        return send(thread, 'marcat ca văzut');
      case 'typing': {
        if (state.typing.has(threadId)) return send(thread, 'typing deja activ');
        const iv = setInterval(() => { thread.markActivity?.(true).catch?.(() => {}); }, 8000);
        state.typing.set(threadId, iv);
        return send(thread, 'typing fals activat');
      }
      case 'stoptyping': {
        const iv = state.typing.get(threadId);
        if (iv) clearInterval(iv);
        state.typing.delete(threadId);
        return send(thread, 'typing fals oprit');
      }
      case 'listtargets': {
        const lines = [];
        if (state.replyTargets.size) lines.push(`REPLY: ${[...state.replyTargets].join(', ')}`);
        if (Object.keys(state.customReply).length) lines.push(`CUSTOMREPLY: ${Object.keys(state.customReply).join(', ')}`);
        if (state.mockTargets.size) lines.push(`MOCK: ${[...state.mockTargets].join(', ')}`);
        if (state.copyTargets.size) lines.push(`COPY: ${[...state.copyTargets].join(', ')}`);
        if (Object.keys(state.reactTargets).length) lines.push(`AUTOREACT: ${Object.keys(state.reactTargets).join(', ')}`);
        if (state.spam.running) lines.push('SPAM: activ');
        if (state.repeat.running) lines.push('REPEAT: activ');
        return send(thread, lines.length ? `TARGEȚI ACTIVI:\n${lines.join('\n')}` : 'niciun target activ');
      }
      case 'clearall': {
        state.replyTargets.clear();
        state.mockTargets.clear();
        state.copyTargets.clear();
        state.customReply = {};
        state.reactTargets = {};
        state.mentionTarget = null;
        state.reverse = false;
        state.afk = false;
        state.spam.running = false;
        state.repeat.running = false;
        for (const iv of state.typing.values()) clearInterval(iv);
        state.typing.clear();
        return send(thread, 'totul a fost resetat');
      }
      default:
        return send(thread, `comandă necunoscută: $${cmd} — scrie $help`);
    }
  }

  // ── comenzi = ──
  if (prefix === '=') {
    switch (cmd) {
      case 'help':
      case 'list':
        return send(thread, HELP_EQUAL);
      case 'start': {
        if (!args.length) return send(thread, '=start [text] [nr] [sec]');
        const sec = Number(args[args.length - 1]);
        const nr = Number(args[args.length - 2]);
        const hasNums = Number.isFinite(sec) && Number.isFinite(nr);
        const text = hasNums ? args.slice(0, -2).join(' ') : argText;
        state.spam = {
          running: true,
          threadId,
          text: text || pick(loadLines(SPAM_NOTES_FILE), 'salut'),
          delay: Math.max(2, hasNums ? sec : 3) * 1000,
          left: Math.min(hasNums ? nr : 5, 50),
        };
        runSpam(thread);
        return send(thread, `pornit: ${state.spam.left} mesaje la ${state.spam.delay / 1000}s`);
      }
      case 'stop':
        state.spam.running = false;
        return send(thread, 'oprit');
      case 'repeat': {
        if (!args.length) return send(thread, '=repeat [text] [sec]');
        const sec = Number(args[args.length - 1]);
        const hasSec = Number.isFinite(sec);
        state.repeat = {
          running: true,
          threadId,
          text: hasSec ? args.slice(0, -1).join(' ') : argText,
          delay: Math.max(5, hasSec ? sec : 10) * 1000,
        };
        runRepeat(thread);
        return send(thread, `repeat pornit la ${state.repeat.delay / 1000}s`);
      }
      case 'stoprepeat':
        state.repeat.running = false;
        return send(thread, 'repeat oprit');
      case 'delay': {
        const sec = Number(args[0]);
        if (!sec) return send(thread, `delay: ${state.spam.delay / 1000}s`);
        state.spam.delay = Math.max(2, sec) * 1000;
        return send(thread, `delay setat: ${sec}s`);
      }
      case 'groupname': {
        if (!argText) return send(thread, '=groupname [nume]');
        try {
          await thread.updateTitle(argText);
          return send(thread, `nume schimbat: ${argText}`);
        } catch (e) {
          return send(thread, `nu am putut schimba numele: ${e.message}`);
        }
      }
      case 'members': {
        const users = threadInfo.users || [];
        return send(thread, users.length ? users.map((u) => `@${u.username} (${u.pk})`).join('\n') : 'fără membri');
      }
      case 'tagall': {
        const users = (threadInfo.users || []).map((u) => `@${u.username}`).join(' ');
        return send(thread, `${users} ${argText}`.trim());
      }
      case 'info':
        return send(thread, `thread: ${threadId}\nnume: ${threadInfo.thread_title || '-'}\nmembri: ${(threadInfo.users || []).length}`);
      case 'avatar': {
        const user = await resolveUser(args[0] || state.username);
        if (!user) return send(thread, 'user negăsit');
        try {
          const info = await ig.user.info(user.pk);
          return send(thread, info.profile_pic_url);
        } catch {
          return send(thread, 'nu am putut lua poza');
        }
      }
      case 'profile': {
        const user = await resolveUser(args[0] || state.username);
        if (!user) return send(thread, 'user negăsit');
        try {
          const info = await ig.user.info(user.pk);
          return send(thread, `@${info.username}\n${info.full_name || ''}\nfollowers: ${info.follower_count} | following: ${info.following_count}\nposts: ${info.media_count}\n${info.biography || ''}`);
        } catch {
          return send(thread, 'profil indisponibil');
        }
      }
      case 'weather': {
        if (!argText) return send(thread, '=weather [oras]');
        try {
          return send(thread, await getWeather(argText));
        } catch {
          return send(thread, 'nu am putut lua vremea');
        }
      }
      default:
        return send(thread, `comandă necunoscută: =${cmd} — scrie =help`);
    }
  }

  // ── comenzi ! ──
  if (prefix === '!') {
    const files = {
      spam: SPAM_NOTES_FILE,
      reply: REPLY_NOTES_FILE,
      beef: BEEF_NOTES_FILE,
      group: GROUP_NOTES_FILE,
    };
    switch (cmd) {
      case 'help':
      case 'list':
        return send(thread, HELP_EXCL);
      case 'ping':
        return send(thread, `pong — ${Date.now() % 1000}ms`);
      case 'id':
        return send(thread, `thread: ${threadId}\nuser: ${senderId}\ncont: ${state.userId}`);
      case 'notepadspam':
      case 'notepadreply':
      case 'notepadbeef':
      case 'notepadgroup': {
        if (!argText) return send(thread, `!${cmd} [linie]`);
        appendLine(files[cmd.replace('notepad', '')], argText);
        return send(thread, 'linie adăugată');
      }
      case 'listnotepad': {
        const file = files[args[0]];
        if (!file) return send(thread, '!listnotepad [spam/reply/beef/group]');
        const lines = loadLines(file);
        return send(thread, lines.length ? lines.slice(0, 30).join('\n') : 'notepad gol');
      }
      case 'clearnotepad': {
        const file = files[args[0]];
        if (!file) return send(thread, '!clearnotepad [spam/reply/beef/group]');
        fs.writeFileSync(file, '', 'utf8');
        return send(thread, 'notepad golit');
      }
      case 'unsend': {
        const last = state.lastMsg[threadId];
        if (!last) return send(thread, 'niciun mesaj de retras');
        try {
          await thread.deleteItem(last);
          delete state.lastMsg[threadId];
          return;
        } catch {
          return send(thread, 'nu am putut retrage mesajul');
        }
      }
      default:
        return send(thread, `comandă necunoscută: !${cmd} — scrie !help`);
    }
  }
  return undefined;
}

async function runSpam(thread) {
  while (state.spam.running && state.spam.left > 0) {
    const lines = loadLines(SPAM_NOTES_FILE);
    await send(thread, state.spam.text || pick(lines, 'salut'));
    state.spam.left -= 1;
    await sleep(state.spam.delay);
  }
  state.spam.running = false;
}

async function runRepeat(thread) {
  while (state.repeat.running) {
    await send(thread, state.repeat.text);
    await sleep(state.repeat.delay);
  }
}

/* ─────────────── PROCESARE MESAJE ─────────────── */

async function handleMessage(thread, threadInfo, item) {
  const senderId = String(item.user_id || '');
  const text = typeof item.text === 'string' ? item.text.trim() : '';
  if (!text) return;

  const threadId = threadInfo.thread_id;
  const senderName = (threadInfo.users || []).find((u) => String(u.pk) === senderId)?.username || senderId;
  state.snipe[threadId] = { user: senderName, text, at: Date.now() };

  const prefix = PREFIXES.find((p) => text.startsWith(p));
  if (prefix) {
    const parts = text.slice(prefix.length).trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    if (!cmd) return;
    log(`Comandă ${prefix}${cmd} de la ${senderName}`, 'ok');
    await handleCommand(thread, threadInfo, prefix, cmd, parts, senderId);
    return;
  }

  // mesajele proprii nu declanșează automatizări
  if (senderId === state.userId) return;

  if (state.antitrap && /(https?:\/\/|\.ru\/|bit\.ly)/i.test(text)) {
    await send(thread, 'link blocat de antitrap.');
    return;
  }

  const now = Date.now();
  if (state.lastReply[senderId] && now - state.lastReply[senderId] < state.replyDelay) return;

  let response = '';
  if (state.customReply[senderId]) response = state.customReply[senderId];
  else if (state.copyTargets.has(senderId)) response = text;
  else if (state.mockTargets.has(senderId)) response = mockText(text);
  else if (state.replyTargets.has(senderId)) response = pick(loadLines(REPLY_NOTES_FILE), 'ok');
  else if (state.afk) response = `Sunt AFK${state.afkReason ? `: ${state.afkReason}` : '.'}`;
  else if (state.reverse) response = [...text].reverse().join('');

  if (state.reactTargets[senderId]) {
    try { await thread.markItemSeen(item.item_id); } catch {}
  }

  if (response) {
    state.lastReply[senderId] = now;
    await send(thread, response);
  }
}

async function pollInbox() {
  const threads = await ig.feed.directInbox().items();
  for (const threadInfo of threads) {
    const thread = ig.entity.directThread(threadInfo.thread_id);
    const items = [...(threadInfo.items || [])].reverse();
    for (const item of items) {
      const id = String(item.item_id || '');
      if (!id || state.seen.has(id)) continue;
      state.seen.add(id);
      const ms = Number(item.timestamp || 0) / 1000;
      if (ms && ms < state.startedAt) continue;
      if (String(item.user_id) === state.userId) state.lastMsg[threadInfo.thread_id] = id;
      await handleMessage(thread, threadInfo, item);
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

/* ─────────────── CONSOLĂ ─────────────── */

function showHelp() {
  console.log(`
${SCRIPT_NAME}
────────────────────────────────
 login          conectare la cont
 start          pornește citirea DM
 stop           oprește botul
 status         afișează starea
 afk [motiv]    activează/dezactivează AFK
 comenzi        lista comenzilor din DM
 logout         șterge sesiunea locală
 help           afișează meniul
 exit           închide programul
────────────────────────────────
În DM: $help · =help · !help
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
      if (!state.connected && !(await login())) return true;
      state.startedAt = Date.now();
      state.running = true;
      log(`Bot pornit. Citesc DM la fiecare ${POLL_MS / 1000}s.`, 'ok');
      botLoop();
      break;
    case 'stop':
      state.running = false;
      log('Bot oprit.', 'ok');
      break;
    case 'status':
      console.log(`Conectat: ${state.connected ? `da (@${state.username})` : 'nu'} | Rulează: ${state.running ? 'da' : 'nu'} | AFK: ${state.afk ? 'da' : 'nu'} | Uptime: ${uptime()}`);
      break;
    case 'afk':
      state.afk = !state.afk;
      state.afkReason = state.afk ? args.join(' ') : '';
      log(`AFK ${state.afk ? 'activat' : 'dezactivat'}.`, 'ok');
      break;
    case 'comenzi':
      console.log(`\n${HELP_DOLLAR}\n\n${HELP_EQUAL}\n\n${HELP_EXCL}\n`);
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
