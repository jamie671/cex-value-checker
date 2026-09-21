# CLAUDE.md - CeX & eBay Value Checker

This document contains complete project instructions, architecture details, and implementation history for Claude.

---

## 1. Project Overview

**CeX Value Checker & Profit Evaluator** is a dual-platform tool (mobile-first PWA web app + Python CLI catalog extractor) designed to help video game and retro media collectors evaluate CeX Australia trade/cash values and compare them against live Australian eBay market comps.

- **Live Web App**: [https://jamie671.github.io/cex-value-checker/](https://jamie671.github.io/cex-value-checker/)
- **Primary GitHub Repo**: `jamie671/cex-value-checker` (branch: `main`)
- **Local Workspace Paths**:
  - Primary: `/Users/jamesgemmell/Library/CloudStorage/GoogleDrive-jamie@searchjam.com.au/My Drive/Antigravty Files/cex-value-checker/`
  - Mirror: `/Users/jamesgemmell/Library/CloudStorage/GoogleDrive-jamie@searchjam.com.au/My Drive/Antigravty Files/Plato-Intelligence/`

---

## 2. Core Architecture & Files

```
cex-value-checker/
├── index.html           # Standalone mobile PWA web app (HTML5, Tailwind CSS, Lucide icons, Tesseract.js, Gemini Vision, Algolia)
├── cex_scraper.py       # Python 3 CLI scraper & spreadsheet generator with official eBay Production API integration
├── ebay_config.json     # Private eBay API credentials (NEVER COMMIT TO GIT - listed in .gitignore)
├── .gitignore           # Ignores ebay_config.json, *.env, __pycache__, .DS_Store
├── manifest.json        # Web app manifest for PWA mobile install (Add to Home Screen)
├── icon-192.png         # PWA home screen app icon (192x192)
├── icon-512.png         # High-res splash icon (512x512)
├── qr_code.png          # QR code for opening the web app on mobile devices
└── README.md            # Public project README
```

> **IMPORTANT**:
> - Always maintain parity between `cex-value-checker/` and `Plato-Intelligence/`. When making edits, copy the modified files to both directories.
> - Never remove `ebay_config.json` from `.gitignore` or commit API secret keys to public git.

---

## 3. APIs & Credentials

### A. CeX Australia Algolia Search API (Public / Read-only)
CeX Australia (`au.webuy.com`) uses Algolia for real-time inventory and pricing search.
- **Endpoint**: `https://search.webuy.io/1/indexes/*/queries`
- **Application ID**: `LNNFEEWZVA`
- **API Key**: `bf79f2b6699e60a18ae330a1248b452c`
- **Index Name**: `prod_cex_au`
- **Important Filters**:
  - In stock / allowed: `boxVisibilityOnWeb=1 AND boxBuyAllowed=1`
  - Gaming specific: `superCatFriendlyName:Gaming`
  - Fuzzy tolerance: `removeWordsIfNoResults: "allOptional"`

### B. Official eBay Production API
The user has an approved eBay Developers Program Production account used by `EbayClient` in `cex_scraper.py`.
- **Stored in**: `ebay_config.json` (keys: `app_id`, `cert_id`, `environment: PRODUCTION`, `marketplace_id: EBAY_AU`, `country: AU`)
- **Marketplace**: `EBAY_AU` | **Country**: `AU`
- **OAuth Endpoint**: `https://api.ebay.com/identity/v1/oauth2/token` (grant type: `client_credentials`, scope: `https://api.ebay.com/oauth/api_scope`)
- **Buy Browse Search Endpoint**: `https://api.ebay.com/buy/browse/v1/item_summary/search`
- **Categories**: Video Games (`139973`), Movies & TV (`617`), Books (`267`)
- **Account Deletion Exemption**: Officially approved in Developer Portal (Opted out under "Not persisting eBay data" exemption).

### C. Google Gemini AI Vision (Optional in Web App)
- `index.html` supports Gemini for cloud-based AI reading of shelf photos. This is the most reliable way to read a shelf or pile of games in a shop.
- **Model fallback chain** (`GEMINI_MODELS` in `index.html`): `gemini-3.5-flash-lite` -> `gemini-3.5-flash` -> `gemini-2.5-flash-lite` -> `gemini-2.5-flash`. The app walks the list when a model ID returns 404 / "not found". `gemini-2.0-flash` was shut down by Google on 1 June 2026 and must not be used.
- Photos are re-encoded client-side to JPEG (max 2400px) before upload, so iPhone HEIC photos work.
- Free API keys are created via Google AI Studio (`https://aistudio.google.com/app/apikey`) and saved in the user's browser `localStorage` under `bulk_gemini_key`.

---

## 4. Completed Work & Technical Solutions

### A. Web App (`index.html`)
1. **In-Store Barcode Scanner**: Uses HTML5 Camera API (`Html5Qrcode`) to scan EAN/UPC barcodes directly from physical game cases for instantaneous CeX cash & voucher pricing.
2. **Profit & ROI Calculator**: Allows entering shop asking price to calculate net cash profit, trade voucher profit, and ROI percentages.
3. **Bulk Shelf & Stack Photo Scanner** (on-device Tesseract.js, no key needed):
   - **Shelf band detection** (`detectSpineBand`): finds the horizontal band of the photo with the densest edges (the row of spines) and ignores shelf wood and other shelves above/below.
   - **Rotate + upscale + tile** (`buildOcrTiles`): rotates the band so spine text reads left-to-right, scales it so the axis across the spines is ~3000px (small PS4 spine fonts become readable), contrast-stretches to grayscale, and splits into <=8.5MP tiles to stay under mobile Safari canvas limits.
   - **Sparse-text OCR + spine grouping** (`ocrOrientation`, `groupWordsIntoSpines`): runs Tesseract in PSM 11 (sparse text) to get individual word boxes, then groups words whose boxes share the same vertical interval into one line per spine. Whole-image block OCR and per-spine edge segmentation were both tested and rejected (garbage output / unreliable boundaries on dark-on-dark cases).
   - **Auto orientation**: tries upright spines (270°) first; only runs the flat-stack (0°) pass if fewer than 3 spines were found.
   - **Title cleaner** (`cleanAndFilterTitles`): splits fused digits (`CAUSE2` -> `CAUSE 2`), strips price stickers, catalog codes (`BLES`, `CUSA`, `MW2`), platform tags and rating badges, fuzzy-corrects common OCR misreads (`Urange Box`, `JUSTCRUSE`), and drops OCR crumbs.
   - **Expected accuracy**: roughly half to two-thirds of spines read cleanly on a typical shelf photo in ~5-10s on desktop. Titles are dumped into the textarea for review; the Algolia `allOptional` search tolerates leftover noise words. For near-perfect results the user should switch to AI Vision.
   - **Spine Focus & Crop Tool**: users can trim top ceiling glare and bottom counter reflections before scanning.
   - **Mobile Live Text Support (recommended on iPhone)**: Apple Live Text reads spines far better than Tesseract. Photos app -> Live Text -> Select All -> Copy -> "Paste Copied Spines". The paste is auto-tidied.
   - **Tidy step / platform detection** (`parseSpineDump`, `tidyLotText`, `PLATFORM_DEFS`): Live Text dumps list the platform badge ("XBOX 360.", "XBOX*", "PlayStation.2") as its own line next to each title. The parser tracks the most recent platform line, attaches it to the following title, also handles inline platforms ("Spider-Man PS4") and the tidied form "Title | Platform". Noise lines (ratings, PAL, catalog numbers, publishers) are dropped via `NOISE_LINE_RX`. Calculate always runs this parse first, so the textarea can hold a raw dump.
   - **Platform-aware CeX search** (`evaluateLot`): each item sends two Algolia requests, one hard-filtered to the platform's `categoryFriendlyName` (e.g. `Xbox 360 Games`, `Playstation4 Games`, `Xbox Games`) and one unfiltered Gaming fallback; the filtered hit wins when present. Algolia `optionalFilters` was tested and did not reliably reorder results, hence the hard filter + fallback. Category names come from the `categoryFriendlyName` facet on the index.
4. **Algolia Gaming-First Search**: Restricts searches to `superCatFriendlyName:Gaming` with `allOptional` words, eliminating false hits on laptops, keyboards, and cables. Includes an automatic fallback pass for movie Blu-rays or specialty sets.
5. **1-Tap eBay Australia Search Links**: Every item card and table row features direct links to:
   - CeX Sell Page
   - eBay AU 90-Day Sold & Completed Comps (`LH_Sold=1&LH_Complete=1`)
   - eBay AU Low Price (`_sop=15`)
   - eBay AU High Price (`_sop=16`)
   - eBay AU Active Competition Comps

### B. Python CLI Extractor (`cex_scraper.py`)
1. **Full Catalog & Multi-System Scraping**:
   - Supports searching by system alias (e.g. `--system "Wii"`, `"Switch"`, `"PS5"`, `"PS4"`, `"N64"`, `"PS1"`, `"SNES"`, `"Blu-Ray"`, etc.).
   - Supports direct CeX category IDs (`--categories 795,796`) or custom search queries (`--query "The Orange Box"`).
   - Automatically retrieves full multi-page results across Algolia batches.
2. **Official eBay Live Market Pricing (`--ebay`)**:
   - Connects to official eBay Production API.
   - Formats CeX titles into clean search queries (flips `"Title, The"` -> `"The Title"`, removes age ratings and platform noise).
   - Pulls active Australian listings and calculates real price totals including shipping (`itemPrice + shippingCost`).
   - Extracts: **eBay Active Listings**, **eBay Low Price ($)**, **eBay Avg Price ($)**, and **eBay High Price ($)**.
3. **Excel Workbook (`.xlsx`) & CSV Generation**:
   - Styled Excel with Segoe UI typography, thin borders, and color-coded headers (CeX Green, Voucher Blue, eBay Blue).
   - Formats prices as currency (`$#,##0.00`) and includes live Excel hyperlinks to eBay comps.
   - Creates a dedicated "Summary" sheet with total items, total cash value, voucher values, and top-value items.

---

## 5. Development & Testing Commands

### Python Scraper Commands
```bash
# Run a quick search with eBay live pricing:
python3 cex_scraper.py --query "The Orange Box" --ebay -o orange_box_comps

# Scrape an entire console catalog (with optional limit on eBay requests):
python3 cex_scraper.py --system "N64" --ebay --ebay-limit 50 -o n64_comps

# List all available systems and platforms on CeX:
python3 cex_scraper.py --list-systems

# Filter high-value trade items (e.g. min $30 cash value):
python3 cex_scraper.py --system "Switch" --min-cash 30 -o switch_gems
```

### Git & Deployment Workflow
```bash
# Verify status and ignored files:
git status

# Commit and push updates to deploy to GitHub Pages:
git add index.html cex_scraper.py README.md CLAUDE.md
git commit -m "Update feature description"
git push origin main
# GitHub Pages auto-builds in ~30 seconds at https://jamie671.github.io/cex-value-checker/
```

### Sync Workspaces
```bash
# Copy modified files between primary and mirror workspace:
cp index.html cex_scraper.py CLAUDE.md "/Users/jamesgemmell/Library/CloudStorage/GoogleDrive-jamie@searchjam.com.au/My Drive/Antigravty Files/Plato-Intelligence/"
```

---

## 6. Guidelines for Claude

1. **Do not leak API credentials**: Never put private client secrets or `ebay_config.json` contents in public commits.
2. **Preserve PWA functionality**: When modifying `index.html`, ensure all scripts work offline/client-side and maintain mobile responsiveness.
3. **Keep workspaces synchronized**: Always reflect changes in both `cex-value-checker` and `Plato-Intelligence`.
4. **Algolia parameter consistency**: Keep `filters: "boxVisibilityOnWeb=1 AND boxBuyAllowed=1 AND superCatFriendlyName:Gaming"` and `removeWordsIfNoResults: "allOptional"` for robust game title matching.
