# Instagram Bot

Bot Node.js care se conectează la contul tău de Instagram și răspunde la comenzi trimise prin DM.

## Instalare

```bash
npm install
npm start
```

Ai nevoie de **Node.js 18+**.

## Comenzi în consolă

| Comandă  | Ce face |
|----------|---------|
| `login`  | Conectare la Instagram (username + parolă, suportă 2FA) |
| `start`  | Pornește monitorizarea DM-urilor (face login dacă e nevoie) |
| `stop`   | Oprește monitorizarea |
| `status` | Starea curentă |
| `whoami` | Contul conectat |
| `logout` | Șterge sesiunea salvată |
| `help`   | Lista comenzilor |
| `exit`   | Închide programul |

## Comenzi în DM (prefix `$`)

Funcționează **doar de la contul tău** (trimise din propriul cont), ca să nu poată altcineva controla botul.

| Comandă | Ce face |
|---------|---------|
| `$help` | Lista comenzilor |
| `$status` | Starea botului |
| `$ping` | Test răspuns |
| `$afk [motiv]` | Pornește/oprește răspunsul automat AFK |
| `$reverse` | Inversează textul răspunsurilor |
| `$reply @user` | Auto-reply cu fraze din `reply.txt` |
| `$stopreply [@user]` | Oprește auto-reply |
| `$mock @user` | Răspunde cu `tExT aLtErNaT` |
| `$stopmock [@user]` | Oprește mock |

## `reply.txt`

Fișier opțional, o frază pe linie. Botul le folosește pe rând la `$reply`.

```
salut
ce faci?
mai vorbim
```

## Fișiere generate

- `session.json` — cookie-urile sesiunii (nu îl urca pe GitHub, e în `.gitignore`)

## Ce s-a reparat față de v1

- **Login-ul nu se mai suprapune peste consolă** — v1 avea două interfețe `readline` active în paralel, așa că username-ul tău era interpretat ca o comandă („comandă necunoscută”) iar promptul se amesteca cu `help`. Acum există un singur input activ la un moment dat.
- **Endpoint corect de login** (`www.instagram.com/api/v1/...` în loc de `i.instagram.com`) și timestamp în secunde la `enc_password` — v1 nu se putea autentifica deloc.
- **Cookie jar real** — `csrftoken`, `sessionid`, `ds_user_id`, `mid` sunt păstrate și trimise la fiecare cerere.
- **Suport 2FA** și mesaje clare pentru checkpoint / rate-limit / parolă greșită, în loc de „Login eșuat”.
- **Fără mesaje repetate** — v1 reprocesa tot inbox-ul la fiecare 10 secunde, deci retrimitea `$help` la nesfârșit. Acum fiecare mesaj se procesează o singură dată.
- **Crash-uri reparate** — `$stopmock` / `$stopcopy` fără argument aruncau `TypeError` (atribuire la `const`).
- **Trimiterea mesajelor funcționează** — endpoint `broadcast/text` cu form-urlencoded, plus rate limiting între mesaje.
- **Comenzile sunt restricționate la contul tău**, ca să nu ți-l poată controla oricine îți scrie `$spam`.

## Notă

Funcțiile de spam în masă și de salvare a pozelor „view once” din v1 au fost scoase intenționat: prima e folosită pentru hărțuire și îți duce contul la ban, a doua salvează conținut privat pe care expeditorul l-a trimis ca să dispară. Restul funcțiilor sunt intacte.

⚠️ Automatizarea contului încalcă Termenii Instagram și poate duce la limitări sau suspendarea contului. Folosește pe propriul risc, pe contul tău.
