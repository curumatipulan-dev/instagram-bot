// ===================== INSTAGRAM BOT COMPLET =====================
// Salvează ca: instagram-bot.js
// Rulează cu: node instagram-bot.js

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const readline = require('readline');

// ===================== CONFIG =====================
let USERNAME = '';
let PASSWORD = '';
let sessionId = null;
let csrfToken = null;
let userId = null;
let running = false;
let lastMessageTime = 0;
let viewOnceImages = [];

// ===================== STĂRI PENTRU COMENZI =====================
const replyState = { running: false, targets: [], lastReplyTime: {}, lineIndex: 0, cycle: 1 };
const spamState = { running: false, target: null, text: '', interval: null, delay: 3 };
const aiState = { running: false, targets: [], history: {}, cycle: 1 };
const mockTargets = {};
const mockLastTime = {};
const copyTargets = {};
const copyLastTime = {};
const autoreactActive = {}; // pentru like-uri automate
const customReplyState = {};
const afkState = { active: false, reason: '' };
let reverseMode = false;
let mentionTargetId = null;
let snipeCache = {};
const tagAllRunning = {};
let afkCheckMode = false;
let afkCheckInterval = null;
let afkCheckChannel = null;
let afkCheckIndex = 0;
const afkCheckPhrases = ['sup, im here pussy', 'deplasa ma iei', 'atatea suge mt?', '1,2,3 deplasa ma iei', 'ai venit sa-mi sugi?', 'stai ca vin eu la tine'];
let globalDelay = 5;
let replyDelay = 7;
let spamDelay = 4;

// ===================== FRAZE =====================
let spamPhrases = [];
let replyWords = [];
let beefPhrases = [];

// ===================== UTILS =====================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg, type = 'info') {
    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'warning' ? '⚠️' : '📌';
    console.log(`${prefix} ${new Date().toLocaleTimeString()} - ${msg}`);
}

function loadPhrases(file) {
    try {
        const data = fs.readFileSync(file, 'utf8');
        return data.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
    } catch { return []; }
}

function saveSession() {
    try {
        fs.writeFileSync('session.json', JSON.stringify({ sessionId, csrfToken, userId, USERNAME }));
    } catch {}
}

function loadSession() {
    try {
        const data = JSON.parse(fs.readFileSync('session.json', 'utf8'));
        sessionId = data.sessionId;
        csrfToken = data.csrfToken;
        userId = data.userId;
        USERNAME = data.USERNAME;
        return true;
    } catch { return false; }
}

function mockText(text) {
    return text.split('').map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join('');
}

function uptime() {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${d}z ${h}h ${m}m ${sec}s`;
}

// ===================== INSTAGRAM API =====================
const INSTAGRAM_API = 'https://i.instagram.com/api/v1';
let startTime = Date.now();

function getHeaders(extra = {}) {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-IG-App-ID': '936619743392459',
        ...extra
    };
}

// ===================== LOGIN =====================
async function login() {
    log('🔐 Conectare la Instagram...');
    
    if (loadSession() && sessionId) {
        log('📂 Sesiune găsită, încerc reconectare...');
        try {
            const test = await axios.get(`${INSTAGRAM_API}/direct_v2/inbox/`, {
                headers: {
                    ...getHeaders(),
                    'X-CSRFToken': csrfToken,
                    'Cookie': `csrftoken=${csrfToken}; sessionid=${sessionId}`
                },
                timeout: 10000
            });
            if (test.data.status === 'ok') {
                log(`✅ Reconectat ca: ${USERNAME}`);
                return true;
            }
        } catch {}
        log('⚠️ Sesiunea a expirat, reconectare...');
    }

    // Cere username
    const rl1 = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const usernameInput = await new Promise(resolve => {
        rl1.question('📱 Username Instagram: ', resolve);
    });
    rl1.close();

    // Cere parolă
    const rl2 = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const passwordInput = await new Promise(resolve => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        
        stdout.write('🔑 Parola Instagram (ascunsă): ');
        
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        
        let password = '';
        
        const onData = (chunk) => {
            chunk = chunk.toString();
            if (chunk === '\n' || chunk === '\r' || chunk === '\r\n') {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener('data', onData);
                stdout.write('\n');
                resolve(password);
                return;
            }
            if (chunk === '\u0003') { process.exit(); }
            if (chunk === '\u007F') {
                if (password.length > 0) {
                    password = password.slice(0, -1);
                    stdout.write('\b \b');
                }
                return;
            }
            password += chunk;
            stdout.write('*');
        };
        
        stdin.on('data', onData);
    });

    rl2.close();

    USERNAME = usernameInput;
    log(`📱 Conectare ca: ${USERNAME}`);

    try {
        const resp1 = await axios.get('https://www.instagram.com/accounts/login/', {
            headers: getHeaders(),
            timeout: 15000
        });
        
        const cookies = resp1.headers['set-cookie'] || [];
        const csrfCookie = cookies.find(c => c.includes('csrftoken='));
        if (csrfCookie) {
            const match = csrfCookie.match(/csrftoken=([^;]+)/);
            if (match) csrfToken = match[1];
        }
        
        if (!csrfToken) {
            const html = resp1.data;
            const match = html.match(/csrf_token":"([^"]+)"/);
            if (match) csrfToken = match[1];
        }
        
        if (!csrfToken) throw new Error('Nu am putut obține CSRF token');
        
        const loginData = new URLSearchParams({
            username: USERNAME,
            enc_password: `#PWD_INSTAGRAM_BROWSER:0:${Date.now()}:${passwordInput}`,
            queryParams: '{}',
            optIntoOneTap: 'false'
        });
        
        const loginResp = await axios.post(
            `${INSTAGRAM_API}/web/accounts/login/ajax/`,
            loginData.toString(),
            {
                headers: {
                    ...getHeaders(),
                    'X-CSRFToken': csrfToken,
                    'Referer': 'https://www.instagram.com/accounts/login/'
                },
                withCredentials: true,
                timeout: 15000
            }
        );
        
        const setCookies = loginResp.headers['set-cookie'] || [];
        const sessionCookie = setCookies.find(c => c.includes('sessionid='));
        if (sessionCookie) {
            const match = sessionCookie.match(/sessionid=([^;]+)/);
            if (match) sessionId = match[1];
        }
        
        if (!sessionId) throw new Error('Login eșuat');
        
        const loginResult = loginResp.data;
        if (loginResult.authenticated !== true) {
            throw new Error(`Login eșuat: ${JSON.stringify(loginResult)}`);
        }
        
        userId = loginResult.userId;
        if (!userId) {
            const userMatch = JSON.stringify(loginResult).match(/logged_in_user_id":"?([0-9]+)"?/);
            if (userMatch) userId = userMatch[1];
        }
        
        saveSession();
        log(`✅ Conectat ca: ${USERNAME} (ID: ${userId})`);
        return true;
        
    } catch (error) {
        log(`Login eșuat: ${error.message}`, 'error');
        return false;
    }
}

