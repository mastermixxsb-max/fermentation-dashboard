// ============================================================
//  Fermentation + Keezer Controller v5.0
//  Novo: Flash JEDEC retry+fallback, async DS18B20, OLED str.4,
//        ferm_cal/keezer_cal Firebase sync
//  ESP32 + DS18B20 + W25Q64 SPI Flash + Firebase + OTA
// ============================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <ArduinoOTA.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <SPI.h>
#include <time.h>

// ── Pin definicije ────────────────────────────────────────────
#define PIN_DS18B20   4
#define PIN_BOOT      0
#define PIN_RELAY1   16
#define PIN_RELAY2   17
#define PIN_FLASH_CS  5
#define OLED_SDA     21
#define OLED_SCL     22

// ── Flash komande ─────────────────────────────────────────────
#define FLASH_WRITE_ENABLE  0x06
#define FLASH_READ_STATUS   0x05
#define FLASH_PAGE_PROGRAM  0x02
#define FLASH_READ_DATA     0x03
#define FLASH_SECTOR_ERASE  0x20
#define FLASH_JEDEC_ID      0x9F
#define FLASH_RELEASE_PD    0xAB

// ── Flash layout ──────────────────────────────────────────────
#define FLASH_ADDR_SETTINGS   0x000000
#define FLASH_ADDR_TEMP_LOG   0x001000
#define FLASH_ADDR_RELAY_LOG  0x029000
#define FLASH_ADDR_FERM_HIST  0x03D000
#define FLASH_ADDR_KSTAT      0x051000

#define TEMP_LOG_SIZE    16
#define RELAY_LOG_SIZE   12
#define FERM_REC_SIZE   128
#define KSTAT_SIZE       24

#define MAX_TEMP_RECS   (40*4096/TEMP_LOG_SIZE)
#define MAX_RELAY_RECS  (20*4096/RELAY_LOG_SIZE)
#define MAX_FERM_RECS   (20*4096/FERM_REC_SIZE)

// ── Firebase ──────────────────────────────────────────────────
const char* FB_HOST = "fermentationcontroller-default-rtdb.europe-west1.firebasedatabase.app";

// ── Strukture ─────────────────────────────────────────────────
struct Settings {
  uint32_t magic;
  float ferm_sp, ferm_hy, ferm_al, ferm_cal;
  bool  ferm_en, ferm_heat;
  float keezer_sp, keezer_hy, keezer_al, keezer_cal;
  bool  keezer_en;
  float comp_delay_min, safe_limit;
  uint8_t pad[30];
};

struct TempRecord {
  uint32_t ts;
  float    ferm_temp, keezer_temp;
  uint8_t  r1, r2, ferm_ok, keezer_ok;
};

struct FermRecord {
  uint32_t ts_start, ts_end;
  float    avg_temp, min_temp, max_temp, sp_used;
  uint32_t duration_sec;
  char     name[32], style[32];
  uint8_t  pad[16];
};

struct KeezerStat {
  uint32_t day_ts, on_sec;
  uint16_t cycles;
  float    kwh;
  uint8_t  pad[10];
};

// ── Globalne varijable ────────────────────────────────────────
Settings cfg;
float    ferm_temp = 0.0, keezer_temp = 0.0;
bool     ferm_ok = false, keezer_ok = false;
bool     r1_state = false, r2_state = false;
bool     wifi_ok = false, flash_ok = false;

uint32_t temp_log_head = 0, relay_log_head = 0;
uint32_t ferm_rec_count = 0, kstat_head = 0;

unsigned long last_temp_read = 0, last_fb_send = 0;
unsigned long last_flash_log = 0, last_oled_update = 0;
unsigned long comp_off_ts = 0, keezer_on_ts = 0;

uint32_t today_on_sec = 0;
uint16_t today_cycles = 0;
uint32_t today_start_ts = 0;

bool     obs_mode = false;
bool     ferm_session_active = false;
uint32_t ferm_session_start = 0;
float    ferm_sum_temp = 0;
uint32_t ferm_sample_count = 0;
float    ferm_min_temp = 999, ferm_max_temp = -999;
char     ferm_name[32] = "", ferm_style[32] = "";

// OLED — boot_done flag sprječava boot screen nakon boota
bool boot_done = false;
uint8_t oled_page = 0;
unsigned long last_page_switch = 0;

OneWire           oneWire(PIN_DS18B20);
DallasTemperature sensors(&oneWire);
DeviceAddress     addr_ferm, addr_keezer;
Adafruit_SSD1306  display(128, 64, &Wire, -1);

