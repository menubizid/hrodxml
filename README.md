# hrodxml

**ApexHR: Madura 24/7 Retail Empire Simulator — Ultimate Mermaid.js & Automated Process Edition.**
Ultimate Interconnected Forecast & Enterprise Engineering Edition.

Simulator Organization Development (OD) berbasis web yang mengubah jaringan
"Toko Madura 24 Jam" menjadi korporasi ritel nasional. Setiap keputusan HR
menggambar ulang struktur organisasi, SOP, dan forecast kuartalan secara
real-time melalui **Dynamic Mermaid.js Rendering Engine**.

## Deliverable — 3 file

| File | Layer | Isi |
|---|---|---|
| [`PANDUAN-LENGKAP.md`](PANDUAN-LENGKAP.md) | Dokumentasi | Arsitektur, model forecast, referensi REST API, skema database, panduan deployment, matriks kepatuhan engineering rule |
| [`code.gs`](code.gs) | Backend | Google Apps Script: Routing → Controller → Service Layer (Forecast Engine + Mermaid Synthesizer + Batch Sheet I/O) |
| [`theme.xml`](theme.xml) | Frontend | Blogger XML Theme: SPA lengkap (navbar, hero, features, simulator, manfaat, FAQ, CTA, footer) |

## Stack

HTML5 · Vanilla JavaScript · Tailwind CSS · Mermaid.js 10 · Google Apps Script (V8) ·
Google Sheets · localDB (localStorage, offline-first)

## Fitur inti

- **Dynamic Mermaid.js Engine** — 5 diagram (Org Chart, Process Flow/SOP, Strategy Mindmap,
  Succession Pipeline, Culture & Fatigue) disintesis otomatis dari state permainan.
- **Interconnected Forecast Engine** — 42+ variabel terhubung dengan efek domino matematis.
- **CRUD penuh** — Toko, Karyawan, Divisi, Kebijakan/SOP, Event Budaya; tersimpan di localDB
  dan dapat disinkronkan ke Google Sheets.
- **REST API** — envelope kanonik `{ success, message, data, timestamp }`.
- **Mobile-first & accessible** — responsive penuh, target sentuh ≥ 44 px, teks dasar 16 px,
  navigasi keyboard, `prefers-reduced-motion`.

## Deployment singkat

1. **Backend** — tempel `code.gs` ke Apps Script, isi `CONFIG.SPREADSHEET_ID`,
   jalankan `apexHrSetupDatabase()`, lalu *Deploy → New deployment → Web app*.
2. **Frontend** — unggah `theme.xml` lewat Blogger → *Theme → Edit HTML*, lalu set
   `CONFIG.API_BASE` pada blok skrip client ke URL `/exec` hasil deploy.

Detail lengkap (termasuk rumus forecast, skema 8 tabel Sheets, dan checklist QA)
tersedia di [`PANDUAN-LENGKAP.md`](PANDUAN-LENGKAP.md).