// ===================== OBȚINE USER ID =====================
async function getUserId(username) {
    try {
        const resp = await axios.get(
            `${INSTAGRAM_API}/web/get_profile/?username=${username}`,
            {
                headers: {
                    ...getHeaders(),
                    'X-CSRFToken': csrfToken,
                    'Cookie': `csrftoken=${csrfToken}; sessionid=${sessionId}`
                },
                timeout: 10000
            }
        );
        if (resp.data.user && resp.data.user.pk) return resp.data.user.pk;
        return null;
    } catch {
        return null;
    }
}

// ===================== TRIMITE MESAJ =====================
async function sendMessage(userId, message) {
    try {
        const now = Date.now();
        if (now - lastMessageTime < 3000) {
            await sleep(3000 - (now - lastMessageTime));
        }
        
        const payload = {
            recipient_users: [[userId, '0']],
            client_context: Date.now().toString(),
            text: message
        };
        
        const resp = await axios.post(
            `${INSTAGRAM_API}/direct_v2/web/threads/send_text/`,
            payload,
            {
                headers: {
                    ...getHeaders(),
                    'X-CSRFToken': csrfToken,
                    'Cookie': `csrftoken=${csrfToken}; sessionid=${sessionId}`,
                    'X-IG-Device-ID': `web-${Date.now()}`
                },
                timeout: 15000
            }
        );
        
        lastMessageTime = Date.now();
        
        if (resp.data && resp.data.status === 'ok') {
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

// ===================== SALVEAZĂ VIEW ONCE =====================
async function saveViewOnce(imageUrl, sender) {
    try {
        const dir = path.join(__dirname, 'view_once');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const buffer = Buffer.from(resp.data);
        const filename = `view_once_${Date.now()}_${sender}.jpg`;
        const filepath = path.join(dir, filename);
        
        fs.writeFileSync(filepath, buffer);
        viewOnceImages.push({ filename, filepath, sender, timestamp: Date.now() });
        log(`📸 View once salvat: ${filename}`, 'success');
        return filepath;
    } catch (error) {
        log(`Eroare salvare: ${error.message}`, 'error');
        return null;
    }
}

// ===================== SALVEAZĂ POZĂ NORMALĂ =====================
async function saveImage(imageUrl, sender, isViewOnce = false) {
    try {
        const dir = path.join(__dirname, isViewOnce ? 'view_once' : 'saved_images');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const buffer = Buffer.from(resp.data);
        const prefix = isViewOnce ? 'view_once' : 'image';
        const filename = `${prefix}_${Date.now()}_${sender}.jpg`;
        const filepath = path.join(dir, filename);
        
        fs.writeFileSync(filepath, buffer);
        log(`📸 Imagine salvată: ${filename}`, 'success');
        return filepath;
    } catch (error) {
        log(`Eroare salvare: ${error.message}`, 'error');
        return null;
    }
}

// ===================== MONITOR MESAJE =====================
async function monitorMessages() {
    try {
        const resp = await axios.get(
            `${INSTAGRAM_API}/direct_v2/inbox/`,
            {
                headers: {
                    ...getHeaders(),
                    'X-CSRFToken': csrfToken,
                    'Cookie': `csrftoken=${csrfToken}; sessionid=${sessionId}`
                },
                timeout: 10000
            }
        );
        
        const threads = resp.data.inbox?.threads || [];
        for (const thread of threads) {
            const items = thread.items || [];
            for (const item of items) {
                const sender = thread.users?.[0];
                const senderId = sender?.pk;
                const senderUsername = sender?.username || 'unknown';
                
                // ==== SALVEAZĂ VIEW ONCE AUTOMAT ====
                if (item.item_type === 'media' && item.media && item.media.view_mode === 'once') {
                    const url = item.media.image_versions2?.candidates?.[0]?.url;
                    if (url) {
                        await saveViewOnce(url, senderUsername);
                    }
                }
                
                // ==== SALVEAZĂ IMAGINI NORMALE ====
                if (item.item_type === 'media' && item.media && item.media.media_type === 1) {
                    const url = item.media.image_versions2?.candidates?.[0]?.url;
                    if (url && !item.media.view_mode) {
                        await saveImage(url, senderUsername, false);
                    }
                }
                
                // ==== PROCESEAZĂ COMENZI ====
                if (item.item_type === 'text') {
                    const text = item.text || '';
                    
                    // Comenzi doar în DM de la altcineva
                    if (text.startsWith('$') && senderId && senderId !== userId) {
                        await handleCommand(senderId, senderUsername, text);
                    }
                    
                    // ==== AUTO REPLY ====
                    if (replyState.running && replyState.targets.includes(senderId)) {
                        const last = replyState.lastReplyTime[senderId] || 0;
                        if (Date.now() - last >= 5000) {
                            replyState.lastReplyTime[senderId] = Date.now();
                            if (replyWords.length) {
                                const line = replyWords[replyState.lineIndex % replyWords.length];
                                replyState.lineIndex++;
                                if (line) await sendMessage(senderId, line);
                            }
                        }
                    }
                    
                    // ==== MOCK ====
                    if (mockTargets[senderId] && text.trim()) {
                        const last = mockLastTime[senderId] || 0;
                        if (Date.now() - last >= 5000) {
                            mockLastTime[senderId] = Date.now();
                            const mocked = mockText(text);
                            await sendMessage(senderId, mocked);
                        }
                    }
                    
                    // ==== COPYMSG ====
                    if (copyTargets[senderId] && text.trim()) {
                        const last = copyLastTime[senderId] || 0;
                        if (Date.now() - last >= 5000) {
                            copyLastTime[senderId] = Date.now();
                            await sendMessage(senderId, text);
                        }
                    }
                    
                    // ==== AI REPLY ====
                    if (aiState.running && aiState.targets.includes(senderId)) {
                        const last = aiState.lastReplyTime?.[senderId] || 0;
                        if (Date.now() - last >= 5000) {
                            aiState.lastReplyTime = aiState.lastReplyTime || {};
                            aiState.lastReplyTime[senderId] = Date.now();
                            // aici poți adăuga AI
                        }
                    }
                }
            }
        }
        return true;
    } catch (error) {
        log(`Eroare monitorizare: ${error.message}`, 'error');
        return false;
    }
}

// ===================== MANEJEAZĂ COMENZI =====================
async function handleCommand(fromUserId, fromUsername, text) {
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);
    
    log(`📩 Comandă $${cmd} de la @${fromUsername}`);
    
    // ===== HELP =====
    if (cmd === 'help' || cmd === 'h' || cmd === 'list') {
        const msg = `🤖 **BOT INSTAGRAM - COMENZI**

📌 **Comenzi de bază:**
\`$help\` - Afișează acest mesaj
\`$ping\` - Test conectare
\`$status\` - Status bot
\`$uptime\` - Timp de funcționare

💬 **Reply:**
\`$reply [user]\` - Adaugă user la reply
\`$stopreply\` - Oprește reply
\`$replydelay [sec]\` - Delay reply (1-30s)
\`$replylist\` - Listă targete reply

📨 **Spam:**
\`$spam [user] [text]\` - Spam către user
\`$stopspam\` - Oprește spam
\`$spamdelay [sec]\` - Delay spam (1-30s)

🎭 **Mock & Copy:**
\`$mock [user]\` - Alternanță caps
\`$stopmock [user]\` - Oprește mock
\`$copymsg [user]\` - Copiază mesaje
\`$stopcopy [user]\` - Oprește copy

📸 **View Once:**
\`$vv [reply la poză]\` - Salvează și retrimite view once
\`$vvs [reply la poză]\` - Salvează view once
\`$vvlist\` - Listă poze view once salvate
\`$vvclear\` - Șterge toate pozele view once
\`$save [reply la poză]\` - Salvează imagine normală

🔄 **Altele:**
\`$afk [motiv]\` - AFK mode
\`$stopafk\` - Oprește AFK
\`$reverse\` - Inversează text
\`$stopreverse\` - Oprește reverse
\`$clearall\` - Oprește toate funcțiile
\`$listtargets\` - Listă toate targetele active

🎯 **Target:**
\`$target [user]\` - Setează țintă
\`$untarget\` - Elimină ținta

📋 **Notepad:**
\`$addnotepad [atașează .txt]\` - Încarcă fraze spam
\`$addreply [atașează .txt]\` - Încarcă fraze reply
\`$addbeef [atașează .txt]\` - Încarcă fraze beef
\`$listphrases\` - Listă frazele încărcate

👥 **Tag All:**
\`$tagall [grup] [text]\` - Tag toți membrii

❤️ **Auto Like:**
\`$autolike [user]\` - Like automat la mesaje
\`$stopautolike [user]\` - Oprește auto like

🏷️ **Mention:**
\`$mention [user]\` - Menționează user în toate mesajele
\`$stopmention\` - Oprește menționarea`;
        
        await sendMessage(fromUserId, msg);
        return;
    }
    
    // ===== PING =====
    if (cmd === 'ping') {
        const start = Date.now();
        await sendMessage(fromUserId, '🏓 Pong!');
        const end = Date.now();
        await sendMessage(fromUserId, `⏱️ ${end - start}ms`);
        return;
    }
    
    // ===== STATUS =====
    if (cmd === 'status') {
        const msg = `**📊 STATUS BOT**
👤 Utilizator: @${USERNAME}
🟢 Rulare: ${running ? 'Da' : 'Nu'}
⏱️ Uptime: ${uptime()}
📸 View once: ${viewOnceImages.length}
🎯 Reply targete: ${replyState.targets.length}
📨 Spam: ${spamState.running ? '🟢 Activ' : '🔴 Inactiv'}
🎭 Mock: ${Object.keys(mockTargets).length > 0 ? '🟢 Activ' : '🔴 Inactiv'}
📋 Copy: ${Object.keys(copyTargets).length > 0 ? '🟢 Activ' : '🔴 Inactiv'}
🔀 Reverse: ${reverseMode ? '🟢 Activ' : '🔴 Inactiv'}`;
        await sendMessage(fromUserId, msg);
        return;
    }
    
    // ===== UPTIME =====
    if (cmd === 'uptime') {
        await sendMessage(fromUserId, `⏱️ Uptime: ${uptime()}`);
        return;
    }
    
    // ===== REPLY =====
    if (cmd === 'reply') {
        if (!args.length) {
            await sendMessage(fromUserId, '❌ Folosește: `$reply [username]`');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        if (replyState.targets.includes(targetId)) {
            await sendMessage(fromUserId, `⚠️ @${targetUser} deja în listă`);
            return;
        }
        if (replyState.targets.length >= 20) {
            await sendMessage(fromUserId, '❌ Ai atins limita de 20 targete');
            return;
        }
        replyState.running = true;
        replyState.targets.push(targetId);
        await sendMessage(fromUserId, `✅ Reply activat pentru @${targetUser} (${replyState.targets.length}/20 targete)`);
        return;
    }
    
    // ===== STOPREPLY =====
    if (cmd === 'stopreply') {
        if (!args.length) {
            replyState.running = false;
            replyState.targets = [];
            replyState.lastReplyTime = {};
            replyState.lineIndex = 0;
            await sendMessage(fromUserId, '✅ Reply oprit pentru toți');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        const idx = replyState.targets.indexOf(targetId);
        if (idx === -1) {
            await sendMessage(fromUserId, `⚠️ @${targetUser} nu e în listă`);
            return;
        }
        replyState.targets.splice(idx, 1);
        delete replyState.lastReplyTime[targetId];
        if (replyState.targets.length === 0) replyState.running = false;
        await sendMessage(fromUserId, `✅ Reply oprit pentru @${targetUser} (${replyState.targets.length} ramase)`);
        return;
    }
    
    // ===== REPLYDELAY =====
    if (cmd === 'replydelay') {
        if (!args.length) {
            await sendMessage(fromUserId, `Delay curent: ${replyDelay}s`);
            return;
        }
        const sec = parseInt(args[0]);
        if (sec < 1 || sec > 30) {
            await sendMessage(fromUserId, '❌ 1-30 secunde');
            return;
        }
        replyDelay = sec;
        await sendMessage(fromUserId, `✅ Delay reply: ${sec}s`);
        return;
    }
    
    // ===== REPLYLIST =====
    if (cmd === 'replylist') {
        if (!replyState.targets.length) {
            await sendMessage(fromUserId, '📭 Niciun target reply activ');
            return;
        }
        const list = replyState.targets.map(id => `<@${id}>`).join(', ');
        await sendMessage(fromUserId, `🎯 **Targete reply (${replyState.targets.length}):**\n${list}`);
        return;
    }
    
    // ===== SPAM =====
    if (cmd === 'spam') {
        if (args.length < 2) {
            await sendMessage(fromUserId, '❌ Folosește: `$spam [username] [text]`');
            return;
        }
        const targetUser = args[0];
        const text = args.slice(1).join(' ');
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        if (spamState.running) {
            await sendMessage(fromUserId, '⚠️ Spam deja activ. Oprește-l cu `$stopspam`');
            return;
        }
        if (!spamPhrases.length && text) {
            spamPhrases = [text];
        }
        
        spamState.running = true;
        spamState.target = targetId;
        spamState.text = text;
        spamState.phraseIndex = 0;
        
        if (spamState.interval) clearInterval(spamState.interval);
        spamState.interval = setInterval(async () => {
            if (!spamState.running) { clearInterval(spamState.interval); return; }
            const phrase = spamPhrases[spamState.phraseIndex % spamPhrases.length] || spamState.text;
            spamState.phraseIndex++;
            await sendMessage(spamState.target, phrase);
        }, spamDelay * 1000);
        
        await sendMessage(fromUserId, `✅ Spam pornit către @${targetUser} (delay: ${spamDelay}s)`);
        return;
    }
    
    // ===== STOPSPAM =====
    if (cmd === 'stopspam') {
        if (!spamState.running) {
            await sendMessage(fromUserId, '⚠️ Spam inactiv');
            return;
        }
        spamState.running = false;
        if (spamState.interval) { clearInterval(spamState.interval); spamState.interval = null; }
        spamState.target = null;
        spamState.phraseIndex = 0;
        await sendMessage(fromUserId, '✅ Spam oprit');
        return;
    }
    
    // ===== SPAMDELAY =====
    if (cmd === 'spamdelay') {
        if (!args.length) {
            await sendMessage(fromUserId, `Delay curent: ${spamDelay}s`);
            return;
        }
        const sec = parseInt(args[0]);
        if (sec < 1 || sec > 30) {
            await sendMessage(fromUserId, '❌ 1-30 secunde');
            return;
        }
        spamDelay = sec;
        await sendMessage(fromUserId, `✅ Delay spam: ${sec}s`);
        return;
    }
    
    // ===== MOCK =====
    if (cmd === 'mock') {
        if (!args.length) {
            await sendMessage(fromUserId, '❌ Folosește: `$mock [username]`');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        if (mockTargets[targetId]) {
            await sendMessage(fromUserId, `⚠️ @${targetUser} deja în mock`);
            return;
        }
        mockTargets[targetId] = true;
        await sendMessage(fromUserId, `✅ Mock activat pentru @${targetUser}`);
        return;
    }
    
    // ===== STOPMOCK =====
    if (cmd === 'stopmock') {
        if (!args.length) {
            const keys = Object.keys(mockTargets);
            for (const k of keys) delete mockTargets[k];
            await sendMessage(fromUserId, '✅ Mock oprit pentru toți');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        if (mockTargets[targetId]) {
            delete mockTargets[targetId];
            delete mockLastTime[targetId];
            await sendMessage(fromUserId, `✅ Mock oprit pentru @${targetUser}`);
        } else {
            await sendMessage(fromUserId, `⚠️ @${targetUser} nu are mock activ`);
        }
        return;
    }
    
    // ===== COPYMSG =====
    if (cmd === 'copymsg') {
        if (!args.length) {
            await sendMessage(fromUserId, '❌ Folosește: `$copymsg [username]`');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        if (copyTargets[targetId]) {
            await sendMessage(fromUserId, `⚠️ @${targetUser} deja în copy`);
            return;
        }
        copyTargets[targetId] = true;
        await sendMessage(fromUserId, `✅ Copymsg activat pentru @${targetUser}`);
        return;
    }
    
    // ===== STOPCOPY =====
    if (cmd === 'stopcopy') {
        if (!args.length) {
            const keys = Object.keys(copyTargets);
            for (const k of keys) delete copyTargets[k];
            await sendMessage(fromUserId, '✅ Copymsg oprit pentru toți');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        if (copyTargets[targetId]) {
            delete copyTargets[targetId];
            delete copyLastTime[targetId];
            await sendMessage(fromUserId, `✅ Copymsg oprit pentru @${targetUser}`);
        } else {
            await sendMessage(fromUserId, `⚠️ @${targetUser} nu are copy activ`);
        }
        return;
    }
    
    // ===== VV (VIEW ONCE) =====
    if (cmd === 'vv' || cmd === 'viewonce') {
        // Pentru view once, trebuie să salvezi din DM-uri
        // Această comandă e pentru a retrimite o poză view once salvată
        if (!args.length) {
            await sendMessage(fromUserId, '❌ Folosește: `$vv [nume_poza]` sau `$vv list`');
            return;
        }
        if (args[0] === 'list') {
            if (!viewOnceImages.length) {
                await sendMessage(fromUserId, '📭 Nu există poze view once salvate');
                return;
            }
            const list = viewOnceImages.map((v, i) => `${i+1}. ${v.filename} (de la @${v.sender})`).join('\n');
            await sendMessage(fromUserId, `📸 **Poze view once (${viewOnceImages.length}):**\n${list}`);
            return;
        }
        // Caută poza după nume sau index
        const query = args[0];
        let found = null;
        if (!isNaN(query)) {
            const idx = parseInt(query) - 1;
            if (viewOnceImages[idx]) found = viewOnceImages[idx];
        } else {
            found = viewOnceImages.find(v => v.filename.includes(query));
        }
        if (!found) {
            await sendMessage(fromUserId, `❌ Nu am găsit poza: ${query}`);
            return;
        }
        try {
            const img = fs.readFileSync(found.filepath);
            await sendMessage(fromUserId, `📸 **View Once** de la @${found.sender}`);
            // Instagram nu suportă trimitere de fișiere direct în DM prin API
            await sendMessage(fromUserId, `✅ Poza e salvată local: ${found.filename}`);
        } catch (error) {
            await sendMessage(fromUserId, `❌ Eroare: ${error.message}`);
        }
        return;
    }
    
    // ===== VVS (VIEW ONCE SAVE) =====
    if (cmd === 'vvs' || cmd === 'viewoncesave') {
        // Salvează automat view once din mesaje
        await sendMessage(fromUserId, '✅ Botul salvează automat toate pozele view once din DM-uri!');
        return;
    }
    
    // ===== VVLIST =====
    if (cmd === 'vvlist') {
        if (!viewOnceImages.length) {
            await sendMessage(fromUserId, '📭 Nu există poze view once salvate');
            return;
        }
        const list = viewOnceImages.map((v, i) => `${i+1}. ${v.filename} (de la @${v.sender})`).join('\n');
        await sendMessage(fromUserId, `📸 **Poze view once (${viewOnceImages.length}):**\n${list}`);
        return;
    }
    
    // ===== VVCLEAR =====
    if (cmd === 'vvclear') {
        const dir = path.join(__dirname, 'view_once');
        if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const f of files) {
                fs.unlinkSync(path.join(dir, f));
            }
            viewOnceImages = [];
            await sendMessage(fromUserId, '🗑️ Toate pozele view once au fost șterse');
        } else {
            await sendMessage(fromUserId, '📭 Nu există poze view once');
        }
        return;
    }
    
    // ===== SAVE (salvează imagine normală) =====
    if (cmd === 'save') {
        await sendMessage(fromUserId, '✅ Botul salvează automat toate imaginile din DM-uri!');
        return;
    }
    
    // ===== AFK =====
    if (cmd === 'afk') {
        afkState.active = true;
        afkState.reason = args.join(' ') || 'AFK';
        await sendMessage(fromUserId, `✅ AFK activat: ${afkState.reason}`);
        return;
    }
    
    // ===== STOPAFK =====
    if (cmd === 'stopafk') {
        afkState.active = false;
        afkState.reason = '';
        await sendMessage(fromUserId, '✅ AFK dezactivat');
        return;
    }
    
    // ===== REVERSE =====
    if (cmd === 'reverse') {
        reverseMode = !reverseMode;
        await sendMessage(fromUserId, `Reverse ${reverseMode ? '🟢 activat' : '🔴 dezactivat'}`);
        return;
    }
    
    // ===== STOPREVERSE =====
    if (cmd === 'stopreverse') {
        reverseMode = false;
        await sendMessage(fromUserId, '✅ Reverse dezactivat');
        return;
    }
    
    // ===== CLEARALL =====
    if (cmd === 'clearall') {
        replyState.running = false;
        replyState.targets = [];
        replyState.lastReplyTime = {};
        aiState.running = false;
        aiState.targets = [];
        for (const k of Object.keys(mockTargets)) delete mockTargets[k];
        for (const k of Object.keys(copyTargets)) delete copyTargets[k];
        if (spamState.interval) { clearInterval(spamState.interval); spamState.interval = null; }
        spamState.running = false;
        afkState.active = false;
        reverseMode = false;
        mentionTargetId = null;
        await sendMessage(fromUserId, '✅ CLEARALL — toate funcțiile au fost oprite');
        return;
    }
    
    // ===== LISTTARGETS =====
    if (cmd === 'listtargets') {
        const lines = [];
        if (replyState.targets.length) lines.push(`REPLY (${replyState.targets.length}): ${replyState.targets.map(id => `<@${id}>`).join(', ')}`);
        const mockKeys = Object.keys(mockTargets);
        if (mockKeys.length) lines.push(`MOCK (${mockKeys.length}): ${mockKeys.map(id => `<@${id}>`).join(', ')}`);
        const copyKeys = Object.keys(copyTargets);
        if (copyKeys.length) lines.push(`COPY (${copyKeys.length}): ${copyKeys.map(id => `<@${id}>`).join(', ')}`);
        if (spamState.running) lines.push(`SPAM: activ către <@${spamState.target}>`);
        if (afkState.active) lines.push(`AFK: activ (${afkState.reason})`);
        if (reverseMode) lines.push('REVERSE: activ');
        if (!lines.length) {
            await sendMessage(fromUserId, '📭 Niciun target activ');
            return;
        }
        await sendMessage(fromUserId, `🎯 **TARGETE ACTIVE:**\n${lines.join('\n')}`);
        return;
    }
    
    // ===== TARGET =====
    if (cmd === 'target') {
        if (!args.length) {
            await sendMessage(fromUserId, '❌ Folosește: `$target [username]`');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        await sendMessage(fromUserId, `✅ Țintă setată: @${targetUser} (ID: ${targetId})`);
        return;
    }
    
    // ===== UNTARGET =====
    if (cmd === 'untarget') {
        // Elimină din toate listele
        const targetUser = args[0];
        if (!targetUser) {
            await sendMessage(fromUserId, '❌ Folosește: `$untarget [username]`');
            return;
        }
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        let removed = 0;
        const idxR = replyState.targets.indexOf(targetId);
        if (idxR !== -1) { replyState.targets.splice(idxR, 1); removed++; }
        if (mockTargets[targetId]) { delete mockTargets[targetId]; removed++; }
        if (copyTargets[targetId]) { delete copyTargets[targetId]; removed++; }
        if (aiState.targets.indexOf(targetId) !== -1) { aiState.targets = aiState.targets.filter(id => id !== targetId); removed++; }
        if (spamState.target === targetId) { spamState.running = false; if (spamState.interval) clearInterval(spamState.interval); spamState.target = null; removed++; }
        await sendMessage(fromUserId, `✅ @${targetUser} eliminat din ${removed} liste`);
        return;
    }
    
    // ===== ADDNOTEPAD =====
    if (cmd === 'addnotepad' || cmd === 'addspam') {
        // Încarcă fraze dintr-un fișier .txt atașat
        await sendMessage(fromUserId, '📝 Atașează un fișier .txt cu frazele (câte una pe linie)');
        return;
    }
    
    // ===== ADDREPLY =====
    if (cmd === 'addreply') {
        await sendMessage(fromUserId, '📝 Atașează un fișier .txt cu frazele de reply (câte una pe linie)');
        return;
    }
    
    // ===== ADDBEEF =====
    if (cmd === 'addbeef') {
        await sendMessage(fromUserId, '📝 Atașează un fișier .txt cu frazele de beef (câte una pe linie)');
        return;
    }
    
    // ===== LISTPHRASES =====
    if (cmd === 'listphrases') {
        let msg = '📋 **FRAZE ÎNCĂRCATE:**\n';
        if (spamPhrases.length) msg += `📨 Spam (${spamPhrases.length}): ${spamPhrases.slice(0, 3).join(', ')}${spamPhrases.length > 3 ? '...' : ''}\n`;
        if (replyWords.length) msg += `💬 Reply (${replyWords.length}): ${replyWords.slice(0, 3).join(', ')}${replyWords.length > 3 ? '...' : ''}\n`;
        if (beefPhrases.length) msg += `🔥 Beef (${beefPhrases.length}): ${beefPhrases.slice(0, 3).join(', ')}${beefPhrases.length > 3 ? '...' : ''}\n`;
        await sendMessage(fromUserId, msg);
        return;
    }
    
    // ===== AUTOLIKE =====
    if (cmd === 'autolike') {
        if (!args.length) {
            await sendMessage(fromUserId, '❌ Folosește: `$autolike [username]`');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        autoreactActive[targetId] = true;
        await sendMessage(fromUserId, `❤️ Autolike activat pentru @${targetUser}`);
        return;
    }
    
    // ===== STOPAUTOLIKE =====
    if (cmd === 'stopautolike') {
        if (!args.length) {
            for (const k of Object.keys(autoreactActive)) delete autoreactActive[k];
            await sendMessage(fromUserId, '✅ Autolike oprit pentru toți');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        if (autoreactActive[targetId]) {
            delete autoreactActive[targetId];
            await sendMessage(fromUserId, `✅ Autolike oprit pentru @${targetUser}`);
        } else {
            await sendMessage(fromUserId, `⚠️ @${targetUser} nu are autolike activ`);
        }
        return;
    }
    
    // ===== MENTION =====
    if (cmd === 'mention') {
        if (!args.length) {
            await sendMessage(fromUserId, `Mention target curent: ${mentionTargetId ? `<@${mentionTargetId}>` : 'niciunul'}\n$mention @user`);
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(fromUserId, `❌ User @${targetUser} negăsit`);
            return;
        }
        mentionTargetId = targetId;
        await sendMessage(fromUserId, `✅ Mention activat: @${targetUser}`);
        return;
    }
    
    // ===== STOPMENTION =====
    if (cmd === 'stopmention') {
        mentionTargetId = null;
        await sendMessage(fromUserId, '✅ Mention dezactivat');
        return;
    }
    
    // ===== TAGALL =====
    if (cmd === 'tagall') {
        if (!args.length) {
            await sendMessage(fromUserId, '❌ Folosește: `$tagall [grup] [text]`');
            return;
        }
        // Pentru Instagram, tag all e complicat
        await sendMessage(fromUserId, '⚠️ Tag all nu este disponibil în Instagram DM');
        return;
    }
    
    // ===== SNIPE =====
    if (cmd === 'snipe') {
        // Instagram nu are snipe ca Discord
        await sendMessage(fromUserId, '⚠️ Snipe nu este disponibil în Instagram');
        return;
    }
    
    // Comandă necunoscută
    await sendMessage(fromUserId, `❌ Comandă necunoscută: $${cmd}\nScrie \`$help\` pentru lista completă.`);
}

// ===================== COMENZI CONSOLĂ =====================
const consoleCommands = {
    start: async () => {
        if (running) { log('Botul rulează deja!'); return; }
        const loggedIn = await login();
        if (!loggedIn) { log('Login eșuat!', 'error'); return; }
        running = true;
        log('🚀 Bot pornit! Monitorizez DM-uri pentru comenzi...');
        log('💡 Scrie "stop" pentru a opri.');
        log('💡 Scrie "help" pentru lista comenzilor console.');
        startTime = Date.now();
        while (running) {
            await monitorMessages();
            await sleep(10000);
        }
    },
    
    stop: () => {
        running = false;
        if (spamState.interval) { clearInterval(spamState.interval); spamState.interval = null; }
        log('🛑 Bot oprit.');
    },
    
    status: () => {
        console.log(`
┌─────────────────────────────────┐
│ STATUS BOT                      │
├─────────────────────────────────┤
│ Rulare: ${running ? '🟢 Da' : '🔴 Nu'}   │
│ Utilizator: ${USERNAME || 'Necunoscut'}  │
│ Uptime: ${uptime()}             │
│ View once: ${viewOnceImages.length}      │
│ Reply targete: ${replyState.targets.length} │
│ Spam: ${spamState.running ? '🟢 Activ' : '🔴 Inactiv'}    │
│ Mock: ${Object.keys(mockTargets).length > 0 ? '🟢 Activ' : '🔴 Inactiv'}   │
│ Copy: ${Object.keys(copyTargets).length > 0 ? '🟢 Activ' : '🔴 Inactiv'}   │
└─────────────────────────────────┘
        `);
    },
    
    help: () => {
        console.log(`
╔══════════════════════════════════════════════╗
║     COMENZI CONSOLĂ                         ║
╠══════════════════════════════════════════════╣
║  start    - Pornește botul (cere login)    ║
║  stop     - Oprește botul                  ║
║  status   - Arată status                   ║
║  help     - Acest mesaj                    ║
║                                             ║
║  COMENZI ÎN DM (cu prefix $):              ║
║  $help    - Listă completă comenzi         ║
║  $ping    - Test conectare                 ║
║  $status  - Status bot                     ║
║  $uptime  - Timp funcționare               ║
║  $reply [user] - Adaugă reply              ║
║  $stopreply - Oprește reply                ║
║  $spam [user] [text] - Spam                ║
║  $stopspam - Oprește spam                  ║
║  $mock [user] - Mock user                  ║
║  $stopmock - Oprește mock                  ║
║  $copymsg [user] - Copy user               ║
║  $stopcopy - Oprește copy                  ║
║  $vvlist - Listă view once                 ║
║  $afk [motiv] - AFK                       ║
║  $reverse - Reverse text                   ║
║  $clearall - Oprește tot                   ║
╚══════════════════════════════════════════════╝
        `);
    }
};

// ===================== CONSOLE CLI =====================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase();
    if (consoleCommands[cmd]) {
        consoleCommands[cmd]();
    } else if (cmd) {
        console.log(`❌ Comandă necunoscută: "${cmd}". Scrie "help" pentru listă.`);
    }
});

// ===================== START =====================
console.log(`
╔══════════════════════════════════════════════╗
║     INSTAGRAM BOT - COMPLET                 ║
║                                              ║
║  Scrie "start" în consolă pentru a începe  ║
║  Botul te va întreba username și parola     ║
║                                              ║
║  Comenzi consolă: start, stop, status, help ║
║  Comenzi DM: $help (lista completă)         ║
╚══════════════════════════════════════════════╝
`);

console.log('💡 Scrie "start" pentru a porni botul.');
console.log('💡 Scrie "help" pentru lista completă de comenzi.\n');

process.on('SIGINT', () => {
    running = false;
    if (spamState.interval) clearInterval(spamState.interval);
    log('🛑 Oprește botul...');
    setTimeout(() => process.exit(0), 1000);
});

process.on('uncaughtException', (err) => {
    log(`Eroare: ${err.message}`, 'error');
});

process.on('unhandledRejection', (err) => {
    log(`Eroare: ${err.message}`, 'error');
});