// ── Flash funkcije ────────────────────────────────────────────
void flash_cs_low()  { digitalWrite(PIN_FLASH_CS, LOW); }
void flash_cs_high() { digitalWrite(PIN_FLASH_CS, HIGH); }

void flash_wait_busy() {
  flash_cs_low();
  SPI.transfer(FLASH_READ_STATUS);
  while (SPI.transfer(0) & 0x01) delay(1);
  flash_cs_high();
}

bool flash_init() {
  pinMode(PIN_FLASH_CS, OUTPUT);
  flash_cs_high();
  SPI.begin(18, 19, 23, PIN_FLASH_CS);
  SPI.setFrequency(10000000);

  // Power-up: Release from Deep Power-Down
  flash_cs_low(); SPI.transfer(FLASH_RELEASE_PD); flash_cs_high();
  delay(10); // W25Q64 treba min 3us, dajemo 10ms sigurnosti

  // JEDEC ID — do 3 pokušaja (rješava 00 00 00 problem)
  uint8_t mfr = 0, mt = 0, cap = 0;
  for (int attempt = 0; attempt < 3; attempt++) {
    flash_cs_low();
    SPI.transfer(FLASH_JEDEC_ID);
    mfr = SPI.transfer(0);
    mt  = SPI.transfer(0);
    cap = SPI.transfer(0);
    flash_cs_high();
    Serial.printf("[FLASH] JEDEC pokusaj %d: %02X %02X %02X\n", attempt+1, mfr, mt, cap);
    if (mfr != 0x00 && mfr != 0xFF) break; // Validan odgovor
    delay(20);
  }

  // Provjera poznatih čipova (Winbond W25Q64 = EF 40 17, EON EN25Q64 = 1C 30 17, GigaDevice = C8 40 17)
  bool known_mfr = (mfr == 0xEF || mfr == 0x1C || mfr == 0xC8 || mfr == 0x20 || mfr == 0x01);
  bool known_cap = (cap == 0x17 || cap == 0x16 || cap == 0x18); // 64Mb, 32Mb, 128Mb

  Serial.printf("[FLASH] Manufacturer: %s\n",
    mfr==0xEF?"Winbond":mfr==0x1C?"EON":mfr==0xC8?"GigaDevice":
    mfr==0x20?"Micron":mfr==0x01?"Spansion":"Unknown");
  Serial.printf("[FLASH] Kapacitet: %s\n",
    cap==0x17?"64Mb (W25Q64)":cap==0x16?"32Mb":cap==0x18?"128Mb":"Nepoznat");

  if (mfr == 0x00 && cap == 0x00) {
    Serial.println("[FLASH] GREŠKA: JEDEC vraca 00 — provjeri SPI wiring (CS/MISO/MOSI/CLK)!");
    return false;
  }
  if (mfr == 0xFF && cap == 0xFF) {
    Serial.println("[FLASH] GREŠKA: JEDEC vraca FF — čip nije spojen ili CS floating!");
    return false;
  }
  if (!known_mfr) {
    Serial.printf("[FLASH] UPOZORENJE: Nepoznat manufacturer %02X, nastavaljam s opreznošću\n", mfr);
  }
  if (!known_cap) {
    Serial.printf("[FLASH] UPOZORENJE: Nepoznat kapacitet %02X, pretpostavljam 64Mb\n", cap);
  }

  Serial.println("[FLASH] Init OK!");
  return true;
}

void flash_write_enable() {
  flash_cs_low(); SPI.transfer(FLASH_WRITE_ENABLE); flash_cs_high();
}

void flash_sector_erase(uint32_t addr) {
  flash_write_enable();
  flash_cs_low();
  SPI.transfer(FLASH_SECTOR_ERASE);
  SPI.transfer((addr>>16)&0xFF); SPI.transfer((addr>>8)&0xFF); SPI.transfer(addr&0xFF);
  flash_cs_high();
  flash_wait_busy();
}

void flash_write_page(uint32_t addr, uint8_t* buf, uint16_t len) {
  flash_write_enable();
  flash_cs_low();
  SPI.transfer(FLASH_PAGE_PROGRAM);
  SPI.transfer((addr>>16)&0xFF); SPI.transfer((addr>>8)&0xFF); SPI.transfer(addr&0xFF);
  for (uint16_t i = 0; i < len; i++) SPI.transfer(buf[i]);
  flash_cs_high();
  flash_wait_busy();
}

void flash_read(uint32_t addr, uint8_t* buf, uint16_t len) {
  flash_cs_low();
  SPI.transfer(FLASH_READ_DATA);
  SPI.transfer((addr>>16)&0xFF); SPI.transfer((addr>>8)&0xFF); SPI.transfer(addr&0xFF);
  for (uint16_t i = 0; i < len; i++) buf[i] = SPI.transfer(0);
  flash_cs_high();
}

