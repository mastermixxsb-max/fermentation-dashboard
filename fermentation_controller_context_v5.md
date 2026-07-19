# Fermentation Controller — Context v5.3
*Zadnje ažuriranje: 19.07.2026*

---

## Verzije
- **Firmware:** v5.3 (`fermentation_controller_v5.ino`) — `FW_VERSION "v5.3"`
- **Dashboard:** v5.3 (`index.html`)
- **GitHub Pages:** https://mastermixxsb-max.github.io/fermentation-dashboard/
- **Firebase projekt:** `fermentationcontroller` (europe-west1)

---

## Hardware
> ⚠️ **DS18B20 mora biti u staklenki vode** — u zraku kasni, temperatura naglo skače, kompresor preradi. Staklenka vode = termička masa = stabilan odaziv.
- ESP32 Dev Module, COM3
- 2x DS18B20 (ferm + keezer) — indeksi immutable: ferm=0, keezer=1
- 2-relay modul (Low level trigger) — R1=Grijanje, R2=Keezer — LOW=ON, HIGH=OFF
- Relay terminali: NC-COM-NO, spajati na COM i NO (ne NC!)
- W25Q64 SPI Flash — **MRTAV, ignorirati** (sve na Firebase); MISO/MOSI su bili zamijenjeni, sad fixano ali flash se ionako ne koristi
- OLED SSD1306 128x64 — redesign u v5.3: status bar, alarm stranica, boot sekvenca
- WiFi: SmartHome, IP 192.168.1.15

---

## Firebase struktura
```
/sensors        — live temp, relay, heartbeat (svake 5s)
/settings       — postavke (ferm_sp, keezer_sp, hysteresis, itd.)
/relays         — relay stanje, ferm_cal, keezer_cal, alarm, keezer_safe
/debug          — heap, rssi, flash:false, obs (svake 5min)
/relay_log      — relay eventi, format: {ts, relay, state, r1, r2}
/history        — temp log svake minute, format: {ts, f, k, r1, r2}
/batch          — aktivna serija (Pale Ale - Simco)
/ferm_history   — završene fermentacije
/command        — remote restart
/config         — Pushover tokeni (po_token, po_user)
```

---

## Firmware promjene v5.1 → v5.3
- **v5.1:** WiFi notifikacije — debounce 5min, cooldown 10min
- **v5.2:** Freeze protection — hard cutoff ispod 1°C, Pushover alarm priority 2
- **v5.3:** OLED redesign (status bar, alarm stranica, boot sekvenca); fix ferm alarm da se javlja samo kad je `ferm_session_active`
- **17.07.2026:** Alarm za previsoku keezer temperaturu — Pushover + prikaz na OLED widgetu

## Dashboard promjene (post v5.0 dokumentacija)
- **Sync Monitor panel** — vizualni prikaz stanja sinkronizacije bez tehničkih izraza, za lakše praćenje bez čitanja logova
- **KRITIČNI FIX (30.06.2026):** svaki Firebase fetch (`/history`, `/relay_log`) sada koristi `limitToLast` — prije fixa je znalo povući cijelu bazu (2.59GB download bug)
- **Graf periodni filteri** — dodano 1 dan / Tjedan / Mjesec (uz postojeće 30min/1h/3h/6h/Sve)
- **Sparkline redesign** — X-os vrijeme, SP linija ucrtana, Y-os auto-zoom (min 0.1°C), visina 64px, učitava zadnjih 30min iz `/history` pri initu

---

## Poznati problemi / TODO (naslijeđeno iz v5.0, provjeriti status prije v6.0 rada)

### Firmware
- **Flash čip mrtav** — sve na Firebase, flash kod ostaje u kodu ali neaktivan; čišćenje (~150 linija) još NIJE napravljeno
- **`relay_log` ts fix** — `fb_log_relay()` treba koristiti `time(nullptr)` umjesto `millis()/1000` za prave unix timestampove na starim uređajima koji nisu dobili OTA update s ovim fixom — provjeriti je li OTA upload ovog fixa napravljen (fix je bio spreman u v5.0/v5.1, ali status uploada nepoznat iz ovog konteksta)

### Dashboard
- **Cycle log vremena** — stari ciklusi s uptime ts-om i dalje rekonstruirani preko `Date.now()` sidra unatrag — nije savršeno
- **Analitika period filter** — stari ciklusi bez pravog timestampa i dalje ne mogu biti filtrirani po Dan/Tjedan/Mjesec (radi tek za nove zapise nakon ts fixa)
- **Log tab** — provjeriti koristi li još `Date.now()` pri učitavanju umjesto pravog ts iz Firebase

### Što radi ✅ (potvrđeno iz koda, 19.07.2026)
- Live temperature (ferm + keezer)
- Relay kontrola (R1 grijanje, R2 keezer)
- Firebase sync settings
- Pushover notifikacije (uklj. freeze i keezer high-temp alarm)
- Sync Monitor panel
- Graf s filterima: 30min/1h/3h/6h/Sve + Dan/Tjedan/Mjesec
- Sparkline (X-os, SP linija, auto-zoom, 30min init)
- OLED widget (redesign v5.3, status bar, alarm stranica, boot sekvenca)
- Log tab (čita iz `/relay_log`)
- Analitika (ciklusi, trajanje, kWh)
- OTA update
- PWA (Android Chrome)

---

## Važne napomene
- **Firebase REST API:** `limitToLast` treba `orderBy="$key"` — inače 400!
- **Relay modul:** Low level trigger — LOW=ON, HIGH=OFF
- **Service worker:** kešira agresivno — incognito tab za testiranje novih verzija
- **Async DS18B20:** `setWaitForConversion(false)`, zvati `read_temps()` svake 500ms
- **OTA upload:** radi bez otvaranja kutije (koristi se za v5.3 upload)
- **keezer_safe:** može se aktivirati ako je keezer bio na toplom — resetirati ručno u Firebase

---

## Sljedeće (v6.0 — kandidati, treba potvrditi prioritet s Tomislavom)
1. Potvrditi status `time(nullptr)` fixa nakon v5.3 OTA uploada (upravo u tijeku)
2. Čišćenje flash koda iz firmwarea (~150 linija) — mrtav kod, W25Q64 se ne koristi
3. Analitika period filter — pun rad tek kad svi novi zapisi imaju pravi unix ts
4. Log tab — koristiti pravi ts iz Firebase umjesto `Date.now()`
5. Graf X-os oznake preciznije (ako još nije riješeno u v5.3 sparkline radu)
