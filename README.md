# CeX Value Scanner & In-Store Profit Checker (Australia)

A mobile-first web app and command-line extractor for checking CeX Australia (`au.webuy.com`) cash values, voucher trade values, and profit margins on the go.

## Live Mobile Web App
**URL**: [https://jamie671.github.io/cex-value-checker/](https://jamie671.github.io/cex-value-checker/)

### Using on your Phone (iPhone & Android)
1. Open [https://jamie671.github.io/cex-value-checker/](https://jamie671.github.io/cex-value-checker/) in Safari (iOS) or Chrome (Android).
2. **Add to Home Screen**:
   - **iOS (Safari)**: Tap the **Share** button at the bottom -> Tap **Add to Home Screen**.
   - **Android (Chrome)**: Tap the **three dots** menu -> Tap **Install app** or **Add to Home screen**.
3. It will now appear on your phone like a native app with a custom icon.

### In-Store Features
- **Barcode Camera Scanner**: Tap "Scan Barcode" and point your phone camera at the barcode on the back of any game or console case for instant pricing.
- **Profit Flip Calculator**: Type in what the shop is charging in the "Shop Asking Price" box to see instant real-time profit and ROI percentages for cash and voucher.
- **Multi-System Support**: Switch between Wii, Switch, PS5, PS4, Xbox, Retro Gaming, and more.
- **Offline/Export**: Download any system catalog as an Excel spreadsheet or CSV with 1 click.

---

## Command-Line Extractor (`cex_scraper.py`)

Run on your computer to bulk export entire platforms or specific CeX URLs:

```bash
# Scrape all categories for any system:
python3 cex_scraper.py --system "Wii" -o wii_complete_catalog
python3 cex_scraper.py --system "Switch" -o switch_complete_catalog

# Scrape specific CeX URLs:
python3 cex_scraper.py "https://au.webuy.com/sell/search?categoryIds=795&categoryName=Wii%20Software"

# List all systems:
python3 cex_scraper.py --list-systems
```