void flash_write_struct(uint32_t base, uint32_t idx, uint16_t sz, void* data) {
  uint32_t addr = base + idx * sz;
  if ((addr % 4096) == 0) flash_sector_erase(addr);
  flash_write_page(addr, (uint8_t*)data, sz);
}

// ── Settings na flash ─────────────────────────────────────────
void settings_save() {
  cfg.magic = 0xFEED1234;
  flash_sector_erase(FLASH_ADDR_SETTINGS);
  flash_write_page(FLASH_ADDR_SETTINGS, (uint8_t*)&cfg, sizeof(cfg));
  Serial.println("[FLASH] Settings saved");
}

void settings_load() {
  flash_read(FLASH_ADDR_SETTINGS, (uint8_t*)&cfg, sizeof(cfg));
  if (cfg.magic != 0xFEED1234) {
    Serial.println("[FLASH] No settings, using defaults");
    cfg.ferm_sp = 18.0; cfg.ferm_hy = 0.5; cfg.ferm_al = 2.0; cfg.ferm_cal = 0.0;
    cfg.ferm_en = true; cfg.ferm_heat = true;
    cfg.keezer_sp = 5.0; cfg.keezer_hy = 0.3; cfg.keezer_al = 2.0; cfg.keezer_cal = 0.0;
    cfg.keezer_en = true; cfg.comp_delay_min = 3.0; cfg.safe_limit = 5.0;
    settings_save();
  } else {
    Serial.println("[FLASH] Settings loaded OK");
  }
}

// ── Flash log temp ────────────────────────────────────────────
void flash_log_temp() {
  if (!flash_ok) return;
  TempRecord rec;
  rec.ts = (uint32_t)(millis()/1000);
  rec.ferm_temp = ferm_temp; rec.keezer_temp = keezer_temp;
  rec.r1 = r1_state?1:0; rec.r2 = r2_state?1:0;
  rec.ferm_ok = ferm_ok?1:0; rec.keezer_ok = keezer_ok?1:0;
  flash_write_struct(FLASH_ADDR_TEMP_LOG, temp_log_head % MAX_TEMP_RECS, TEMP_LOG_SIZE, &rec);
  temp_log_head++;
  Serial.printf("[FLASH] Temp log #%u\n", temp_log_head);
}

// ── Flash relay log ───────────────────────────────────────────
void flash_log_relay(uint8_t relay, bool state) {
  if (!flash_ok) return;
  uint8_t buf[RELAY_LOG_SIZE] = {0};
  uint32_t ts = (uint32_t)(millis()/1000);
  memcpy(buf, &ts, 4); buf[4] = relay; buf[5] = state?1:0;
  flash_write_struct(FLASH_ADDR_RELAY_LOG, relay_log_head % MAX_RELAY_RECS, RELAY_LOG_SIZE, buf);
  relay_log_head++;
}

// ── Keezer statistika ─────────────────────────────────────────
void keezer_stat_save() {
  KeezerStat stat;
  stat.day_ts = today_start_ts; stat.on_sec = today_on_sec;
  stat.cycles = today_cycles; stat.kwh = (today_on_sec/3600.0)*0.075;
  memset(stat.pad, 0, sizeof(stat.pad));
  flash_write_struct(FLASH_ADDR_KSTAT, kstat_head%(20*4096/KSTAT_SIZE), KSTAT_SIZE, &stat);
  kstat_head++;
  Serial.printf("[KEEZER] Stat: %us, %u cycles, %.3f kWh\n", today_on_sec, today_cycles, stat.kwh);
  today_on_sec = 0; today_cycles = 0; today_start_ts = millis()/1000;
}

// ── Fermentacija sesija ───────────────────────────────────────
void ferm_session_start_fn(const char* name, const char* style, float sp) {
  ferm_session_active = true; ferm_session_start = millis()/1000;
  ferm_sum_temp = 0; ferm_sample_count = 0;
  ferm_min_temp = 999; ferm_max_temp = -999;
  strncpy(ferm_name, name, 31); strncpy(ferm_style, style, 31);
  Serial.printf("[FERM] Session started: %s (%s)\n", name, style);
}

