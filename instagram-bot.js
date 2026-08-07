// ===================== INSTAGRAM BOT AVANSAT =====================
// Salvează ca: instagram-bot-advanced.js
// Rulează cu: node instagram-bot-advanced.js

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const readline = require('readline');

// ===================== CONFIG =====================
const INSTAGRAM_USERNAME = 'username_tau';
const INSTAGRAM_PASSWORD = 'parola_ta';
const TARGET_USERNAME = 'target_username'; // default target
const REPLY_COOLDOWN = 5000;

// ===================== STATE =====================
let sessionId = null;
let csrfToken = null;
let userId = null;
let running = false;
let lastMessageTime = 0;
let viewOnceImages = [];

// Stări pentru funcții similare cu Discord
const replyState = { running: false, targets: [], lastReplyTime: {}, lineIndex: 0 };
const spamState = { running: false, target: null, phraseIndex: 0, interval: null, delay: 5 };
const afkMode = { active: false, reason: '' };
let reverseMode = false;
let mockTargets = {};
let copyTargets = {};
const autoreactActive = {}; // pentru like-uri automate

// ===================== UTILS =====================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg, type = 'info') {
    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : '📌';
    console.log(`${prefix} ${new Date().toLocaleTimeString()} - ${msg}`);
}

function mockText(text) {
    return text.split('').map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join('');
}

function loadPhrases(file) {
    try {
        const data = fs.readFileSync(file, 'utf8');
        return data.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
    } catch { return []; }
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
async function login() {
    log('Încerc conectare la Instagram...');
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
            username: INSTAGRAM_USERNAME,
            enc_password: `#PWD_INSTAGRAM_BROWSER:0:${Date.now()}:${INSTAGRAM_PASSWORD}`,
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
        log(`✅ Conectat ca: ${INSTAGRAM_USERNAME} (ID: ${userId})`);
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
        throw new Error('User ID negăsit');
    } catch (error) {
        log(`Eroare obținere user ID: ${error.message}`, 'error');
        return null;
    }
}

