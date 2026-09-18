# Ring-Instrument Kopma ve Takılı Nota Çözümü (2026-09-14)

Cosmic Symphony canlı rig — TouchDesigner Ring enstrümanı ↔ Cosmic Live Manager (CLM) ↔ CosmicRing VST.

## Belirtiler
1. **Kopma:** Ring-Instrument kartı ~13 saniyede bir `Unavailable` → `Connected` döngüsüne giriyordu. Hub logunda `Keepalive: 2 pings unanswered — terminating half-open WS` + `WS closed (code 1006)`. Yalnız Ring etkileniyordu (tabletler/VST'ler değil).
2. **Takılı nota:** note-on geliyor, bazen note-off gelmiyor, ses takılı kalıyordu.

## Kök neden 1 — TD WebSocket ping'e pong dönmüyordu (kopma)
- CLM hub her yönetilen OSCQuery WebSocket'ine 5 sn'de bir ping atar; 2 yanıtsız ping = yarı-açık soket sayıp kapatır ve yeniden bağlanır.
- TouchDesigner Web Server DAT ping çerçevesini `onWebSocketReceivePing` geri-çağırmasına iletir ama **pong'u geri-çağırmanın kendisi göndermelidir**.
- v7.4'te `dat_webserver1_callbacks.py` bunu yapıyordu. Project 23'te işleyicinin gövdesi boş kalmıştı:
  ```python
  def onWebSocketReceivePing(webServerDAT, client, data):
      return          # ← pong yok
  ```
- Ölçüm: ham WS testinde 11 ping → 0 pong; 40 sn'de 3 kopma.

### Düzeltme (TD tarafı, `/osc_query_server1/webserver1_callbacks`)
```python
def onWebSocketReceivePing(webServerDAT, client, data):
    # Reply with a pong so Cosmic Live Manager's WS keepalive (pings every
    # 5s, terminates after 2 unanswered) does not treat this live socket as
    # half-open and tear it down every ~13s. Restored from working v7.4.
    try:
        webServerDAT.webSocketSendPong(client)
    except Exception as e:
        print("OSCQuery: pong failed: {!r}".format(e))
    return
```
Sonuç: 4 ping → 4 pong; 45 sn'de 0 kopma.

### Düzeltme (hub tarafı, savunma katmanı — commit `a9995a7`)
`server/oscqueryClient.js` keepalive artık yalnız pong'a güvenmiyor:
- gelen her WS çerçevesi (pong **veya** veri) sayacı sıfırlar;
- eşikte kapatmadan önce HTTP `?HOST_INFO` yoklaması yapılır;
- HTTP-canlı-ama-WS-sessiz soket en çok `keepaliveHttpMaxRescues` (3) kez kurtarılır, sonra yenilenir (takılı WS maskelenmesin).
Env: `OSCQUERY_KEEPALIVE_HTTP_FALLBACK` (0 = eski katı davranış), `OSCQUERY_KEEPALIVE_HTTP_MAX_RESCUES`. Test: `test/keepalive.integration.test.js`.

## Kök neden 2 — bırakmada u/v değişmiyordu (takılı nota)
- CosmicRing VST motoru **kenar-tetiklemeli**: note-off yalnız noktanın halka bölgesinden **çıkışında** üretilir; `Depth`/`Touchradius` nota yoluna girmez.
- Project 23/26'da `rd_calc` bırakmada u,v'yi son dokunulan konumda **tutuyordu** → hiç u/v mesajı gitmiyor → VST çıkışı görmüyor → nota takılı.
- v7.4'te blob kaybolunca u,v 0'a düşüyor (nokta halka dışına sıçrıyor) → VST note-off üretiyordu.

### Düzeltme (TD tarafı, `/project1/rd_osc_cb`)
Dokunma bitince (`touch < 0.3`) u,v son yönde radyal olarak halkanın **dışına** itilir (`RELEASE_R = 0.62`, aynı sektör, iç diski geçmez). Görsel etkilenmez; görsel `rd_lag`'dan tutulan noktayı okur.
```python
if touch >= TOUCH_ON:
    un, vn = u_out, v
else:
    du, dv = u_out-0.5, v-0.5
    n = math.hypot(du, dv) or 1.0
    un = 0.5 + du/n*RELEASE_R
    vn = 0.5 + dv/n*RELEASE_R
```
Doğrulama: 29 dokunuşta 29 temiz çıkış, gecikme ≤ 17 ms (tek kare); kulakla takılı ses yok.

## Kayıtlı dosya
`THE_RING_SY.31.toe` (neva40902, `C:\Users\Taha\Desktop\THERING_SY\`) — her iki TD düzeltmesini içerir. Orijinal/yamalı betikler: `cosmic-preflight/rollback/td-webserver1_callbacks-20260914/`, `.../td-ring-release-20260914/`.

## Teşhis komutları
```bash
# Pong dönüyor mu?
node -e 'const W=require("ws");const w=new W("ws://<ring-ip>:9011");let p=0;w.on("open",()=>setInterval(()=>w.ping(),3000));w.on("pong",()=>console.log("PONG",++p));setTimeout(()=>process.exit(),12000)'
# Bırakmada nokta dışarı çıkıyor mu? /RingData/U,V merkezden 0.5'ten uzağa gitmeli.
```

## Notlar
- `rd_calc` `LOCKOUT_FRAMES = 20` (0.33 sn) bırakma sonrası hızlı yeniden dokunuşu yutar; bilinçli, değiştirilmedi.
- `neva40902` Ethernet + Wi-Fi aynı alt ağda (dual-home); Wi-Fi açılırsa mDNS iki adres duyurur. Wi-Fi kapalı tutulmalı.