void ferm_session_stop_fn() {
  if (!ferm_session_active) return;
  FermRecord rec;
  rec.ts_start = ferm_session_start; rec.ts_end = millis()/1000;
  rec.avg_temp = ferm_sample_count>0 ? ferm_sum_temp/ferm_sample_count : 0;
  rec.min_temp = ferm_min_temp; rec.max_temp = ferm_max_temp;
  rec.sp_used = cfg.ferm_sp; rec.duration_sec = rec.ts_end-rec.ts_start;
  strncpy(rec.name, ferm_name, 31); strncpy(rec.style, ferm_style, 31);
  memset(rec.pad, 0, sizeof(rec.pad));
  if (flash_ok) {
    uint32_t addr = FLASH_ADDR_FERM_HIST + (ferm_rec_count%MAX_FERM_RECS)*FERM_REC_SIZE;
    if ((addr%4096)==0) flash_sector_erase(addr);
    flash_write_page(addr, (uint8_t*)&rec, sizeof(rec));
    ferm_rec_count++;
  }
  ferm_session_active = false;
  Serial.printf("[FERM] Session saved: %s, %.1fh\n", rec.name, rec.duration_sec/3600.0);
}

// ── Firebase ──────────────────────────────────────────────────
String fb_get(const char* path) {
  if (!wifi_ok) return "";
  ArduinoOTA.handle(); // OTA prozor prije HTTP
  HTTPClient http;
  String url = "https://" + String(FB_HOST) + String(path) + ".json";
  http.begin(url);
  http.setTimeout(3000); // Smanjeno s 8000 — ne blokiraj OTA predugo
  int code = http.GET();
  String resp = (code==200) ? http.getString() : "";
  http.end();
  ArduinoOTA.handle(); // OTA prozor nakon HTTP
  return resp;
}

void fb_put(const char* path, String body) {
  if (!wifi_ok) return;
  ArduinoOTA.handle(); // OTA prozor prije HTTP
  HTTPClient http;
  String url = "https://" + String(FB_HOST) + String(path) + ".json";
  http.begin(url);
  http.setTimeout(3000);
  http.addHeader("Content-Type", "application/json");
  http.PUT(body);
  http.end();
  ArduinoOTA.handle(); // OTA prozor nakon HTTP
}

// ── Firebase relay log (svaki event) ─────────────────────────
void fb_log_relay(uint8_t relay, bool state) {
  if (!wifi_ok) return;
  unsigned long ts = (unsigned long)time(nullptr); // unix timestamp
  String path = "/relay_log/" + String(ts) + "_r" + String(relay);
  String body = "{\"ts\":" + String(ts) +
                ",\"relay\":" + String(relay) +
                ",\"state\":" + String(state?"true":"false") +
                ",\"r1\":" + String(r1_state?"true":"false") +
                ",\"r2\":" + String(r2_state?"true":"false") + "}";
  fb_put(path.c_str(), body);
}

void fb_send_sensors() {
  String ft = ferm_ok   ? String(ferm_temp+cfg.ferm_cal, 2)   : "null";
  String kt = keezer_ok ? String(keezer_temp+cfg.keezer_cal, 2) : "null";
  String body = "{\"ferm_temp\":" + ft +
                ",\"keezer_temp\":" + kt +
                ",\"ferm_ok\":" + String(ferm_ok?"true":"false") +
                ",\"keezer_ok\":" + String(keezer_ok?"true":"false") +
                ",\"ferm_cal\":" + String(cfg.ferm_cal, 1) +
                ",\"keezer_cal\":" + String(cfg.keezer_cal, 1) +
                ",\"r1\":" + String(r1_state?"true":"false") +
                ",\"r2\":" + String(r2_state?"true":"false") +
                ",\"uptime\":" + String(millis()/1000) +
                ",\"ip\":\"" + WiFi.localIP().toString() + "\"" +
                ",\"heartbeat\":" + String((unsigned long)time(nullptr)) + "}";
  fb_put("/sensors", body);
}

void fb_read_relays() {
  String resp = fb_get("/relays");
  if (resp.length() < 5 || resp == "null") return;

  bool new_r1 = resp.indexOf("\"r1\":true") >= 0;
  bool new_r2 = resp.indexOf("\"r2\":true") >= 0;

  // Obs mode — blokiraj R2
  if (obs_mode) new_r2 = false;

  if (new_r1 != r1_state) {
    r1_state = new_r1;
    digitalWrite(PIN_RELAY1, r1_state ? LOW : HIGH);
    flash_log_relay(1, r1_state);
    fb_log_relay(1, r1_state);
  }

  if (new_r2 != r2_state) {
    unsigned long delay_ms = (unsigned long)(cfg.comp_delay_min * 60000);
    if (!new_r2) {
      if (r2_state && keezer_on_ts > 0) {
        today_on_sec += (millis()-keezer_on_ts)/1000;
        today_cycles++;
        keezer_on_ts = 0;
        comp_off_ts = millis();
      }
    } else {
      if (comp_off_ts > 0 && (millis()-comp_off_ts) < delay_ms) return;
      keezer_on_ts = millis();
    }
    r2_state = new_r2;
    digitalWrite(PIN_RELAY2, r2_state ? LOW : HIGH);
    flash_log_relay(2, r2_state);
    fb_log_relay(2, r2_state);
  }
}

