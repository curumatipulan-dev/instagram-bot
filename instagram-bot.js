/*
 * INSTAGRAM BOT - versiune curata pentru Termux
 *
 * Instalare in Termux:
 *   pkg update && pkg upgrade -y
 *   pkg install nodejs-lts git -y
 *   git clone https://github.com/curumatipulan-dev/instagram-bot
 *   cd instagram-bot
 *   npm install
 *   node instagram-bot.js
 *
 * Comenzile din DM se scriu cu prefix $ (ex: $help).
 * Raspunsul botului vine in exact acelasi chat in care ai scris comanda.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { IgApiClient, IgLoginTwoFactorRequiredError, IgCheckpointError } = require('instagram-private-api');

// ===================== CONFIG =====================

// ---- .env, fara dependinte externe (util pe VPS / hosting) ----
function loadEnvFile() {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
    }
}
loadEnvFile();

const ARGS = process.argv.slice(2);
const hasFlag = (name) => ARGS.includes(name);
const envBool = (v) => /^(1|true|yes|da|on)$/i.test(String(v || ''));

// Unde se scriu sesiunea, notitele si imaginile. Pe VPS poti monta un volum.
const DATA_DIR = process.env.IG_DATA_DIR ? path.resolve(process.env.IG_DATA_DIR) : __dirname;
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Headless = fara terminal interactiv (pm2, systemd, docker, nohup).
// In acest mod datele de login vin din variabile de mediu / .env.
const HEADLESS = hasFlag('--headless')
    ? true
    : process.env.IG_HEADLESS !== undefined
        ? envBool(process.env.IG_HEADLESS)
        : !process.stdin.isTTY;
const AUTO_START = hasFlag('--auto')
    ? true
    : process.env.IG_AUTO_START !== undefined
        ? envBool(process.env.IG_AUTO_START)
        : HEADLESS;

const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const NOTEPAD_FILE = path.join(DATA_DIR, 'notepad.json');
const PREFIX = '$';
const POLL_INTERVAL_MS = 20000;  // cat de des verifica inboxul (Instagram da 467 daca ceri prea des)
const POLL_JITTER_MS = 8000;     // variatie aleatoare, ca sa nu para trafic de bot
const MAX_BACKOFF_MS = 15 * 60 * 1000; // pauza maxima dupa erori repetate
const MIN_SEND_GAP_MS = 2500;    // pauza minima intre 2 mesaje trimise
const LIKE_EMOJI = '\u2764\ufe0f'; // reactia "inima" ceruta de API

const ig = new IgApiClient();

let USERNAME = '';
let myUserId = null;
let running = false;
let loggedIn = false;
let pollTimer = null;
let lastSendTime = 0;
let pollBackoff = 0;      // pauza curenta impusa de erori (ms)
let pollErrors = 0;       // erori consecutive la citirea inboxului
let cli = null;           // interfata de comenzi din consola
let inputBusy = false;
let loginInProgress = false;  // true cat timp se face login (comenzile din terminal asteapta)    // true cat timp cerem username/parola/cod (consola nu mai citeste comenzi)
const startTime = Date.now();

// ===================== STARI =====================

const replyState = { running: false, targets: [], lastReplyTime: {}, lineIndex: 0 };
const spamState = { running: false, target: null, targetName: '', text: '', timer: null, phraseIndex: 0 };
const mockTargets = {};
const mockLastTime = {};
const copyTargets = {};
const copyLastTime = {};
const autolikeTargets = {};
const afkState = { active: false, reason: '', notified: {} };

let reverseMode = false;
let mentionTargetId = null;
let mentionTargetName = '';
let manualTargetId = null;
let manualTargetName = '';

let replyDelay = 7;
let spamDelay = 4;

let spamPhrases = [];
let replyWords = [];
let beefPhrases = [];

const savedImages = [];
const seenItems = new Set();      // id-uri de mesaje deja procesate
const threadCursor = {};          // thread_id -> timestamp ultimului mesaj procesat
let notepad = { notes: {} };      // user_id -> lista note personale

// ===================== UTILS =====================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg, type) {
    const tag = type === 'error' ? '[EROARE]' : type === 'ok' ? '[OK]' : type === 'warn' ? '[ATENTIE]' : '[INFO]';
    console.log(`${tag} ${new Date().toLocaleTimeString()} - ${msg}`);
}

function uptime() {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}z ${h}h ${m}m ${s % 60}s`;
}

function mockText(text) {
    return text.split('').map((c, i) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase())).join('');
}

function reverseText(text) {
    return text.split('').reverse().join('');
}

// ===================== NOTEPAD =====================

function loadNotepad() {
    if (!fs.existsSync(NOTEPAD_FILE)) return { notes: {} };
    try {
        const data = JSON.parse(fs.readFileSync(NOTEPAD_FILE, 'utf8'));
        if (data && typeof data.notes === 'object') return data;
        return { notes: {} };
    } catch {
        return { notes: {} };
    }
}

function saveNotepad() {
    try {
        fs.writeFileSync(NOTEPAD_FILE, JSON.stringify(notepad, null, 2));
    } catch (e) {
        log(`Nu am putut salva notepad: ${e.message}`, 'warn');
    }
}

function notepadHelp() {
    return [
        'NOTEPAD - comenzi',
        '$note add [text] - adauga o notita',
        '$note list - arata toate notitele tale',
        '$note delete [numar] - sterge notita cu numarul respectiv',
        '$note clear - sterge toate notitele',
        '$note help - ajutor notepad',
    ].join('\n');
}

function notepadList(userId) {
    const list = notepad.notes[userId] || [];
    if (!list.length) return 'Notepadul tau este gol.';
    return ['Notitele tale:', ...list.map((n, i) => `${i + 1}. ${n.text}`)].join('\n');
}

function notepadAdd(userId, text) {
    if (!text.trim()) return 'Textul notei este gol.';
    if (!notepad.notes[userId]) notepad.notes[userId] = [];
    notepad.notes[userId].push({ text: text.trim(), createdAt: Date.now() });
    saveNotepad();
    return `Notita adaugata. Ai ${notepad.notes[userId].length} notite.`;
}

function notepadDelete(userId, index) {
    const list = notepad.notes[userId] || [];
    if (index < 1 || index > list.length) return `Numar invalid. Ai ${list.length} notite.`;
    const removed = list.splice(index - 1, 1);
    if (!list.length) delete notepad.notes[userId];
    saveNotepad();
    return `Notita stearsa: ${removed[0].text}`;
}

function notepadClear(userId) {
    delete notepad.notes[userId];
    saveNotepad();
    return 'Toate notitele tale au fost sterse.';
}

notepad = loadNotepad();

// ===================== FRAZE =====================

function phraseFile(file) {
    const inData = path.join(DATA_DIR, file);
    return fs.existsSync(inData) ? inData : path.join(__dirname, file);
}

function loadPhrases(file) {
    try {
        return fs.readFileSync(phraseFile(file), 'utf8')
            .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

function ask(question, hidden) {
    if (HEADLESS) {
        log(`Nu pot cere interactiv "${question.trim()}" in mod headless. Completeaza .env (IG_USERNAME, IG_PASSWORD, IG_TOTP_SECRET).`, 'error');
        return Promise.resolve('');
    }
    // Cat timp intrebam ceva, oprim ascultatorul de comenzi din consola.
    // Altfel el citeste acelasi rand si raspunde "Comanda necunoscuta",
    // iar username-ul/parola ajung in consola in loc sa ajunga la login.
    inputBusy = true;
    const done = (value, resolve) => { inputBusy = false; if (cli) cli.resume(); resolve(value); };
    if (cli) cli.pause();

    return new Promise((resolve) => {
        if (!hidden) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(question, (answer) => { rl.close(); done(answer.trim(), resolve); });
            return;
        }
        process.stdout.write(question);
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let value = '';
        const onData = (chunk) => {
            if (chunk === '\n' || chunk === '\r' || chunk === '\r\n' || chunk === '\u0004') {
                stdin.setRawMode(Boolean(wasRaw));
                stdin.pause();
                stdin.removeListener('data', onData);
                process.stdout.write('\n');
                done(value.trim(), resolve);
                return;
            }
            if (chunk === '\u0003') { process.exit(0); }
            if (chunk === '\u007F' || chunk === '\b') {
                if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
                return;
            }
            value += chunk;
            process.stdout.write('*');
        };
        stdin.on('data', onData);
    });
}

// ===================== 2FA AUTOMAT (TOTP) =====================

// Genereaza codul din aplicatia de autentificare, plecand de la secretul base32.
// Asa botul se poate reloga singur pe VPS, fara sa ceara cod la tastatura.
function base32Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = alphabet.indexOf(ch);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out.push((value >>> bits) & 0xff);
        }
    }
    return Buffer.from(out);
}

function totpCode(secret, atMs) {
    const key = base32Decode(secret);
    if (!key.length) return '';
    const counter = Math.floor((atMs || Date.now()) / 1000 / 30);
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
}

// ===================== SESIUNE =====================

async function saveSession() {
    try {
        const state = await ig.state.serialize();
        delete state.constants;
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ username: USERNAME, state }, null, 2));
    } catch (e) {
        log(`Nu am putut salva sesiunea: ${e.message}`, 'warn');
    }
}

async function tryRestoreSession() {
    if (!fs.existsSync(SESSION_FILE)) return false;
    try {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        if (!data.state || !data.username) return false;
        USERNAME = data.username;
        ig.state.generateDevice(USERNAME);
        await ig.state.deserialize(data.state);
        const me = await ig.account.currentUser();
        myUserId = String(me.pk);
        log(`Sesiune valida. Conectat ca ${me.username} (id ${myUserId})`, 'ok');
        return true;
    } catch (e) {
        log(`Sesiunea salvata nu mai e valida (${e.message}). Fac login din nou.`, 'warn');
        try { fs.unlinkSync(SESSION_FILE); } catch {}
        return false;
    }
}

// ===================== LOGIN =====================

// Instagram nu trimite mereu IgCheckpointError: uneori raspunsul e un 400/467
// obisnuit cu message="checkpoint_required" in body. Le tratam la fel.
function isCheckpoint(err) {
    if (err instanceof IgCheckpointError) return true;
    const body = err && err.response && err.response.body;
    if (body && (body.message === 'checkpoint_required' || body.checkpoint_url)) return true;
    return /checkpoint_required|challenge_required/i.test(String(err && err.message));
}

async function login() {
    if (await tryRestoreSession()) {
        loggedIn = true;
        ig.request.end$.subscribe(() => { saveSession(); });
        return true;
    }

    const username = (process.env.IG_USERNAME || '').trim() || await ask('Username Instagram: ');
    const password = process.env.IG_PASSWORD || await ask('Parola Instagram (ascunsa): ', true);
    if (!username || !password) {
        log('Username sau parola lipsa.', 'error');
        return false;
    }

    USERNAME = username;
    ig.state.generateDevice(USERNAME);
    ig.request.end$.subscribe(() => { saveSession(); });

    try {
        await ig.simulate.preLoginFlow();
    } catch {
        // pre-login flow poate esua pe unele retele, nu e fatal
    }

    let user;
    try {
        user = await ig.account.login(USERNAME, password);
    } catch (err) {
        if (err instanceof IgLoginTwoFactorRequiredError) {
            const info = err.response.body.two_factor_info;
            let code = '';
            if (process.env.IG_TOTP_SECRET) {
                code = totpCode(process.env.IG_TOTP_SECRET);
                log('Cod 2FA generat automat din IG_TOTP_SECRET.');
            } else {
                code = await ask('Cod 2FA (din SMS sau aplicatie): ');
            }
            try {
                // Numele corect in instagram-private-api este twoFactorLogin,
                // iar raspunsul e body-ul brut, nu obiectul user.
                const res = await ig.account.twoFactorLogin({
                    username: USERNAME,
                    verificationCode: code,
                    twoFactorIdentifier: info.two_factor_identifier,
                    verificationMethod: (process.env.IG_TOTP_SECRET || info.totp_two_factor_on) ? '0' : '1',
                    trustThisDevice: '1',
                });
                user = res.logged_in_user || await ig.account.currentUser();
            } catch (e2) {
                log(`Cod 2FA respins: ${e2.message}`, 'error');
                return false;
            }
        } else if (isCheckpoint(err)) {
            log('Instagram cere verificare de securitate (checkpoint).', 'warn');
            try {
                await ig.challenge.auto(true);
                const choice = ig.state.checkpoint && ig.state.checkpoint.step_name;
                log(`Pas verificare: ${choice || 'necunoscut'}`);
                const code = await ask('Cod primit pe email sau SMS: ');
                await ig.challenge.sendSecurityCode(code);
                user = await ig.account.currentUser();
            } catch (e3) {
                log(`Verificarea a esuat: ${e3.message}`, 'error');
                log('Deschide aplicatia Instagram pe telefon, aproba cererea de logare / confirma ca esti tu, asteapta 10-15 minute, apoi scrie "start" din nou.', 'warn');
                return false;
            }
        } else {
            const body = err.response && err.response.body ? JSON.stringify(err.response.body) : err.message;
            log(`Login esuat: ${body}`, 'error');
            return false;
        }
    }

    myUserId = String(user.pk);
    await saveSession();
    log(`Conectat ca ${user.username} (id ${myUserId})`, 'ok');
    loggedIn = true;
    return true;
}

// ===================== TRIMITERE =====================

async function sendToThread(threadId, text) {
    if (!text) return false;
    try {
        const gap = Date.now() - lastSendTime;
        if (gap < MIN_SEND_GAP_MS) await sleep(MIN_SEND_GAP_MS - gap);
        await ig.entity.directThread(String(threadId)).broadcastText(String(text));
        lastSendTime = Date.now();
        return true;
    } catch (e) {
        log(`Nu am putut trimite in thread ${threadId}: ${e.message}`, 'error');
        return false;
    }
}

async function sendToUser(userId, text) {
    if (!text) return false;
    try {
        const gap = Date.now() - lastSendTime;
        if (gap < MIN_SEND_GAP_MS) await sleep(MIN_SEND_GAP_MS - gap);
        await ig.entity.directThread([String(userId)]).broadcastText(String(text));
        lastSendTime = Date.now();
        return true;
    } catch (e) {
        log(`Nu am putut trimite catre ${userId}: ${e.message}`, 'error');
        return false;
    }
}

// instagram-private-api nu expune o metoda de reactie, deci apelam direct
// endpointul folosit de aplicatie.
async function likeItem(threadId, itemId) {
    if (!threadId || !itemId) return false;
    try {
        await ig.request.send({
            url: '/api/v1/direct_v2/threads/broadcast/reaction/',
            method: 'POST',
            form: ig.request.sign({
                thread_ids: JSON.stringify([String(threadId)]),
                item_id: String(itemId),
                node_type: 'item',
                reaction_type: 'like',
                reaction_status: 'created',
                emoji: LIKE_EMOJI,
                action: 'send_item',
                client_context: ig.state.clientSessionId,
                mutation_token: String(Date.now()),
                _csrftoken: ig.state.cookieCsrfToken,
                _uuid: ig.state.uuid,
            }),
        });
        return true;
    } catch (e) {
        log(`Nu am putut da like la mesaj: ${e.message}`, 'warn');
        return false;
    }
}

async function resolveUser(name) {
    const clean = String(name || '').replace('@', '').trim();
    if (!clean) return null;
    try {
        const id = await ig.user.getIdByUsername(clean);
        return { id: String(id), username: clean };
    } catch {
        return null;
    }
}

// ===================== SALVARE IMAGINI =====================

async function saveImageFromUrl(url, sender, isViewOnce) {
    try {
        const dir = path.join(DATA_DIR, isViewOnce ? 'view_once' : 'saved_images');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const filename = `${isViewOnce ? 'view_once' : 'image'}_${Date.now()}_${sender}.jpg`;
        const filepath = path.join(dir, filename);
        fs.writeFileSync(filepath, buffer);
        savedImages.push({ filename, filepath, sender, viewOnce: Boolean(isViewOnce), timestamp: Date.now() });
        log(`Imagine salvata: ${filename}`, 'ok');
        return filepath;
    } catch (e) {
        log(`Nu am putut salva imaginea: ${e.message}`, 'error');
        return null;
    }
}

function extractImageUrl(item) {
    const media = item.visual_media && item.visual_media.media ? item.visual_media.media : item.media;
    if (!media) return null;
    const candidates = media.image_versions2 && media.image_versions2.candidates;
    return candidates && candidates.length ? candidates[0].url : null;
}

function isViewOnce(item) {
    if (item.visual_media && item.visual_media.view_mode) return item.visual_media.view_mode !== 'permanent';
    if (item.media && item.media.view_mode) return item.media.view_mode === 'once';
    return false;
}

// ===================== TEXT COMENZI =====================

function helpText() {
    return [
        'BOT INSTAGRAM - LISTA COMENZI',
        '',
        'BAZA',
        '$help - afiseaza acest mesaj',
        '$ping - test conexiune',
        '$status - starea botului',
        '$uptime - de cat timp ruleaza',
        '',
        'REPLY AUTOMAT',
        '$reply [user] - adauga user la reply automat',
        '$stopreply [user] - opreste reply (fara user opreste tot)',
        '$replydelay [sec] - seteaza delay reply (1-30)',
        '$replylist - lista targetelor de reply',
        '',
        'SPAM',
        '$spam [user] [text] - porneste spam catre user',
        '$stopspam - opreste spamul',
        '$spamdelay [sec] - seteaza delay spam (1-30)',
        '',
        'MOCK SI COPY',
        '$mock [user] - raspunde cu text alternat',
        '$stopmock [user] - opreste mock',
        '$copymsg [user] - copiaza mesajele userului',
        '$stopcopy [user] - opreste copy',
        '',
        'IMAGINI',
        '$vvlist - lista imaginilor salvate',
        '$vvclear - sterge imaginile view once salvate',
        '',
        'NOTEPAD (notite personale)',
        '$note add [text] - adauga o notita',
        '$note list - arata notitele tale',
        '$note delete [numar] - sterge o notita',
        '$note clear - sterge toate notitele',
        '',
        'ALTELE',
        '$afk [motiv] - activeaza modul afk',
        '$stopafk - opreste modul afk',
        '$reverse - raspunde cu textul inversat',
        '$stopreverse - opreste reverse',
        '$autolike [user] - da like automat la mesajele userului',
        '$stopautolike [user] - opreste autolike',
        '$mention [user] - mentioneaza userul in raspunsuri',
        '$stopmention - opreste mentionarea',
        '$target [user] - seteaza tinta manuala',
        '$untarget - sterge tinta manuala',
        '$listtargets - toate targetele active',
        '$clearall - opreste toate functiile',
        '',
        'FRAZE (fisiere .txt in folderul botului)',
        '$addnotepad - reincarca spam.txt',
        '$addreply - reincarca reply.txt',
        '$addbeef - reincarca beef.txt',
        '$listphrases - cate fraze sunt incarcate',
    ].join('\n');
}

function statusText() {
    const totalNotes = Object.values(notepad.notes).reduce((sum, list) => sum + list.length, 0);
    return [
        'STATUS BOT',
        `Utilizator: @${USERNAME}`,
        `Ruleaza: ${running ? 'da' : 'nu'}`,
        `Uptime: ${uptime()}`,
        `Imagini salvate: ${savedImages.length}`,
        `Notite salvate: ${totalNotes}`,
        `Targete reply: ${replyState.targets.length}`,
        `Spam: ${spamState.running ? 'activ' : 'inactiv'}`,
        `Mock: ${Object.keys(mockTargets).length} targete`,
        `Copy: ${Object.keys(copyTargets).length} targete`,
        `Autolike: ${Object.keys(autolikeTargets).length} targete`,
        `Reverse: ${reverseMode ? 'activ' : 'inactiv'}`,
        `AFK: ${afkState.active ? `activ (${afkState.reason})` : 'inactiv'}`,
    ].join('\n');
}

// ===================== HANDLER COMENZI =====================

// replyFn permite rularea aceleiasi comenzi din terminal:
// raspunsul se scrie in consola in loc sa plece intr-un DM.
async function handleCommand(threadId, senderId, senderName, rawText, replyFn) {
    const body = rawText.startsWith(PREFIX) ? rawText.slice(PREFIX.length) : rawText;
    const parts = body.trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const args = parts;
    const reply = replyFn || ((msg) => sendToThread(threadId, msg));

    switch (cmd) {
        case 'help':
        case 'h':
        case 'comenzi':
        case 'list':
            await reply(helpText());
            return;

        case 'ping': {
            const t0 = Date.now();
            await reply('Pong');
            await reply(`Latenta: ${Date.now() - t0} ms`);
            return;
        }

        case 'status':
            await reply(statusText());
            return;

        case 'uptime':
            await reply(`Uptime: ${uptime()}`);
            return;

        case 'reply': {
            if (!args.length) return reply('Foloseste: $reply [username]');
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            if (replyState.targets.includes(t.id)) return reply(`@${t.username} este deja in lista`);
            if (replyState.targets.length >= 20) return reply('Limita de 20 de targete a fost atinsa');
            replyState.targets.push(t.id);
            replyState.running = true;
            if (!replyWords.length) replyWords = loadPhrases('reply.txt');
            return reply(`Reply activat pentru @${t.username} (${replyState.targets.length}/20)`);
        }

        case 'stopreply': {
            if (!args.length) {
                replyState.running = false;
                replyState.targets = [];
                replyState.lastReplyTime = {};
                return reply('Reply oprit pentru toti');
            }
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            const idx = replyState.targets.indexOf(t.id);
            if (idx === -1) return reply(`@${t.username} nu este in lista`);
            replyState.targets.splice(idx, 1);
            if (!replyState.targets.length) replyState.running = false;
            return reply(`Reply oprit pentru @${t.username} (${replyState.targets.length} ramase)`);
        }

        case 'replydelay': {
            if (!args.length) return reply(`Delay reply curent: ${replyDelay}s`);
            const sec = parseInt(args[0], 10);
            if (!Number.isFinite(sec) || sec < 1 || sec > 30) return reply('Valoare permisa: 1-30 secunde');
            replyDelay = sec;
            return reply(`Delay reply setat la ${sec}s`);
        }

        case 'replylist':
            if (!replyState.targets.length) return reply('Niciun target de reply activ');
            return reply(`Targete reply (${replyState.targets.length}):\n${replyState.targets.join('\n')}`);

        case 'spam': {
            if (args.length < 2) return reply('Foloseste: $spam [username] [text]');
            if (spamState.running) return reply('Spamul ruleaza deja. Opreste-l cu $stopspam');
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            const text = args.slice(1).join(' ');
            spamState.running = true;
            spamState.target = t.id;
            spamState.targetName = t.username;
            spamState.text = text;
            spamState.phraseIndex = 0;
            if (spamState.timer) clearInterval(spamState.timer);
            spamState.timer = setInterval(async () => {
                if (!spamState.running) { clearInterval(spamState.timer); spamState.timer = null; return; }
                const phrase = spamPhrases.length
                    ? spamPhrases[spamState.phraseIndex % spamPhrases.length]
                    : spamState.text;
                spamState.phraseIndex += 1;
                await sendToUser(spamState.target, phrase);
            }, Math.max(spamDelay, 2) * 1000);
            return reply(`Spam pornit catre @${t.username} (delay ${spamDelay}s)`);
        }

        case 'stopspam':
            if (!spamState.running) return reply('Spamul nu este pornit');
            spamState.running = false;
            if (spamState.timer) { clearInterval(spamState.timer); spamState.timer = null; }
            spamState.target = null;
            return reply('Spam oprit');

        case 'spamdelay': {
            if (!args.length) return reply(`Delay spam curent: ${spamDelay}s`);
            const sec = parseInt(args[0], 10);
            if (!Number.isFinite(sec) || sec < 1 || sec > 30) return reply('Valoare permisa: 1-30 secunde');
            spamDelay = sec;
            return reply(`Delay spam setat la ${sec}s`);
        }

        case 'mock': {
            if (!args.length) return reply('Foloseste: $mock [username]');
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            mockTargets[t.id] = t.username;
            return reply(`Mock activat pentru @${t.username}`);
        }

        case 'stopmock': {
            if (!args.length) {
                Object.keys(mockTargets).forEach((k) => delete mockTargets[k]);
                return reply('Mock oprit pentru toti');
            }
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            if (!mockTargets[t.id]) return reply(`@${t.username} nu are mock activ`);
            delete mockTargets[t.id];
            return reply(`Mock oprit pentru @${t.username}`);
        }

        case 'copymsg': {
            if (!args.length) return reply('Foloseste: $copymsg [username]');
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            copyTargets[t.id] = t.username;
            return reply(`Copy activat pentru @${t.username}`);
        }

        case 'stopcopy': {
            if (!args.length) {
                Object.keys(copyTargets).forEach((k) => delete copyTargets[k]);
                return reply('Copy oprit pentru toti');
            }
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            if (!copyTargets[t.id]) return reply(`@${t.username} nu are copy activ`);
            delete copyTargets[t.id];
            return reply(`Copy oprit pentru @${t.username}`);
        }

        case 'autolike': {
            if (!args.length) return reply('Foloseste: $autolike [username]');
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            autolikeTargets[t.id] = t.username;
            return reply(`Autolike activat pentru @${t.username}`);
        }

        case 'stopautolike': {
            if (!args.length) {
                Object.keys(autolikeTargets).forEach((k) => delete autolikeTargets[k]);
                return reply('Autolike oprit pentru toti');
            }
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            if (!autolikeTargets[t.id]) return reply(`@${t.username} nu are autolike activ`);
            delete autolikeTargets[t.id];
            return reply(`Autolike oprit pentru @${t.username}`);
        }

        case 'mention': {
            if (!args.length) return reply('Foloseste: $mention [username]');
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            mentionTargetId = t.id;
            mentionTargetName = t.username;
            return reply(`Mentionare activata pentru @${t.username}`);
        }

        case 'stopmention':
            mentionTargetId = null;
            mentionTargetName = '';
            return reply('Mentionare oprita');

        case 'target': {
            if (!args.length) return reply('Foloseste: $target [username]');
            const t = await resolveUser(args[0]);
            if (!t) return reply(`Userul @${args[0]} nu a fost gasit`);
            manualTargetId = t.id;
            manualTargetName = t.username;
            return reply(`Tinta setata: @${t.username}`);
        }

        case 'untarget':
            if (!manualTargetId) return reply('Nu exista o tinta setata');
            manualTargetId = null;
            manualTargetName = '';
            return reply('Tinta a fost stearsa');

        case 'afk':
            afkState.active = true;
            afkState.reason = args.join(' ') || 'fara motiv';
            afkState.notified = {};
            return reply(`Mod AFK activat: ${afkState.reason}`);

        case 'stopafk':
            afkState.active = false;
            afkState.reason = '';
            afkState.notified = {};
            return reply('Mod AFK oprit');

        case 'reverse':
            reverseMode = true;
            return reply('Mod reverse activat');

        case 'stopreverse':
            reverseMode = false;
            return reply('Mod reverse oprit');

        case 'vvlist': {
            if (!savedImages.length) return reply('Nicio imagine salvata');
            const lines = savedImages.slice(-15).map((img, i) => `${i + 1}. ${img.filename} de la @${img.sender}`);
            return reply(`Imagini salvate (${savedImages.length}):\n${lines.join('\n')}`);
        }

        case 'vvclear': {
            const dir = path.join(DATA_DIR, 'view_once');
            let count = 0;
            try {
                if (fs.existsSync(dir)) {
                    for (const f of fs.readdirSync(dir)) { fs.unlinkSync(path.join(dir, f)); count += 1; }
                }
            } catch (e) {
                return reply(`Nu am putut sterge: ${e.message}`);
            }
            savedImages.length = 0;
            return reply(`Sterse ${count} imagini view once`);
        }

        case 'addnotepad':
        case 'addspam':
            spamPhrases = loadPhrases('spam.txt');
            return reply(`Incarcate ${spamPhrases.length} fraze din spam.txt`);

        case 'addreply':
            replyWords = loadPhrases('reply.txt');
            return reply(`Incarcate ${replyWords.length} fraze din reply.txt`);

        case 'addbeef':
            beefPhrases = loadPhrases('beef.txt');
            return reply(`Incarcate ${beefPhrases.length} fraze din beef.txt`);

        case 'listphrases':
            return reply([
                `spam.txt: ${spamPhrases.length} fraze`,
                `reply.txt: ${replyWords.length} fraze`,
                `beef.txt: ${beefPhrases.length} fraze`,
            ].join('\n'));

        case 'listtargets':
            return reply([
                'TARGETE ACTIVE',
                `Reply: ${replyState.targets.length ? replyState.targets.join(', ') : 'niciunul'}`,
                `Mock: ${Object.values(mockTargets).join(', ') || 'niciunul'}`,
                `Copy: ${Object.values(copyTargets).join(', ') || 'niciunul'}`,
                `Autolike: ${Object.values(autolikeTargets).join(', ') || 'niciunul'}`,
                `Spam: ${spamState.running ? spamState.targetName : 'niciunul'}`,
                `Mention: ${mentionTargetName || 'niciunul'}`,
                `Tinta manuala: ${manualTargetName || 'niciuna'}`,
            ].join('\n'));

        case 'note':
        case 'notes':
        case 'notepad': {
            const sub = (args.shift() || '').toLowerCase();
            const rest = args.join(' ');
            switch (sub) {
                case 'add':
                case 'adauga':
                    return reply(notepadAdd(senderId, rest));
                case 'list':
                case 'lista':
                case '':
                    return reply(notepadList(senderId));
                case 'delete':
                case 'sterge':
                case 'del': {
                    const idx = parseInt(args[0], 10);
                    if (!Number.isFinite(idx)) return reply('Foloseste: $note delete [numar]');
                    return reply(notepadDelete(senderId, idx));
                }
                case 'clear':
                case 'curata':
                    return reply(notepadClear(senderId));
                case 'help':
                case '?':
                default:
                    return reply(notepadHelp());
            }
        }

        case 'clearall':
            replyState.running = false;
            replyState.targets = [];
            replyState.lastReplyTime = {};
            spamState.running = false;
            if (spamState.timer) { clearInterval(spamState.timer); spamState.timer = null; }
            Object.keys(mockTargets).forEach((k) => delete mockTargets[k]);
            Object.keys(copyTargets).forEach((k) => delete copyTargets[k]);
            Object.keys(autolikeTargets).forEach((k) => delete autolikeTargets[k]);
            reverseMode = false;
            mentionTargetId = null;
            mentionTargetName = '';
            manualTargetId = null;
            manualTargetName = '';
            afkState.active = false;
            return reply('Toate functiile au fost oprite');

        default:
            return reply(`Comanda "${PREFIX}${cmd}" nu exista. Scrie ${PREFIX}help pentru lista completa.`);
    }
}

// ===================== AUTOMATIZARI =====================

async function handleAutoFeatures(threadId, senderId, senderName, text) {
    if (!text) return;

    if (mockTargets[senderId] && Date.now() - (mockLastTime[senderId] || 0) >= replyDelay * 1000) {
        mockLastTime[senderId] = Date.now();
        await sendToThread(threadId, mockText(text));
        return;
    }

    if (copyTargets[senderId] && Date.now() - (copyLastTime[senderId] || 0) >= replyDelay * 1000) {
        copyLastTime[senderId] = Date.now();
        await sendToThread(threadId, text);
        return;
    }

    if (reverseMode) {
        await sendToThread(threadId, reverseText(text));
        return;
    }

    if (replyState.running && replyState.targets.includes(senderId) && replyWords.length) {
        if (Date.now() - (replyState.lastReplyTime[senderId] || 0) >= replyDelay * 1000) {
            replyState.lastReplyTime[senderId] = Date.now();
            const line = replyWords[replyState.lineIndex % replyWords.length];
            replyState.lineIndex += 1;
            let out = line;
            if (mentionTargetId && mentionTargetName) out = `@${mentionTargetName} ${out}`;
            await sendToThread(threadId, out);
            return;
        }
    }

    if (afkState.active && !afkState.notified[threadId]) {
        afkState.notified[threadId] = true;
        await sendToThread(threadId, `Sunt AFK momentan. Motiv: ${afkState.reason}`);
    }
}

// ===================== POLLING INBOX =====================

// Extrage codul HTTP dintr-o eroare a bibliotecii instagram-private-api.
function errorStatus(e) {
    const direct = e && e.response && e.response.statusCode;
    if (direct) return Number(direct);
    const m = String((e && e.message) || '').match(/\b(4\d\d|5\d\d)\b/);
    return m ? Number(m[1]) : 0;
}

// Intervalul pana la urmatoarea verificare: interval de baza + variatie
// aleatoare, plus pauza impusa daca Instagram ne-a limitat.
function nextPollDelay() {
    if (pollBackoff > 0) return pollBackoff + Math.floor(Math.random() * POLL_JITTER_MS);
    return POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS);
}

async function pollInbox() {
    if (!running) return;
    try {
        // Creeaza un feed nou la fiecare verificare. Refolosirea feedului poate
        // pastra cursorul vechi si poate face ca mesajele noi sa nu mai apara.
        const inboxFeed = ig.feed.directInbox();
        const inbox = await inboxFeed.items();
        for (const thread of inbox) {
            const threadId = String(thread.thread_id || thread.thread_v2_id || '');
            if (!threadId) continue;
            const items = (thread.items || []).slice().reverse(); // de la cel mai vechi la cel mai nou
            if (!threadCursor[threadId]) {
                // La prima verificare procesam comenzile recente. In versiunea
                // veche toate mesajele existente erau ignorate, inclusiv $help
                // trimis imediat dupa pornirea botului.
                const newest = items.length ? Number(items[items.length - 1].timestamp) : Date.now() * 1000;
                threadCursor[threadId] = newest;
                const recentLimit = Date.now() * 1000 - 5 * 60 * 1000 * 1000;
                for (const item of items) {
                    const itemId = String(item.item_id || item.client_context || '');
                    if (itemId) seenItems.add(itemId);
                    const text = typeof item.text === 'string' ? item.text.trim() : '';
                    if (!text.startsWith(PREFIX) || Number(item.timestamp || 0) < recentLimit) continue;
                    const senderId = String(item.user_id || myUserId || '');
                    const user = (thread.users || []).find((u) => String(u.pk) === senderId);
                    const senderName = user ? user.username : (senderId === myUserId ? USERNAME : 'necunoscut');
                    log(`Comanda recenta de la @${senderName}: ${text}`);
                    await handleCommand(threadId, senderId, senderName, text);
                }
                continue;
            }

            for (const item of items) {
                const itemId = String(item.item_id || item.client_context || '');
                if (itemId && seenItems.has(itemId)) continue;
                if (itemId) seenItems.add(itemId);
                threadCursor[threadId] = Math.max(threadCursor[threadId], Number(item.timestamp || 0));

                const senderId = String(item.user_id);
                const user = (thread.users || []).find((u) => String(u.pk) === senderId);
                const senderName = user ? user.username : (senderId === myUserId ? USERNAME : 'necunoscut');
                const isSelf = senderId === myUserId;

                // imagini
                if (item.item_type === 'media' || item.item_type === 'raven_media') {
                    const url = extractImageUrl(item);
                    if (url) await saveImageFromUrl(url, senderName, isViewOnce(item));
                    continue;
                }

                // Unele raspunsuri Instagram nu mai trimit item_type="text",
                // dar campul text este prezent si valid.
                if (typeof item.text !== 'string') continue;
                const text = String(item.text || '');

                // comenzi: accepta si mesajele trimise de contul tau, in orice chat
                if (text.trim().startsWith(PREFIX)) {
                    log(`Comanda de la @${senderName}: ${text.trim()}`);
                    await handleCommand(threadId, senderId, senderName, text.trim());
                    continue;
                }

                if (isSelf) continue;

                if (autolikeTargets[senderId]) await likeItem(threadId, item.item_id);

                await handleAutoFeatures(threadId, senderId, senderName, text);
            }
        }
        // citire reusita: resetam orice pauza impusa de erori
        pollErrors = 0;
        pollBackoff = 0;
    } catch (e) {
        pollErrors += 1;
        const code = errorStatus(e);

        if (code === 467 || code === 429) {
            // Instagram a limitat contul/IP-ul. Nu insistam: crestem pauza.
            pollBackoff = Math.min(pollBackoff ? pollBackoff * 2 : 60000, MAX_BACKOFF_MS);
            log(`Instagram a limitat cererile (cod ${code}). Pauza ${Math.round(pollBackoff / 1000)}s inainte de urmatoarea verificare.`, 'warn');
        } else if (e instanceof IgCheckpointError || /checkpoint|challenge/i.test(String(e.message))) {
            // Cont blocat pana confirmi in aplicatia oficiala.
            log('Instagram cere verificare de securitate. Deschide aplicatia oficiala, confirma ca esti tu, apoi scrie "start" din nou.', 'error');
            stop();
            return;
        } else if (/login_required|not logged|sessionid/i.test(String(e.message))) {
            log('Sesiunea a expirat. Scrie "logout" apoi "start" ca sa te conectezi din nou.', 'error');
            stop();
            return;
        } else {
            pollBackoff = Math.min(pollBackoff ? pollBackoff * 2 : 15000, MAX_BACKOFF_MS);
            log(`Eroare la citirea inboxului: ${e.message}. Reincerc peste ${Math.round(pollBackoff / 1000)}s.`, 'error');
        }

        if (pollErrors >= 20) {
            log('Prea multe erori consecutive. Opresc botul ca sa nu agravez restrictia.', 'error');
            stop();
            return;
        }
    }

    if (seenItems.size > 5000) seenItems.clear();
    if (running) pollTimer = setTimeout(pollInbox, nextPollDelay());
}

// ===================== CONTROL =====================

async function start() {
    if (running) { log('Botul ruleaza deja.', 'warn'); return; }
    if (!loggedIn) {
        loginInProgress = true;
        let ok = false;
        try { ok = await login(); } finally { loginInProgress = false; }
        if (!ok) { log('Nu m-am putut conecta. Verifica datele si incearca din nou cu "start".', 'error'); return; }
    }
    spamPhrases = loadPhrases('spam.txt');
    replyWords = loadPhrases('reply.txt');
    beefPhrases = loadPhrases('beef.txt');
    running = true;
    pollErrors = 0;
    pollBackoff = 0;
    log(`Bot pornit. Scrie ${PREFIX}help intr-un DM ca sa primesti lista de comenzi in acel chat.`, 'ok');
    pollInbox();
}

function stop() {
    if (!running) { log('Botul nu ruleaza.', 'warn'); return; }
    running = false;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (spamState.timer) { clearInterval(spamState.timer); spamState.timer = null; spamState.running = false; }
    log('Bot oprit.', 'ok');
}

function consoleHelp() {
    console.log([
        '',
        'COMENZI CONSOLA (control)',
        '  start    - porneste botul (cere login prima data)',
        '  stop     - opreste botul',
        '  status   - afiseaza starea botului',
        '  logout   - sterge sesiunea salvata',
        '  help     - acest mesaj',
        '  commands - lista completa a comenzilor de bot',
        '  exit     - inchide programul',
        '',
        'COMENZI DE BOT DIN TERMINAL',
        `  Orice comanda ${PREFIX} merge si aici, cu sau fara prefix.`,
        `  Exemple: ${PREFIX}spam user text | mock user | note list | clearall`,
        '  Raspunsul apare in terminal, actiunea se executa pe Instagram.',
        '',
        `In DM foloseste prefixul ${PREFIX}. Scrie ${PREFIX}help intr-un chat si botul raspunde acolo.`,
        '',
    ].join('\n'));
}

// Comenzi de bot rulate din terminal: acelasi handler ca in DM,
// doar ca raspunsul se scrie in consola.
const NEEDS_LOGIN = new Set([
    'reply', 'stopreply', 'spam', 'mock', 'stopmock', 'copymsg', 'stopcopy',
    'autolike', 'stopautolike', 'mention', 'target',
]);

// Comenzile din terminal se executa una dupa alta, in ordinea scrierii.
let consoleQueue = Promise.resolve();

function queueBotCommand(raw) {
    consoleQueue = consoleQueue.then(() => runBotCommand(raw)).catch((e) => {
        log(`Comanda a esuat: ${e && e.message ? e.message : e}`, 'error');
    });
}

async function runBotCommand(raw) {
    const clean = raw.trim();
    if (!clean) return;
    const name = clean.replace(new RegExp(`^\\${PREFIX}`), '').trim().split(/\s+/)[0].toLowerCase();
    if (NEEDS_LOGIN.has(name) && !loggedIn) {
        // daca tocmai se face login (pornire automata), asteptam sa se termine
        if (loginInProgress) {
            log('Astept sa se termine loginul...');
            for (let i = 0; i < 120 && loginInProgress; i += 1) await sleep(1000);
        }
        if (!loggedIn) {
            console.log('Trebuie sa fii conectat. Scrie "start" mai intai.');
            return;
        }
    }
    try {
        await handleCommand('', String(myUserId || 'console'), USERNAME || 'consola', clean, (msg) => {
            console.log(`\n${msg}\n`);
            return true;
        });
    } catch (e) {
        log(`Comanda a esuat: ${e.message}`, 'error');
    }
}

const consoleCommands = {
    start,
    stop,
    status: () => console.log(`\n${statusText()}\n`),
    help: consoleHelp,
    logout: () => {
        try { fs.unlinkSync(SESSION_FILE); log('Sesiune stearsa.', 'ok'); } catch { log('Nu exista sesiune salvata.', 'warn'); }
        loggedIn = false;
    },
    commands: () => console.log(`\n${helpText()}\n`),
    comenzi: () => console.log(`\n${helpText()}\n`),
    exit: () => { stop(); process.exit(0); },
    quit: () => { stop(); process.exit(0); },
};

cli = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
cli.on('line', (line) => {
    if (inputBusy) return; // randul apartine unei intrebari de login
    const raw = line.trim();
    if (!raw) return;
    const key = raw.toLowerCase();
    // comenzile de control merg doar fara argumente si fara prefix
    if (!raw.startsWith(PREFIX) && consoleCommands[key]) { consoleCommands[key](); return; }
    queueBotCommand(raw);
});
cli.on('close', () => { /* stdin inchis (nohup/systemd): botul continua sa ruleze */ });

process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
process.on('uncaughtException', (err) => log(`Exceptie: ${err.message}`, 'error'));
process.on('unhandledRejection', (err) => log(`Promisiune respinsa: ${err && err.message ? err.message : err}`, 'error'));

console.log([
    '',
    '==============================',
    '   INSTAGRAM BOT',
    '==============================',
    '',
    `Mod: ${HEADLESS ? 'headless (server / VPS)' : 'interactiv (terminal)'}`,
    `Date salvate in: ${DATA_DIR}`,
    '',
    'Scrie "start" pentru a porni botul.',
    'Scrie "help" pentru comenzile din consola.',
    `Orice comanda de bot merge si aici (ex: "${PREFIX}status" sau "status").`,
    '',
].join('\n'));

if (AUTO_START) {
    if (HEADLESS && !fs.existsSync(SESSION_FILE) && !process.env.IG_USERNAME) {
        log('Mod headless fara sesiune salvata si fara IG_USERNAME/IG_PASSWORD in .env. Nu pot face login.', 'error');
    } else {
        start();
    }
}
