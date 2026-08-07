# Instagram Bot pentru Termux

Bot de Instagram care ruleaza in Termux si se comanda direct din DM-uri, cu prefixul `$`.
Raspunsul botului vine mereu in acelasi chat in care ai scris comanda.

## Instalare in Termux

```bash
pkg update && pkg upgrade -y
pkg install nodejs-lts git -y
git clone https://github.com/curumatipulan-dev/instagram-bot
cd instagram-bot
npm install
node instagram-bot.js
```

In consola scrii `start`, apoi introduci username-ul si parola. Daca ai 2FA, botul iti cere codul.
Sesiunea se salveaza in `session.json`, deci la urmatoarele porniri nu mai ceri login.

Ca sa porneasca direct, fara sa scrii `start`:

```bash
node instagram-bot.js --auto
```

## Comenzi consola

| Comanda | Descriere |
| --- | --- |
| `start` | Porneste botul |
| `stop` | Opreste botul |
| `status` | Starea botului |
| `logout` | Sterge sesiunea salvata |
| `help` | Lista comenzilor din consola |
| `exit` | Inchide programul |

## Comenzi DM (prefix `$`)

Scrie `$help` in orice conversatie si primesti lista completa in acel chat.

Baza: `$help`, `$ping`, `$status`, `$uptime`

Reply automat: `$reply [user]`, `$stopreply [user]`, `$replydelay [sec]`, `$replylist`

Spam: `$spam [user] [text]`, `$stopspam`, `$spamdelay [sec]`

Mock si copy: `$mock [user]`, `$stopmock [user]`, `$copymsg [user]`, `$stopcopy [user]`

Imagini: `$vvlist`, `$vvclear`

Altele: `$afk [motiv]`, `$stopafk`, `$reverse`, `$stopreverse`, `$autolike [user]`,
`$stopautolike [user]`, `$mention [user]`, `$stopmention`, `$target [user]`, `$untarget`,
`$listtargets`, `$clearall`

Fraze: `$addnotepad`, `$addreply`, `$addbeef`, `$listphrases`

## Fisiere cu fraze

Pune in folderul botului, o fraza pe linie:

- `spam.txt` - frazele folosite de `$spam`
- `reply.txt` - frazele folosite de reply automat
- `beef.txt` - fraze suplimentare

## Ce s-a reparat fata de versiunea veche

- Loginul folosea endpointuri web nesustinute si `axios`, care nici macar nu era in `package.json`.
  Acum se foloseste `instagram-private-api`, cu suport real pentru 2FA si checkpoint.
- Sesiunea se salveaza complet (device + cookies), nu doar `sessionid`, deci reconectarea merge.
- Mesajele se trimiteau ca JSON cu antet `x-www-form-urlencoded`, deci esuau. Acum se trimit corect.
- Raspunsul la comenzi pleca intr-o conversatie noua. Acum merge in threadul din care vine comanda.
- Comenzile date de pe contul tau erau ignorate. Acum `$help` scris de tine functioneaza.
- Botul reprocesa mesajele vechi la fiecare ciclu. Acum tine evidenta mesajelor deja tratate.
- Toate emoji-urile au fost scoase din script si din output.

## Nota

Automatizarea Instagram poate duce la limitari sau blocarea contului.
Foloseste delay-uri mari si un cont pe care iti permiti sa il pierzi.