void fb_sync_settings() {
  String resp = fb_get("/settings");
  if (resp.length() < 5 || resp == "null") return;

  auto extractFloat = [&](const char* key) -> float {
    String k = "\"" + String(key) + "\":";
    int idx = resp.indexOf(k); if (idx<0) return -9999;
    idx += k.length();
    return resp.substring(idx, resp.indexOf(',', idx)).toFloat();
  };
  auto extractBool = [&](const char* key) -> int {
    String k = "\"" + String(key) + "\":";
    int idx = resp.indexOf(k); if (idx<0) return -1;
    idx += k.length();
    return resp.substring(idx, idx+5).startsWith("true") ? 1 : 0;
  };

  bool changed = false;
  float v;
  #define UF(field, key) v=extractFloat(key); if(v>-999 && v!=cfg.field){cfg.field=v;changed=true;}
  UF(ferm_sp,"ferm_sp") UF(ferm_hy,"ferm_hy") UF(ferm_al,"ferm_al")
  UF(ferm_cal,"ferm_cal")
  UF(keezer_sp,"keezer_sp") UF(keezer_hy,"keezer_hy") UF(keezer_al,"keezer_al")
  UF(keezer_cal,"keezer_cal")
  UF(comp_delay_min,"compDelay") UF(safe_limit,"safeLimit")
  int b;
  b=extractBool("ferm_en");   if(b>=0&&(bool)b!=cfg.ferm_en)  {cfg.ferm_en=(bool)b;  changed=true;}
  b=extractBool("ferm_heat"); if(b>=0&&(bool)b!=cfg.ferm_heat){cfg.ferm_heat=(bool)b;changed=true;}
  b=extractBool("keezer_en"); if(b>=0&&(bool)b!=cfg.keezer_en){cfg.keezer_en=(bool)b;changed=true;}

  // Obs mode
  b=extractBool("obsMode");
  if(b>=0) obs_mode=(bool)b;

  if (changed) { settings_save(); Serial.println("[FB] Settings synced"); }

  // Batch/ferm sesija
  String batch = fb_get("/batch");
  if (batch.length()>5 && batch!="null" && !ferm_session_active) {
    int ni = batch.indexOf("\"name\":\"");
    if (ni>=0) {
      ni+=8; int ne=batch.indexOf("\"",ni);
      String bn=batch.substring(ni,ne); bn.toCharArray(ferm_name,32);
      ferm_session_start_fn(ferm_name,"",cfg.ferm_sp);
    }
  } else if ((batch=="null"||batch.length()<5) && ferm_session_active) {
    ferm_session_stop_fn();
  }
}

void read_temps() {
  sensors.requestTemperatures();
  delay(750);
  float t0 = sensors.getTempC(addr_ferm);
  float t1 = sensors.getTempC(addr_keezer);
  ferm_ok   = (t0 > -50 && t0 < 85);
  keezer_ok = (t1 > -50 && t1 < 85);
  if (ferm_ok)   ferm_temp   = t0;
  if (keezer_ok) keezer_temp = t1;
  if (ferm_session_active && ferm_ok) {
    ferm_sum_temp += ferm_temp + cfg.ferm_cal;
    ferm_sample_count++;
    if (ferm_temp < ferm_min_temp) ferm_min_temp = ferm_temp;
    if (ferm_temp > ferm_max_temp) ferm_max_temp = ferm_temp;
  }
}

