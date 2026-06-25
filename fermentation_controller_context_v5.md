# Fermentation Controller — Context v5.0
*Zadnje ažuriranje: June 2026*

---

## Verzije
- **Firmware:** v5.0 (`fermentation_controller_v5.ino`)
- **Dashboard:** v5.0 (`index_v5.html`)
- **GitHub Pages:** https://mastermixxsb-max.github.io/fermentation-dashboard/
- **Firebase projekt:** `fermentationcontroller` (europe-west1)

---

## Hardware
> ⚠️ **DS18B20 mora biti u staklenki vode** — u zraku kasni, temperatura naglo skače, kompresor preradi. Staklenka vode = termička masa = stabilan odaziv.
- ESP32 Dev Module, COM3
- 2x DS18B20 (ferm + keezer)
- 2-relay modul (Low level trigger) — R1=Grijanje, R2=Keezer
- W25Q64 SPI Flash — **MRTAV, ignorirati** (sve na Firebase)
- OLED SSD1306 128x64
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

## Poznati problemi / TODO

### Firmware
- **Flash čip mrtav** — sve prebačeno na Firebase, flash kod ostaje ali neaktivan
- **`relay_log` ts** — stari zapisi imaju uptime (mali broj npr. 10707), ne unix timestamp
  - Fix napravljen u v5.0: `fb_log_relay()` koristi `time(nullptr)` umjesto `millis()/1000`
  - **Nije uploadano** jer je ESP32 u zatvorenoj kutiji (keezer), OTA upload potreban
- Flash kod čišćenje — ukloniti ~150 linija flash koda u v5.1

### Dashboard
- **Cycle log vremena** — stari ciklusi imaju uptime ts, dashboard rekonstruira pravo vrijeme
  koristeći `Date.now()` kao sidro i računa unazad. Nije savršeno ali radi.
- **Firebase REST API** — `limitToLast` uvijek treba `orderBy="$key"` inače 400 error!
- **Analitika period filter** — ne može filtrirati po Dan/Tjedan/Mjesec jer stari ciklusi
  nemaju pravi timestamp. Trenutno prikazuje sve cikluse bez filtera.
- **Log vremena** — Log tab koristi `Date.now()` pri učitavanju, ne pravi ts iz Firebase.
  Nakon firmware OTA uploada (time(nullptr) fix) sve će biti ispravno.

### Što radi ✅
- Live temperature (ferm + keezer)
- Relay kontrola (R1 grijanje, R2 keezer)
- Firebase sync settings
- Pushover notifikacije
- Graf s history filterima (30min in-memory, 1h/3h/6h/Sve iz Firebase /history)
- OLED widget simulacija (4 stranice, auto rotacija)
- Sparkline grafovi
- Log tab (čita iz Firebase /relay_log pri load)
- Analitika (ciklusi iz Firebase, trajanja u min/s, kWh računanje)
- OTA update
- PWA (Android Chrome)

---

## Važne napomene
- **Firebase REST API:** `limitToLast` treba `orderBy="$key"` — inače 400!
- **Relay modul:** Low level trigger — LOW=ON, HIGH=OFF
- **Relay terminali:** NC-COM-NO, spajati na COM i NO (ne NC!)
- **Service worker:** kešira agresivno — incognito tab za testiranje novih verzija
- **Async DS18B20:** `setWaitForConversion(false)`, zvati `read_temps()` svake 500ms
- **OTA upload:** radi bez otvaranja kutije
- **keezer_safe:** može se aktivirati ako je keezer bio na toplom — resetirati ručno u Firebase

---

## Sljedeće (v5.1)
1. OTA firmware upload (time(nullptr) fix za relay_log ts)
2. Čišćenje flash koda iz firmwarea (~150 linija)
3. Analitika period filter kad ts budu pravi unix timestamps
4. Log — prikazivati pravi ts iz Firebase umjesto Date.now()
5. Graf X-os oznake (trenutno prikazuje samo točke)