// ===================== TRIMITE MESAJ =====================
async function sendMessage(userId, message) {
    try {
        const now = Date.now();
        if (now - lastMessageTime < REPLY_COOLDOWN) {
            await sleep(REPLY_COOLDOWN - (now - lastMessageTime));
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
            log(`✅ Mesaj trimis: "${message.substring(0, 30)}${message.length > 30 ? '...' : ''}"`);
            return true;
        }
        return false;
    } catch (error) {
        log(`Eroare trimitere: ${error.message}`, 'error');
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
                // View once detection
                if (item.item_type === 'media' && item.media && item.media.view_mode === 'once') {
                    const url = item.media.image_versions2?.candidates?.[0]?.url;
                    if (url) {
                        const sender = thread.users?.[0]?.username || 'unknown';
                        await saveViewOnce(url, sender);
                    }
                }
                
                // Auto-reply for targets
                const sender = thread.users?.[0];
                if (sender && replyState.targets.includes(sender.pk) && replyState.running) {
                    const last = replyState.lastReplyTime[sender.pk] || 0;
                    if (Date.now() - last >= REPLY_COOLDOWN) {
                        replyState.lastReplyTime[sender.pk] = Date.now();
                        // Trimite răspuns
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

// ===================== COMENZI =====================
const commands = {
    // ==== COMENZI DE BAZĂ ====
    start: async () => {
        if (running) { log('Botul rulează deja!'); return; }
        const loggedIn = await login();
        if (!loggedIn) { log('Login eșuat!', 'error'); return; }
        running = true;
        log('🚀 Bot pornit!');
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
│ Utilizator: ${INSTAGRAM_USERNAME}   │
│ Target: ${TARGET_USERNAME}      │
│ View once salvate: ${viewOnceImages.length}  │
│ Reply targete: ${replyState.targets.length}   │
│ Spam: ${spamState.running ? '🟢 Activ' : '🔴 Inactiv'}    │
└─────────────────────────────────┘
        `);
    },
    
    // ==== COMENZI REPLY (SIMILAR CU DISCORD) ====
    reply: async (args) => {
        if (!args.length) { log('❌ reply [username]'); return; }
        const username = args[0];
        const targetId = await getUserId(username);
        if (!targetId) { log(`❌ User ${username} negăsit`); return; }
        if (replyState.targets.includes(targetId)) { log(`⚠️ ${username} deja în listă`); return; }
        replyState.running = true;
        replyState.targets.push(targetId);
        log(`✅ Reply activat pentru @${username} (${replyState.targets.length} targete)`);
    },
    
    stopreply: (args) => {
        if (!args.length) {
            replyState.running = false;
            replyState.targets = [];
            replyState.lastReplyTime = {};
            log('✅ Reply oprit pentru toți');
            return;
        }
        // Implementare pentru oprire individual
    },
    
    // ==== COMENZI SPAM ====
    spam: async (args) => {
        if (!args.length) { log('❌ spam [username] [text]'); return; }
        const username = args[0];
        const text = args.slice(1).join(' ');
        if (!text) { log('❌ Spune și textul'); return; }
        
        const targetId = await getUserId(username);
        if (!targetId) { log(`❌ User ${username} negăsit`); return; }
        
        if (spamState.running) { log('⚠️ Spam deja activ'); return; }
        
        spamState.running = true;
        spamState.target = targetId;
        spamState.phraseIndex = 0;
        
        if (spamState.interval) clearInterval(spamState.interval);
        spamState.interval = setInterval(async () => {
            if (!spamState.running) { clearInterval(spamState.interval); return; }
            await sendMessage(spamState.target, text);
        }, spamState.delay * 1000);
        
        log(`✅ Spam pornit către @${username} (delay: ${spamState.delay}s)`);
    },
    
    stopspam: () => {
        if (!spamState.running) { log('⚠️ Spam inactiv'); return; }
        spamState.running = false;
        if (spamState.interval) { clearInterval(spamState.interval); spamState.interval = null; }
        spamState.target = null;
        log('✅ Spam oprit');
    },
    
    spamdelay: (args) => {
        if (!args.length) { log(`Delay curent: ${spamState.delay}s`); return; }
        const sec = parseInt(args[0]);
        if (sec < 1 || sec > 60) { log('❌ 1-60 secunde'); return; }
        spamState.delay = sec;
        log(`✅ Delay spam: ${sec}s`);
    },
    
    // ==== COMENZI AFK ====
    afk: (args) => {
        afkMode.active = !afkMode.active;
        afkMode.reason = args.join(' ') || '';
        log(`AFK ${afkMode.active ? '🟢 activat' : '🔴 dezactivat'}${afkMode.reason ? ` (${afkMode.reason})` : ''}`);
    },
    
    // ==== COMENZI MOCK ====
    mock: async (args) => {
        if (!args.length) { log('❌ mock [username]'); return; }
        const username = args[0];
        const targetId = await getUserId(username);
        if (!targetId) { log(`❌ User ${username} negăsit`); return; }
        mockTargets[targetId] = true;
        log(`✅ Mock activat pentru @${username}`);
    },
    
    stopmock: (args) => {
        if (!args.length) {
            mockTargets = {};
            log('✅ Mock oprit pentru toți');
            return;
        }
        // Implementare oprire individual
    },
    
    // ==== COMENZI COPY ====
    copymsg: async (args) => {
        if (!args.length) { log('❌ copymsg [username]'); return; }
        const username = args[0];
        const targetId = await getUserId(username);
        if (!targetId) { log(`❌ User ${username} negăsit`); return; }
        copyTargets[targetId] = true;
        log(`✅ Copymsg activat pentru @${username}`);
    },
    
    stopcopy: (args) => {
        if (!args.length) {
            copyTargets = {};
            log('✅ Copymsg oprit pentru toți');
            return;
        }
    },
    
    // ==== COMENZI VIEW ONCE ====
    vvlist: () => {
        const dir = path.join(__dirname, 'view_once');
        if (!fs.existsSync(dir)) { log('📭 Nu există poze view once'); return; }
        const files = fs.readdirSync(dir).filter(f => f.startsWith('view_once_'));
        if (!files.length) { log('📭 Nu există poze view once'); return; }
        console.log('\n📸 POZE VIEW ONCE SALVATE:');
        files.forEach((f, i) => {
            const stats = fs.statSync(path.join(dir, f));
            const size = (stats.size / 1024).toFixed(1);
            console.log(`  ${i+1}. ${f} (${size} KB)`);
        });
        console.log(`Total: ${files.length} poze\n`);
    },
    
    // ==== COMENZI UTILE ====
    target: async (args) => {
        if (!args.length) { log(`Target curent: ${TARGET_USERNAME}`); return; }
        const username = args[0];
        const id = await getUserId(username);
        if (!id) { log(`❌ ${username} negăsit`); return; }
        // Actualizează targetul
    },
    
    reverse: () => {
        reverseMode = !reverseMode;
        log(`Reverse ${reverseMode ? '🟢 activat' : '🔴 dezactivat'}`);
    },
    
    help: () => {
        console.log(`
╔══════════════════════════════════════════════╗
║     INSTAGRAM BOT - COMENZI                 ║
╠══════════════════════════════════════════════╣
║                                             ║
║  start      - Pornește botul               ║
║  stop       - Oprește botul                ║
║  status     - Arată status                 ║
║                                             ║
║  COMENZI REPLY:                            ║
║  reply [user] - Adaugă target reply       ║
║  stopreply   - Oprește reply              ║
║                                             ║
║  COMENZI SPAM:                             ║
║  spam [user] [text] - Spam către user     ║
║  stopspam    - Oprește spam               ║
║  spamdelay [sec] - Delay spam             ║
║                                             ║
║  COMENZI MOCK/COPY:                        ║
║  mock [user]  - Mock user                 ║
║  stopmock     - Oprește mock              ║
║  copymsg [user] - Copiază mesaje          ║
║  stopcopy     - Oprește copy              ║
║                                             ║
║  ALTE COMENZI:                             ║
║  afk [motiv]   - AFK mode                 ║
║  reverse       - Reverse text             ║
║  vvlist        - Listă view once          ║
║  target [user] - Setează target           ║
║  help          - Acest mesaj              ║
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
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const args = parts.slice(1);
    
    if (commands[cmd]) {
        commands[cmd](args);
    } else if (cmd) {
        console.log(`❌ Comandă necunoscută: "${cmd}". Scrie "help" pentru listă.`);
    }
});

// ===================== START =====================
console.log(`
╔══════════════════════════════════════════════╗
║     INSTAGRAM BOT AVANSAT                   ║
║                                              ║
║  Comenzi: help, start, stop, status        ║
║  reply, spam, mock, copymsg, afk, reverse  ║
║  vvlist, target, spamdelay                 ║
╚══════════════════════════════════════════════╝
`);

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