// ── OLED ─────────────────────────────────────────────────────
void oled_update() {
  // Ne prikazuj boot screen nakon što je boot završen
  if (!boot_done) return;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // Rotacija stranica svake 4s
  if (millis()-last_page_switch > 4000) {
    oled_page = (oled_page+1)%4;
    last_page_switch = millis();
  }

  if (oled_page == 0) {
    // Stranica 1: Status + Temperature (originalni layout, veće temp)
    display.setTextSize(1);
    display.setCursor(0,0);
    display.print(wifi_ok ? "WiFi OK" : "WiFi --");
    display.setCursor(72,0);
    display.println(flash_ok ? "FL:OK" : "FL:ERR");
    // Temperatura Ferm — textSize 3 (najveći)
    display.setTextSize(2);
    display.setCursor(0,14);
    if (ferm_ok) {
      display.print("F:");
      display.setTextSize(3);
      display.print(String(ferm_temp+cfg.ferm_cal, 1));
    } else {
      display.print("F: ERR");
    }
    // Temperatura Keezer
    display.setTextSize(2);
    display.setCursor(0,40);
    if (keezer_ok) {
      display.print("K:");
      display.setTextSize(3);
      display.print(String(keezer_temp+cfg.keezer_cal, 1));
    } else {
      display.print("K: ERR");
    }

  } else if (oled_page == 1) {
    // Stranica 2: Relay status + SP
    display.setTextSize(1);
    display.setCursor(0,0);
    if (wifi_ok) display.print(WiFi.localIP().toString());
    else display.print("WiFi --");
    display.setCursor(0,10); display.printf("R1:%s SP:%.1f", r1_state?"ON ":"OFF", cfg.ferm_sp);
    display.setCursor(0,20); display.printf("R2:%s SP:%.1f", r2_state?"ON ":"OFF", cfg.keezer_sp);
    display.setCursor(0,32); display.printf("Mod: %s", cfg.ferm_heat?"GRIJANJE":"HLADENJE");
    display.setCursor(0,44);
    if (ferm_session_active) display.printf("Ferm: %.12s", ferm_name);
    else display.print("Ferm: neaktivna");

  } else if (oled_page == 2) {
    // Stranica 3: Flash stats / OBS mod
    display.setTextSize(1);
    display.setCursor(0,0);  display.println("FLASH STATS");
    display.setCursor(0,12); display.printf("Temp log: %u", temp_log_head);
    display.setCursor(0,24); display.printf("Relay log: %u", relay_log_head);
    display.setCursor(0,36); display.printf("Ferm hist: %u", ferm_rec_count);
    display.setCursor(0,48);
    if (obs_mode) {
      display.println("OBS MOD AKTIVAN");
    } else {
      display.printf("Heap: %u B", ESP.getFreeHeap());
    }

  } else {
    // Stranica 4: Keezer dnevna statistika
    display.setTextSize(1);
    display.setCursor(0,0);  display.println("KEEZER STAT");
    display.setCursor(0,12); display.printf("ON danas: %uh %um",
      today_on_sec/3600, (today_on_sec%3600)/60);
    display.setCursor(0,24); display.printf("Ciklusi: %u", today_cycles);
    display.setCursor(0,36); display.printf("kWh: %.3f", (today_on_sec/3600.0)*0.075);
    display.setCursor(0,48);
    if (keezer_on_ts > 0) {
      uint32_t run_sec = (millis()-keezer_on_ts)/1000;
      display.printf("Radi: %um %us", run_sec/60, run_sec%60);
    } else {
      display.print("Kompresor: OFF");
    }
  }

  display.display();
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n[BOOT] Fermentation Controller v5.0");

  // Relaji — active LOW
  pinMode(PIN_RELAY1, OUTPUT); digitalWrite(PIN_RELAY1, HIGH);
  pinMode(PIN_RELAY2, OUTPUT); digitalWrite(PIN_RELAY2, HIGH);

  // OLED boot screen
  Wire.begin(OLED_SDA, OLED_SCL);
  if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    display.clearDisplay();
    display.setTextSize(1); display.setTextColor(SSD1306_WHITE);
    display.setCursor(0,0); display.println("FermCtrl v5.0");
    display.println("Bootam...");
    display.display();
  }

  // Flash
  flash_ok = flash_init();
  if (flash_ok) { Serial.println("[FLASH] W25Q64 OK!"); settings_load(); }
  else Serial.println("[FLASH] W25Q64 GREŠKA!");

  // DS18B20
  sensors.begin();
  uint8_t cnt = sensors.getDeviceCount();
  Serial.printf("[DS18B20] %u sonda/i\n", cnt);
  if (cnt>=1) sensors.getAddress(addr_ferm, 0);
  if (cnt>=2) sensors.getAddress(addr_keezer, 1);
  Serial.printf("[DS18B20] Ferm addr: %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X\n", addr_ferm[0],addr_ferm[1],addr_ferm[2],addr_ferm[3],addr_ferm[4],addr_ferm[5],addr_ferm[6],addr_ferm[7]);
  Serial.printf("[DS18B20] Keezer addr: %02X:%02X:%02X:%02X:%02X:%02X:%02X:%02X\n", addr_keezer[0],addr_keezer[1],addr_keezer[2],addr_keezer[3],addr_keezer[4],addr_keezer[5],addr_keezer[6],addr_keezer[7]);
  sensors.setResolution(12);

  // BOOT tipka — drži 3s za WiFi reset
  pinMode(PIN_BOOT, INPUT_PULLUP);
  delay(200);
  if (digitalRead(PIN_BOOT) == LOW) {
    unsigned long bp = millis();
    Serial.println("[BOOT] BOOT tipka, cekam 3s...");
    while (digitalRead(PIN_BOOT) == LOW) {
      if (millis()-bp > 3000) {
        display.clearDisplay(); display.setCursor(0,0);
        display.println("WiFi RESET!"); display.println("Cekaj..."); display.display();
        WiFiManager wm_tmp; wm_tmp.resetSettings();
        delay(1000); ESP.restart();
      }
      delay(50);
    }
  }

  // WiFi — proba poznate mreže
  display.setCursor(0,20); display.println("WiFi spajam.."); display.display();

  const char* known_ssids[] = {"SmartHome", "Dvoriste", "Dvoriste_EXT"};
  const char* known_pass    = "qHx1erkt";
  bool manual_connected = false;
  for (int i = 0; i < 3; i++) {
    Serial.printf("[WiFi] Pokusavam: %s\n", known_ssids[i]);
    WiFi.begin(known_ssids[i], known_pass);
    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 10) { delay(500); tries++; }
    if (WiFi.status() == WL_CONNECTED) {
      manual_connected = true;
      Serial.printf("[WiFi] Spojen na: %s\n", known_ssids[i]);
      break;
    }
    WiFi.disconnect(); delay(200);
  }

  WiFiManager wm;
  wm.setConfigPortalTimeout(120);
  if (manual_connected) wifi_ok = true;
  else wifi_ok = wm.autoConnect("FermCtrl-Setup");

  if (wifi_ok) {
    Serial.printf("[WiFi] Spojen: %s\n", WiFi.localIP().toString().c_str());
    configTime(3600, 3600, "pool.ntp.org");
    delay(1000);
    fb_sync_settings();
  } else {
    Serial.println("[WiFi] Offline mod");
  }

  // OTA
  ArduinoOTA.setHostname("fermentation-ctrl");
  // Lozinka maknuta — ako treba dodati nazad: ArduinoOTA.setPassword("ferm2024");
  ArduinoOTA.onStart([]() { 
    Serial.println("[OTA] Start upload...");
    display.clearDisplay(); display.setCursor(0,0);
    display.println("OTA UPDATE"); display.println("Ne gasi!"); display.display();
  });
  ArduinoOTA.onEnd([]() { 
    Serial.println("[OTA] Gotovo! Restart...");
    display.clearDisplay(); display.setCursor(0,0);
    display.println("OTA GOTOVO!"); display.println("Restartujem..."); display.display();
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("[OTA] %u%%\n", progress*100/total);
  });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("[OTA] Greška: %u\n", error);
  });
  ArduinoOTA.begin();

  today_start_ts = millis()/1000;
  last_page_switch = millis();

  // Boot OK screen — 2 sekunde pa normalni rad
  display.clearDisplay(); display.setCursor(0,0);
  display.println("Boot OK!");
  display.printf("WiFi: %s\n", wifi_ok?"OK":"Offline");
  display.printf("Flash: %s\n", flash_ok?"OK":"ERR");
  display.display();
  delay(2000);

  // BOOT DONE — od sada oled_update() prikazuje normalne stranice
  boot_done = true;
  last_oled_update = 0;
  last_page_switch = millis();

  Serial.println("[BOOT] Setup gotov! v5.0");
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
  ArduinoOTA.handle();

  unsigned long now = millis();

  // Temperature svake 3s
  if (now - last_temp_read > 3000) {
    read_temps();
    last_temp_read = now;
  }

  // ── Lokalna relay logika (radi i bez WiFi/Firebase) ──────────
  if (ferm_ok && cfg.ferm_en) {
    bool should_r1;
    if (cfg.ferm_heat) {
      should_r1 = (ferm_temp + cfg.ferm_cal) < (cfg.ferm_sp - cfg.ferm_hy) ? true :
                  (ferm_temp + cfg.ferm_cal) >= cfg.ferm_sp ? false : r1_state;
    } else {
      should_r1 = (ferm_temp + cfg.ferm_cal) > (cfg.ferm_sp + cfg.ferm_hy) ? true :
                  (ferm_temp + cfg.ferm_cal) <= cfg.ferm_sp ? false : r1_state;
    }
    if (should_r1 != r1_state) {
      r1_state = should_r1;
      digitalWrite(PIN_RELAY1, r1_state ? LOW : HIGH);
      fb_log_relay(1, r1_state);
    }
  }

  if (keezer_ok && cfg.keezer_en && !obs_mode) {
    float kt = keezer_temp + cfg.keezer_cal;
    // Safe limit — ako temp padne prenisko, blokiraj kompresor
    bool safe = (kt > (cfg.keezer_sp - cfg.safe_limit));
    bool should_r2;
    if (!safe) {
      should_r2 = false; // Blokiraj — prenisko
      if (r2_state) Serial.printf("[KEEZER] Safe limit! %.1f < %.1f\n", kt, cfg.keezer_sp - cfg.safe_limit);
    } else {
      should_r2 = kt > (cfg.keezer_sp + cfg.keezer_hy) ? true :
                  kt <= cfg.keezer_sp ? false : r2_state;
    }
    // Kompresor delay zaštita
    unsigned long delay_ms = (unsigned long)(cfg.comp_delay_min * 60000);
    if (should_r2 && !r2_state && comp_off_ts > 0 && (now - comp_off_ts) < delay_ms) {
      should_r2 = false; // Čekaj delay
    }
    if (should_r2 != r2_state) {
      if (!should_r2) {
        if (keezer_on_ts > 0) {
          today_on_sec += (millis()-keezer_on_ts)/1000;
          today_cycles++;
          keezer_on_ts = 0;
        }
        comp_off_ts = now;
      } else {
        keezer_on_ts = now;
      }
      r2_state = should_r2;
      digitalWrite(PIN_RELAY2, r2_state ? LOW : HIGH);
      flash_log_relay(2, r2_state);
      fb_log_relay(2, r2_state);
    }
  }

  // Firebase svake 5s — samo šalje, ne prima relay naredbe
  if (wifi_ok && (now - last_fb_send > 5000)) {
    fb_send_sensors();
    // fb_read_relays() maknuto — lokalna logika je jedina istina
    // Firebase /relays se ažurira iz fb_send_sensors (r1/r2 stanje)
    last_fb_send = now;
  }

  // Settings sync svake minute
  static unsigned long last_settings_sync = 0;
  if (wifi_ok && (now - last_settings_sync > 60000)) {
    fb_sync_settings();
    last_settings_sync = now;
  }

  // Remote restart svake 10s
  static unsigned long last_cmd_check = 0;
  if (wifi_ok && (now - last_cmd_check > 10000)) {
    String cmd = fb_get("/command/restart");
    if (cmd == "true") {
      Serial.println("[CMD] Remote restart!");
      fb_put("/command/restart", "false");
      delay(500);
      ESP.restart();
    }
    last_cmd_check = now;
  }

  // Debug log svake 5 minute
  static unsigned long last_debug_log = 0;
  if (wifi_ok && (now - last_debug_log > 300000)) {
    char dbg[192];
    snprintf(dbg, sizeof(dbg),
      "{\"uptime\":%lu,\"heap\":%u,\"rssi\":%d,\"flash\":%s,\"obs\":%s,\"temp_log\":%u,\"relay_log\":%u,\"ferm_hist\":%u}",
      millis()/1000, ESP.getFreeHeap(), WiFi.RSSI(),
      flash_ok?"true":"false", obs_mode?"true":"false",
      temp_log_head, relay_log_head, ferm_rec_count);
    fb_put("/debug", String(dbg));
    last_debug_log = now;
  }

  // History log svake minute (za graf dulje periode)
  static unsigned long last_history_log = 0;
  if (wifi_ok && (now - last_history_log > 60000)) {
    if (ferm_ok || keezer_ok) {
      unsigned long ts = (unsigned long)time(nullptr);
      char hist[128];
      snprintf(hist, sizeof(hist),
        "{\"ts\":%lu,\"f\":%.2f,\"k\":%.2f,\"r1\":%s,\"r2\":%s}",
        ts,
        ferm_ok   ? ferm_temp   + cfg.ferm_cal   : -99.0f,
        keezer_ok ? keezer_temp + cfg.keezer_cal : -99.0f,
        r1_state?"true":"false",
        r2_state?"true":"false");
      String path = "/history/" + String(ts);
      fb_put(path.c_str(), String(hist));
    }
    last_history_log = now;
  }

  // Flash log svaki sat
  if (now - last_flash_log > 3600000) {
    flash_log_temp();
    keezer_stat_save();
    last_flash_log = now;
  }

  // WiFi status
  wifi_ok = (WiFi.status() == WL_CONNECTED);

  // OLED svake sekunde (samo nakon boot_done)
  if (boot_done && (now - last_oled_update > 1000)) {
    oled_update();
    last_oled_update = now;
  }

  // Novi dan
  static uint32_t last_day = 0;
  struct tm ti;
  if (getLocalTime(&ti)) {
    if (ti.tm_hour==0 && ti.tm_min==0 && last_day!=ti.tm_yday) {
      last_day = ti.tm_yday;
      keezer_stat_save();
    }
  }

  delay(10);
}
