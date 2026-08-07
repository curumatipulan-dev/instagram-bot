// ===================== INSTAGRAM BOT CU LOGIN INTERACTIV =====================
// Salvează ca: instagram-bot.js
// Rulează cu: node instagram-bot.js

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const readline = require('readline');

// ===================== SETĂRI =====================
const SESSION_FILE = path.join(__dirname, 'session.json');
const VIEW_ONCE_DIR = path.join(__dirname, 'view_once');

if (!fs.existsSync(VIEW_ONCE_DIR)) fs.mkdirSync(VIEW_ONCE_DIR, { recursive: true });

// ===================== STATE =====================
let sessionId = null;
let csrfToken = null;
let userId = null;
let username = '';
let running = false;
let lastMessageTime = 0;
let viewOnceImages = [];

// Stări pentru funcții
const replyState = { running: false, targets: [], lastReplyTime: {}, lineIndex: 0 };
const spamState = { running: false, target: null, phraseIndex: 0, interval: null, delay: 5 };
const afkState = { active: false, reason: '' };
const mockTargets = {};
const copyTargets = {};
let reverseMode = false;
let autoreactActive = {};

// Liste pentru răspunsuri
let replyPhrases = [];
let spamPhrases = [];

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
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId, csrfToken, userId, username }));
    } catch {}
}

function loadSession() {
    try {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        sessionId = data.sessionId;
        csrfToken = data.csrfToken;
        userId = data.userId;
        username = data.username;
        return true;
    } catch { return false; }
}

function mockText(text) {
    return text.split('').map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join('');
}

