# Instagram Bot

Bot de Instagram care se comanda din DM-uri (prefix `$`) **si direct din terminal**.
Ruleaza pe Termux, pe localhost (Windows / Linux / macOS) si pe hosting / VPS (pm2, systemd, Docker).

## Instalare rapida

```bash
git clone https://github.com/curumatipulan-dev/instagram-bot
cd instagram-bot
npm install
node instagram-bot.js
```

In consola scrii `start`, apoi username-ul si parola. Daca ai 2FA, botul cere codul.
Sesiunea se salveaza in `session.json`, deci la urmatoarele porniri nu mai ceri login.

Termux: `pkg update && pkg upgrade -y && pkg install nodejs-lts git -y` inainte de pasii de mai sus.

## Comenzi din terminal

Terminalul accepta doua tipuri de comenzi:

**Control** (fara prefix): `start`, `stop`, `status`, `logout`, `help`, `commands`, `exit`

**Toate comenzile de bot**, cu sau fara `$`. Exemple:

```text
$spam prieten salut
mock prieten
autolike prieten
note add cumpar paine
replydelay 10
listtargets
clearall
```

Raspunsul apare in terminal, iar actiunea se executa real pe Instagram.
Comenzile se executa in ordinea scrisa, una dupa alta.

## Comenzi DM (prefix `$`)

Scrie `$help` in orice conversatie si primesti lista completa in acel chat.

Baza: `$help`, `$ping`, `$status`, `$uptime`

Reply automat: `$reply [user]`, `$stopreply [user]`, `$replydelay [sec]`, `$replylist`

Spam: `$spam [user] [text]`, `$stopspam`, `$spamdelay [sec]`

Mock si copy: `$mock [user]`, `$stopmock [user]`, `$copymsg [user]`, `$stopcopy [user]`

Imagini: `$vvlist`, `$vvclear`

Notepad: `$note add [text]`, `$note list`, `$note delete [nr]`, `$note clear`

Altele: `$afk [motiv]`, `$stopafk`, `$reverse`, `$stopreverse`, `$autolike [user]`,
`$stopautolike [user]`, `$mention [user]`, `$stopmention`, `$target [user]`, `$untarget`,
`$listtargets`, `$clearall`

Fraze: `$addnotepad`, `$addreply`, `$addbeef`, `$listphrases`

## Configurare (.env)

Copiaza `.env.example` in `.env` si completeaza:

| Variabila | Ce face |
| --- | --- |
| `IG_USERNAME` / `IG_PASSWORD` | login fara sa scrii nimic la tastatura |
| `IG_TOTP_SECRET` | secretul din Google Authenticator; botul genereaza singur codul 2FA |
| `IG_AUTO_START` | `1` = porneste automat, fara sa scrii `start` |
| `IG_HEADLESS` | `1` = mod server, nu cere nimic interactiv |
| `IG_DATA_DIR` | unde se salveaza sesiunea, notitele si imaginile |

## Rulare pe hosting / VPS

Botul detecteaza singur ca nu are terminal si intra in mod headless: ia datele din `.env`
si porneste automat.

**PM2** (recomandat):

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
pm2 logs instagram-bot
```

**systemd**:

```bash
sudo cp -r . /opt/instagram-bot
sudo cp instagram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now instagram-bot
journalctl -u instagram-bot -f
```

**Docker**:

```bash
cp .env.example .env   # completeaza datele
docker compose up -d
docker compose logs -f
```

**nohup** (varianta minimala):

```bash
nohup node instagram-bot.js --headless --auto > bot.log 2>&1 &
```

Nota: hostingurile de tip shared / cPanel fara acces la procese Node de lunga durata nu sunt
potrivite. Ai nevoie de VPS sau de un plan cu Node.js persistent.

## Fisiere cu fraze

Pune in folderul botului (sau in `IG_DATA_DIR`), o fraza pe linie:

- `spam.txt` - frazele folosite de `$spam`
- `reply.txt` - frazele folosite de reply automat
- `beef.txt` - fraze suplimentare

## Ce s-a reparat

- `ig.account.login2FA` nu exista in `instagram-private-api`; metoda corecta este
  `twoFactorLogin`, iar raspunsul este body-ul brut, nu obiectul user. Loginul cu 2FA
  crapa inainte.
- `broadcastReaction` nu exista pe thread; `$autolike` nu functiona deloc. Acum reactia
  se trimite prin endpointul real `direct_v2/threads/broadcast/reaction/`.
- Comenzile mergeau doar din DM. Acum acelasi handler ruleaza si din terminal.
- Loginul cerea obligatoriu tastatura, deci botul nu putea rula pe VPS. Acum accepta
  `.env`, mod headless si 2FA automat prin TOTP.
- Sesiunea, notitele si imaginile pot fi scoase in `IG_DATA_DIR` (volum Docker, /var/lib).
- Oprire curata la `SIGTERM` (systemd/docker stop) si continuare la inchiderea stdin.

## Nota

Automatizarea Instagram poate duce la limitari sau blocarea contului.
Foloseste delay-uri mari si un cont pe care iti permiti sa il pierzi.