// ===================== INSTAGRAM API =====================
const INSTAGRAM_API = 'https://i.instagram.com/api/v1';

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
async function loginInteractive() {
    log('🔐 Conectare la Instagram...');
    
    // Verifică sesiune salvată
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
                log(`✅ Reconectat ca: ${username}`);
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

    // Folosește readline cu input ascuns
    const passwordInput = await new Promise(resolve => {
        // Pentru parolă ascunsă
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
            if (chunk === '\u0003') { // CTRL+C
                process.exit();
            }
            if (chunk === '\u007F') { // Backspace
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

    username = usernameInput;
    
    // Salvează username-ul în config
    log(`📱 Conectare ca: ${username}`);

    try {
        // Obține CSRF token
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
        
        // Login
        const loginData = new URLSearchParams({
            username: username,
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
        log(`✅ Conectat ca: ${username} (ID: ${userId})`);
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
        const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const buffer = Buffer.from(resp.data);
        const filename = `view_once_${Date.now()}_${sender}.jpg`;
        const filepath = path.join(VIEW_ONCE_DIR, filename);
        
        fs.writeFileSync(filepath, buffer);
        viewOnceImages.push({ filename, filepath, sender, timestamp: Date.now() });
        log(`📸 View once salvat: ${filename}`, 'success');
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
                // View once
                if (item.item_type === 'media' && item.media && item.media.view_mode === 'once') {
                    const url = item.media.image_versions2?.candidates?.[0]?.url;
                    if (url) {
                        const sender = thread.users?.[0]?.username || 'unknown';
                        await saveViewOnce(url, sender);
                    }
                }
                
                // Verifică comenzi în DM (prefix $)
                if (item.item_type === 'text') {
                    const text = item.text || '';
                    const sender = thread.users?.[0];
                    
                    // Comenzile funcționează doar în DM
                    if (text.startsWith('$') && sender && sender.pk !== userId) {
                        await handleCommandInDM(sender.pk, sender.username, text);
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

// ===================== MANEJEAZĂ COMENZI ÎN DM =====================
async function handleCommandInDM(userId, username, text) {
    const parts = text.slice(1).trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);
    
    log(`Comanda $${cmd} de la @${username}`);
    
    // ===== HELP =====
    if (cmd === 'help' || cmd === 'list') {
        const helpMsg = `🤖 **Bot Instagram - Comenzi**

**📌 Comenzi de bază:**
\`$help\` - Afișează acest mesaj
\`$status\` - Status bot
\`$ping\` - Ping

**💬 Reply:**
\`$reply [user]\` - Adaugă user la reply
\`$stopreply\` - Oprește reply

**📨 Spam:**
\`$spam [user] [text]\` - Spam către user
\`$stopspam\` - Oprește spam
\`$spamdelay [sec]\` - Delay spam (1-60s)

**🎭 Mock & Copy:**
\`$mock [user]\` - Alternanță caps
\`$stopmock [user]\` - Oprește mock
\`$copymsg [user]\` - Copiază mesaje
\`$stopcopy [user]\` - Oprește copy

**🔄 Altele:**
\`$afk [motiv]\` - AFK mode
\`$reverse\` - Inversează text
\`$vvlist\` - Listă view once
\`$target [user]\` - Setează țintă`;

        await sendMessage(userId, helpMsg);
        return;
    }
    
    // ===== STATUS =====
    if (cmd === 'status') {
        const msg = `**Status Bot**
📱 User: ${username}
🟢 Rulare: ${running ? 'Da' : 'Nu'}
🎯 Targete reply: ${replyState.targets.length}
📸 View once: ${viewOnceImages.length}
${spamState.running ? `📨 Spam: Activ (${spamState.delay}s)` : '📨 Spam: Inactiv'}`;
        await sendMessage(userId, msg);
        return;
    }
    
    // ===== PING =====
    if (cmd === 'ping') {
        const start = Date.now();
        await sendMessage(userId, '🏓 Pong!');
        return;
    }
    
    // ===== REPLY =====
    if (cmd === 'reply') {
        if (!args.length) {
            await sendMessage(userId, '❌ Folosește: `$reply [username]`');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(userId, `❌ User @${targetUser} negăsit`);
            return;
        }
        if (replyState.targets.includes(targetId)) {
            await sendMessage(userId, `⚠️ @${targetUser} deja în listă`);
            return;
        }
        replyState.running = true;
        replyState.targets.push(targetId);
        await sendMessage(userId, `✅ Reply activat pentru @${targetUser} (${replyState.targets.length} targete)`);
        return;
    }
    
    // ===== STOPREPLY =====
    if (cmd === 'stopreply') {
        replyState.running = false;
        replyState.targets = [];
        replyState.lastReplyTime = {};
        await sendMessage(userId, '✅ Reply oprit pentru toți');
        return;
    }
    
    // ===== SPAM =====
    if (cmd === 'spam') {
        if (args.length < 2) {
            await sendMessage(userId, '❌ Folosește: `$spam [username] [text]`');
            return;
        }
        const targetUser = args[0];
        const text = args.slice(1).join(' ');
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(userId, `❌ User @${targetUser} negăsit`);
            return;
        }
        if (spamState.running) {
            await sendMessage(userId, '⚠️ Spam deja activ. Oprește-l cu `$stopspam`');
            return;
        }
        
        spamState.running = true;
        spamState.target = targetId;
        spamState.phraseIndex = 0;
        
        if (spamState.interval) clearInterval(spamState.interval);
        spamState.interval = setInterval(async () => {
            if (!spamState.running) { clearInterval(spamState.interval); return; }
            await sendMessage(spamState.target, text);
        }, spamState.delay * 1000);
        
        await sendMessage(userId, `✅ Spam pornit către @${targetUser} (delay: ${spamState.delay}s)`);
        return;
    }
    
    // ===== STOPSPAM =====
    if (cmd === 'stopspam') {
        if (!spamState.running) {
            await sendMessage(userId, '⚠️ Spam inactiv');
            return;
        }
        spamState.running = false;
        if (spamState.interval) { clearInterval(spamState.interval); spamState.interval = null; }
        spamState.target = null;
        await sendMessage(userId, '✅ Spam oprit');
        return;
    }
    
    // ===== SPAMDELAY =====
    if (cmd === 'spamdelay') {
        if (!args.length) {
            await sendMessage(userId, `Delay curent: ${spamState.delay}s`);
            return;
        }
        const sec = parseInt(args[0]);
        if (sec < 1 || sec > 60) {
            await sendMessage(userId, '❌ 1-60 secunde');
            return;
        }
        spamState.delay = sec;
        await sendMessage(userId, `✅ Delay spam: ${sec}s`);
        return;
    }
    
    // ===== MOCK =====
    if (cmd === 'mock') {
        if (!args.length) {
            await sendMessage(userId, '❌ Folosește: `$mock [username]`');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(userId, `❌ User @${targetUser} negăsit`);
            return;
        }
        mockTargets[targetId] = true;
        await sendMessage(userId, `✅ Mock activat pentru @${targetUser}`);
        return;
    }
    
    // ===== STOPMOCK =====
    if (cmd === 'stopmock') {
        if (!args.length) {
            mockTargets = {};
            await sendMessage(userId, '✅ Mock oprit pentru toți');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (targetId && mockTargets[targetId]) {
            delete mockTargets[targetId];
            await sendMessage(userId, `✅ Mock oprit pentru @${targetUser}`);
        } else {
            await sendMessage(userId, `⚠️ @${targetUser} nu are mock activ`);
        }
        return;
    }
    
    // ===== COPYMSG =====
    if (cmd === 'copymsg') {
        if (!args.length) {
            await sendMessage(userId, '❌ Folosește: `$copymsg [username]`');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(userId, `❌ User @${targetUser} negăsit`);
            return;
        }
        copyTargets[targetId] = true;
        await sendMessage(userId, `✅ Copymsg activat pentru @${targetUser}`);
        return;
    }
    
    // ===== STOPCOPY =====
    if (cmd === 'stopcopy') {
        if (!args.length) {
            copyTargets = {};
            await sendMessage(userId, '✅ Copymsg oprit pentru toți');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (targetId && copyTargets[targetId]) {
            delete copyTargets[targetId];
            await sendMessage(userId, `✅ Copymsg oprit pentru @${targetUser}`);
        } else {
            await sendMessage(userId, `⚠️ @${targetUser} nu are copymsg activ`);
        }
        return;
    }
    
    // ===== AFK =====
    if (cmd === 'afk') {
        afkState.active = !afkState.active;
        afkState.reason = args.join(' ') || '';
        const status = afkState.active ? '🟢 activat' : '🔴 dezactivat';
        await sendMessage(userId, `AFK ${status}${afkState.reason ? ` (${afkState.reason})` : ''}`);
        return;
    }
    
    // ===== REVERSE =====
    if (cmd === 'reverse') {
        reverseMode = !reverseMode;
        await sendMessage(userId, `Reverse ${reverseMode ? '🟢 activat' : '🔴 dezactivat'}`);
        return;
    }
    
    // ===== VVLIST =====
    if (cmd === 'vvlist') {
        if (!viewOnceImages.length) {
            await sendMessage(userId, '📭 Nu există poze view once salvate');
            return;
        }
        const list = viewOnceImages.map((v, i) => `${i+1}. ${v.filename} (de la @${v.sender})`).join('\n');
        await sendMessage(userId, `📸 **Poze view once (${viewOnceImages.length}):**\n${list}`);
        return;
    }
    
    // ===== TARGET =====
    if (cmd === 'target') {
        if (!args.length) {
            await sendMessage(userId, '❌ Folosește: `$target [username]`');
            return;
        }
        const targetUser = args[0];
        const targetId = await getUserId(targetUser);
        if (!targetId) {
            await sendMessage(userId, `❌ User @${targetUser} negăsit`);
            return;
        }
        await sendMessage(userId, `✅ Țintă setată: @${targetUser} (ID: ${targetId})`);
        return;
    }
    
    // Comandă necunoscută
    await sendMessage(userId, `❌ Comandă necunoscută: $${cmd}\nScrie \`$help\` pentru lista completă.`);
}

// ===================== COMENZI CONSOLĂ =====================
const consoleCommands = {
    start: async () => {
        if (running) { log('Botul rulează deja!'); return; }
        const loggedIn = await loginInteractive();
        if (!loggedIn) { log('Login eșuat!', 'error'); return; }
        running = true;
        log('🚀 Bot pornit! Monitorizez DM-uri pentru comenzi...');
        log('💡 Scrie "stop" pentru a opri.');
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
│ Utilizator: ${username || 'Necunoscut'}  │
│ View once: ${viewOnceImages.length}      │
│ Reply targete: ${replyState.targets.length} │
│ Spam: ${spamState.running ? '🟢 Activ' : '🔴 Inactiv'}    │
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
║  $help    - Listă comenzi                 ║
║  $status  - Status bot                    ║
║  $reply [user] - Adaugă reply             ║
║  $stopreply - Oprește reply               ║
║  $spam [user] [text] - Spam               ║
║  $stopspam - Oprește spam                 ║
║  $mock [user] - Mock user                 ║
║  $copymsg [user] - Copy user              ║
║  $afk [motiv] - AFK                       ║
║  $reverse - Reverse text                  ║
║  $vvlist - Listă view once               ║
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
║     INSTAGRAM BOT - LOGIN INTERACTIV        ║
║                                              ║
║  Scrie "start" în consolă pentru a începe  ║
║  Botul te va întreba username și parola     ║
║                                              ║
║  Comenzi consolă: start, stop, status, help ║
║  Comenzi DM: $help                          ║
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
