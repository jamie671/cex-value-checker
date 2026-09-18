#!/usr/bin/env python3
"""
CeX Australia (au.webuy.com) Multi-Category & Multi-System Price & Trade Extractor
Extracts product names, cash prices, CeX voucher (trade) values, sell prices, and product links.
Supports single/multiple URLs, category IDs, and entire systems/product lines (modern & retro).
"""

import argparse
import csv
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Set, Tuple

try:
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CONTEXT = ssl.create_default_context()
    SSL_CONTEXT.check_hostname = False
    SSL_CONTEXT.verify_mode = ssl.CERT_NONE

ALGOLIA_URL = (
    "https://search.webuy.io/1/indexes/*/queries"
    "?x-algolia-agent=Algolia%20for%20JavaScript%20(5.52.1)%3B%20Search%20(5.52.1)%3B%20Browser"
    "&x-algolia-api-key=bf79f2b6699e60a18ae330a1248b452c"
    "&x-algolia-application-id=LNNFEEWZVA"
)

INDEX_NAME = "prod_cex_au"

DEFAULT_HEADERS = {
    "Content-Type": "application/json",
    "Origin": "https://au.webuy.com",
    "Referer": "https://au.webuy.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
}

ATTRIBUTES_TO_RETRIEVE = [
    "boxId",
    "boxName",
    "cashPriceCalculated",
    "exchangePriceCalculated",
    "sellPrice",
    "categoryFriendlyName",
    "categoryName",
    "categoryId",
    "superCatFriendlyName",
    "superCatName",
    "productLineName",
    "imageUrls",
    "inStockStore",
    "inStockOnline",
    "rating",
    "Grade",
]

# Aliases for retro and shorthand system names mapping directly to category IDs
SYSTEM_ALIASES = {
    "n64": ("Nintendo 64", ["1099", "401", "1098"]),
    "nintendo 64": ("Nintendo 64", ["1099", "401", "1098"]),
    "ps1": ("PlayStation 1", ["1081", "1080", "1079"]),
    "playstation 1": ("PlayStation 1", ["1081", "1080", "1079"]),
    "psx": ("PlayStation 1", ["1081", "1080", "1079"]),
    "snes": ("Super Nintendo (SNES)", ["1102", "1101", "1100"]),
    "super nes": ("Super Nintendo (SNES)", ["1102", "1101", "1100"]),
    "super nintendo": ("Super Nintendo (SNES)", ["1102", "1101", "1100"]),
    "nes": ("Nintendo Entertainment System (NES)", ["1148", "1147", "1146"]),
    "game boy": ("Game Boy", ["1087", "1086", "1085"]),
    "gb": ("Game Boy", ["1087", "1086", "1085"]),
    "gba": ("Game Boy Advance", ["1092", "1091", "1090"]),
    "game boy advance": ("Game Boy Advance", ["1092", "1091", "1090"]),
    "gbc": ("Game Boy Color", ["1089", "1088"]),
    "game boy color": ("Game Boy Color", ["1089", "1088"]),
    "dreamcast": ("Sega Dreamcast", ["51", "50", "1139"]),
    "sega dreamcast": ("Sega Dreamcast", ["51", "50", "1139"]),
    "saturn": ("Sega Saturn", ["1151", "1150", "1149"]),
    "sega saturn": ("Sega Saturn", ["1151", "1150", "1149"]),
    "mega drive": ("Sega Mega Drive", ["1096", "1095", "1094"]),
    "genesis": ("Sega Mega Drive", ["1096", "1095", "1094"]),
    "master system": ("Sega Master System", ["1145", "1144", "1143"]),
    "game gear": ("Sega Game Gear", ["1142", "1141", "1140"]),
    "32x": ("Sega 32X", ["1093"]),
    "mega-cd": ("Sega Mega-CD", ["1097"]),
    "original xbox": ("Xbox (Original)", None),
    # Movies, Books & Media
    "dvd": ("DVD Movies & TV (inc. Anime)", ["746", "40", "710", "747", "681", "709", "749"]),
    "dvds": ("DVD Movies & TV (inc. Anime)", ["746", "40", "710", "747", "681", "709", "749"]),
    "blu-ray": ("Blu-Ray & 4K Ultra HD", ["792", "1078", "932", "991", "843", "544", "379", "192"]),
    "bluray": ("Blu-Ray & 4K Ultra HD", ["792", "1078", "932", "991", "843", "544", "379", "192"]),
    "4k": ("4K Ultra HD Blu-Ray", ["1078"]),
    "4k uhd": ("4K Ultra HD Blu-Ray", ["1078"]),
    "anime": ("Anime Media", ["746", "991"]),
    "books": ("Books & Literature", ["954"]),
    "book": ("Books & Literature", ["954"]),
}


def send_algolia_queries(requests_payload: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Send one or more query requests to the Algolia endpoint in a single HTTP POST."""
    data = json.dumps({"requests": requests_payload}).encode("utf-8")
    req = urllib.request.Request(ALGOLIA_URL, data=data, headers=DEFAULT_HEADERS)
    with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=30) as resp:
        result = json.loads(resp.read().decode("utf-8"))
        return result.get("results", [])


def list_available_systems() -> List[Tuple[str, int]]:
    """Retrieve all gaming & tech product lines (systems) with item counts."""
    payload = [
        {
            "indexName": INDEX_NAME,
            "filters": "boxVisibilityOnWeb=1 AND boxBuyAllowed=1",
            "facets": ["productLineName"],
            "hitsPerPage": 0,
            "maxValuesPerFacet": 150,
        }
    ]
    results = send_algolia_queries(payload)
    if not results:
        return []
    facets = results[0].get("facets", {}).get("productLineName", {})
    return sorted(facets.items(), key=lambda x: x[1], reverse=True)


def get_categories_for_system(system_name: str) -> List[Tuple[str, str, int]]:
    """Get all categories (ID, Name, Count) under a given system/product line or retro alias."""
    norm = system_name.lower().strip()
    if norm in SYSTEM_ALIASES and SYSTEM_ALIASES[norm][1]:
        clean_name, cat_ids = SYSTEM_ALIASES[norm]

        def cat_filter(cid: str) -> str:
            if cid == "954":
                return f"categoryId:{cid} AND boxSaleAllowed=1"
            return f"categoryId:{cid} AND boxVisibilityOnWeb=1 AND boxBuyAllowed=1"

        sub_requests = [
            {
                "indexName": INDEX_NAME,
                "filters": cat_filter(cid),
                "attributesToRetrieve": ["categoryId", "categoryFriendlyName", "categoryName"],
                "hitsPerPage": 1,
            }
            for cid in cat_ids
        ]
        sub_results = send_algolia_queries(sub_requests)
        cat_info = []
        for cid, sub_res in zip(cat_ids, sub_results):
            cnt = sub_res.get("nbHits", 0)
            hits = sub_res.get("hits", [])
            name = hits[0].get("categoryFriendlyName") or hits[0].get("categoryName") if hits else f"Category {cid}"
            if cnt > 0:
                cat_info.append((cid, name, cnt))
        cat_info.sort(key=lambda x: x[2], reverse=True)
        return cat_info

    # Otherwise query productLineName
    payload = [
        {
            "indexName": INDEX_NAME,
            "filters": f'productLineName:"{system_name}" AND boxVisibilityOnWeb=1 AND boxBuyAllowed=1',
            "facets": ["categoryId", "categoryFriendlyName"],
            "hitsPerPage": 0,
            "maxValuesPerFacet": 100,
        }
    ]
    results = send_algolia_queries(payload)
    if not results:
        return []

    cat_id_counts = results[0].get("facets", {}).get("categoryId", {})
    cat_info = []
    if cat_id_counts:
        sub_requests = [
            {
                "indexName": INDEX_NAME,
                "filters": f"categoryId:{cid}",
                "attributesToRetrieve": ["categoryId", "categoryFriendlyName", "categoryName"],
                "hitsPerPage": 1,
            }
            for cid in cat_id_counts.keys()
        ]
        sub_results = send_algolia_queries(sub_requests)
        for sub_res in sub_results:
            hits = sub_res.get("hits", [])
            if hits:
                h = hits[0]
                cid = str(h.get("categoryId"))
                name = h.get("categoryFriendlyName") or h.get("categoryName") or f"Category {cid}"
                count = cat_id_counts.get(cid, 0)
                cat_info.append((cid, name, count))

    cat_info.sort(key=lambda x: x[2], reverse=True)
    return cat_info


def parse_cex_url(url: str) -> Dict[str, Any]:
    """Parse a CeX search or category URL to extract category IDs, query, etc."""
    parsed = urllib.parse.urlparse(url)
    params = urllib.parse.parse_qs(parsed.query)

    category_ids = []
    if "categoryIds" in params:
        for cid_str in params["categoryIds"]:
            for cid in re.findall(r"\d+", cid_str):
                category_ids.append(cid)
    elif "categoryId" in params:
        for cid_str in params["categoryId"]:
            for cid in re.findall(r"\d+", cid_str):
                category_ids.append(cid)

    category_name = params.get("categoryName", [None])[0]
    query = params.get("q", params.get("query", [""]))[0]

    return {
        "url": url,
        "category_ids": list(set(category_ids)),
        "category_name": category_name,
        "query": query,
    }


def fetch_category_items(
    category_id: Optional[str] = None,
    system_name: Optional[str] = None,
    query: str = "",
    extra_filter: str = "",
    allow_unbuyable: bool = False,
) -> List[Dict[str, Any]]:
    """Fetch all items for a category or system with automatic price bracket partitioning."""
    is_unbuyable = allow_unbuyable or (category_id == "954")
    if is_unbuyable:
        base_filter_parts = ["boxSaleAllowed=1"]
    else:
        base_filter_parts = ["boxVisibilityOnWeb=1", "boxBuyAllowed=1"]

    if category_id:
        base_filter_parts.append(f"categoryId:{category_id}")
    if system_name:
        base_filter_parts.append(f'productLineName:"{system_name}"')
    if extra_filter:
        base_filter_parts.append(extra_filter)

    base_filter = " AND ".join(base_filter_parts)

    init_req = [
        {
            "indexName": INDEX_NAME,
            "filters": base_filter,
            "query": query,
            "hitsPerPage": 0,
        }
    ]
    res = send_algolia_queries(init_req)
    if not res:
        return []
    total_hits = res[0].get("nbHits", 0)

    if total_hits == 0:
        return []

    items_by_id = {}

    if total_hits <= 1000:
        req = [
            {
                "indexName": INDEX_NAME,
                "filters": base_filter,
                "attributesToRetrieve": ATTRIBUTES_TO_RETRIEVE,
                "query": query,
                "hitsPerPage": 1000,
                "page": 0,
            }
        ]
        res = send_algolia_queries(req)
        for hit in res[0].get("hits", []):
            items_by_id[hit["boxId"]] = hit
        return list(items_by_id.values())

    price_field = "sellPrice" if is_unbuyable else "cashPriceCalculated"
    brackets = [
        (f"{price_field} <= 2", f"{price_field} <= 2"),
        (f"{price_field} > 2 AND {price_field} <= 5", f"{price_field} > 2 AND {price_field} <= 5"),
        (f"{price_field} > 5 AND {price_field} <= 15", f"{price_field} > 5 AND {price_field} <= 15"),
        (f"{price_field} > 15 AND {price_field} <= 40", f"{price_field} > 15 AND {price_field} <= 40"),
        (f"{price_field} > 40", f"{price_field} > 40"),
    ]

    sub_requests = []
    for _, bracket_filter in brackets:
        filt = f"{base_filter} AND {bracket_filter}"
        sub_requests.append(
            {
                "indexName": INDEX_NAME,
                "filters": filt,
                "attributesToRetrieve": ATTRIBUTES_TO_RETRIEVE,
                "query": query,
                "hitsPerPage": 1000,
                "page": 0,
            }
        )

    res_list = send_algolia_queries(sub_requests)
    for res in res_list:
        for hit in res.get("hits", []):
            items_by_id[hit["boxId"]] = hit

    return list(items_by_id.values())


def extract_year(title: Optional[str]) -> Optional[int]:
    """Extract a release or edition year from a product/game title."""
    if not title:
        return None

    # 1. 4-digit years (1970 - 2035)
    m = re.search(r"\b(19[7-9]\d|20[0-3]\d)\b", title)
    if m:
        return int(m.group(1))

    # 2. 2K series: "2K7", "2K14", "2K24"
    m = re.search(r"\b2K(\d{1,2})\b", title, re.IGNORECASE)
    if m:
        val = int(m.group(1))
        return 2000 + val if val < 50 else 1900 + val

    # 3. Apostrophe years: "'09", "'15", "'98"
    m = re.search(r"['\u2019](\d{2})\b", title)
    if m:
        val = int(m.group(1))
        return 2000 + val if val < 50 else 1900 + val

    # 4. Split season: "09/10", "19/20"
    m = re.search(r"\b(\d{2})/(\d{2})\b", title)
    if m:
        val = int(m.group(1))
        return 2000 + val if val < 50 else 1900 + val

    # 5. Leading zero 2-digit years: "01" - "09"
    m = re.search(r"\b(0[1-9])\b", title)
    if m:
        return 2000 + int(m.group(1))

    # 6. 90s years: "90" - "99"
    m = re.search(r"\b(9[0-9])\b", title)
    if m:
        return 1900 + int(m.group(1))

    # 7. 2-digit years 10-35 following common annual title patterns or franchises
    sports_pattern = (
        r"(?:FIFA|FC|NBA|Madden|NHL|NFL|PGA|Tiger Woods|F1|Formula 1|Formula One|"
        r"MotoGP|WRC|SBK|AFL|NRL|Rugby|Cricket|WWE|Smackdown|RAW|Tour de France|"
        r"Football Manager|Cycling|Superbike|MXGP|PES|Pro Evolution)"
        r"\D*?\b(1[0-9]|2[0-9]|3[0-5])\b"
    )
    m = re.search(sports_pattern, title, re.IGNORECASE)
    if m:
        return 2000 + int(m.group(1))

    # 8. Standalone 2-digit number (10-35)
    m = re.search(r"\b([123]\d)\s*(?:$|\(|,|-)", title)
    if m:
        val = int(m.group(1))
        if 10 <= val <= 35:
            return 2000 + val

    return None


def transform_product(hit: Dict[str, Any]) -> Dict[str, Any]:
    """Extract and format clean fields for Excel/CSV export."""
    box_id = str(hit.get("boxId", "")).strip()
    name = str(hit.get("boxName", "")).strip()
    cash_price = float(hit.get("cashPriceCalculated") or 0)
    exchange_price = float(hit.get("exchangePriceCalculated") or 0)
    sell_price = float(hit.get("sellPrice") or 0)

    voucher_bonus = round(exchange_price - cash_price, 2)
    cash_pct = round((cash_price / sell_price * 100), 1) if sell_price > 0 else 0
    voucher_pct = round((exchange_price / sell_price * 100), 1) if sell_price > 0 else 0

    category = hit.get("categoryFriendlyName") or hit.get("categoryName") or ""
    category_id = str(hit.get("categoryId") or "")
    system = ""
    if isinstance(hit.get("productLineName"), list):
        system = ", ".join(hit["productLineName"])
    elif hit.get("productLineName"):
        system = str(hit["productLineName"])

    product_url = f"https://au.webuy.com/sell/product-detail?id={box_id}"
    image_url = ""
    if isinstance(hit.get("imageUrls"), dict):
        image_url = hit["imageUrls"].get("medium") or hit["imageUrls"].get("small") or ""

    in_stock_store = bool(hit.get("inStockStore"))
    in_stock_online = bool(hit.get("inStockOnline"))
    stock_status = "In Stock" if (in_stock_store or in_stock_online) else "Out of Stock"
    if in_stock_store and in_stock_online:
        stock_status = "Store & Online"
    elif in_stock_store:
        stock_status = "In Store Only"
    elif in_stock_online:
        stock_status = "Online Only"

    year = extract_year(name)

    return {
        "Product Name": name,
        "Year": year if year is not None else "",
        "Cash Value ($)": cash_price,
        "Voucher Value ($)": exchange_price,
        "CeX Sell Price ($)": sell_price,
        "Voucher Bonus ($)": voucher_bonus,
        "Cash % of Sell": cash_pct / 100.0,
        "Trade % of Sell": voucher_pct / 100.0,
        "Category": category,
        "Category ID": category_id,
        "System / Platform": system,
        "Stock Status": stock_status,
        "Barcode / ID": box_id,
        "CeX Sell Link": product_url,
        "Image URL": image_url,
    }


def export_to_csv(products: List[Dict[str, Any]], filepath: str):
    """Export a list of products to a standard CSV file."""
    if not products:
        print(f"No products to export to {filepath}.")
        return

    headers = [
        "Product Name",
        "Year",
        "Cash Value ($)",
        "Voucher Value ($)",
        "CeX Sell Price ($)",
        "Voucher Bonus ($)",
        "Cash % of Sell",
        "Trade % of Sell",
        "Category",
        "Category ID",
        "System / Platform",
        "Stock Status",
        "Barcode / ID",
        "CeX Sell Link",
    ]

    with open(filepath, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        for p in products:
            writer.writerow([
                p.get("Product Name"),
                p.get("Year", ""),
                f"{p.get('Cash Value ($)', 0):.2f}",
                f"{p.get('Voucher Value ($)', 0):.2f}",
                f"{p.get('CeX Sell Price ($)', 0):.2f}",
                f"{p.get('Voucher Bonus ($)', 0):.2f}",
                f"{(p.get('Cash % of Sell', 0) * 100):.1f}%",
                f"{(p.get('Trade % of Sell', 0) * 100):.1f}%",
                p.get("Category"),
                p.get("Category ID"),
                p.get("System / Platform"),
                p.get("Stock Status"),
                p.get("Barcode / ID"),
                p.get("CeX Sell Link"),
            ])
    print(f" Saved CSV: {filepath} ({len(products):,} products)")


def export_to_excel(
    category_product_map: Dict[str, List[Dict[str, Any]]],
    filepath: str,
    title: str = "CeX Product Catalog",
):
    """Export products to a styled Excel workbook (.xlsx)."""
    try:
        import openpyxl
        from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        print("openpyxl is required for Excel export. Please install via: pip install openpyxl")
        return

    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    header_font = Font(name="Segoe UI", size=11, bold=True, color="FFFFFF")
    header_fill = PatternFill(start_color="1A365D", end_color="1A365D", fill_type="solid")
    cash_header_fill = PatternFill(start_color="166534", end_color="166534", fill_type="solid")
    voucher_header_fill = PatternFill(start_color="1E40AF", end_color="1E40AF", fill_type="solid")
    bonus_header_fill = PatternFill(start_color="6B21A8", end_color="6B21A8", fill_type="solid")

    thin_border = Border(
        left=Side(style="thin", color="E2E8F0"),
        right=Side(style="thin", color="E2E8F0"),
        top=Side(style="thin", color="E2E8F0"),
        bottom=Side(style="thin", color="E2E8F0"),
    )
    link_font = Font(name="Segoe UI", size=10, color="0000EE", underline="single")
    regular_font = Font(name="Segoe UI", size=10)
    bold_font = Font(name="Segoe UI", size=10, bold=True)
    title_font = Font(name="Segoe UI", size=14, bold=True, color="0F172A")

    columns = [
        ("Product Name", 42, regular_font, "@", None),
        ("Year", 10, regular_font, "0", None),
        ("Cash Value ($)", 16, bold_font, "$#,##0.00", cash_header_fill),
        ("Voucher Value ($)", 18, bold_font, "$#,##0.00", voucher_header_fill),
        ("CeX Sell Price ($)", 18, regular_font, "$#,##0.00", None),
        ("Voucher Bonus ($)", 18, regular_font, "$#,##0.00", bonus_header_fill),
        ("Cash % of Sell", 15, regular_font, "0.0%", None),
        ("Trade % of Sell", 15, regular_font, "0.0%", None),
        ("Category", 22, regular_font, "@", None),
        ("Stock Status", 16, regular_font, "@", None),
        ("Barcode / ID", 16, regular_font, "@", None),
        ("CeX Sell Link", 20, link_font, "@", None),
    ]

    all_products = []
    for prods in category_product_map.values():
        all_products.extend(prods)

    all_products.sort(key=lambda x: x.get("Cash Value ($)", 0), reverse=True)

    # --- 1. SUMMARY SHEET ---
    ws_summary = wb.create_sheet(title="Summary")
    ws_summary.views.sheetView[0].showGridLines = True

    ws_summary.cell(row=1, column=1, value=title).font = title_font
    ws_summary.cell(row=2, column=1, value=f"Generated on {time.strftime('%Y-%m-%d %H:%M:%S')} | CeX Australia").font = Font(name="Segoe UI", size=10, italic=True, color="64748B")

    ws_summary.cell(row=4, column=1, value="Category Breakdown").font = Font(name="Segoe UI", size=12, bold=True)
    sum_headers = ["Category", "Total Items", "Total Cash Value ($)", "Total Voucher Value ($)", "Highest Cash Item", "Top Cash Value ($)"]
    for col_idx, h in enumerate(sum_headers, 1):
        cell = ws_summary.cell(row=5, column=col_idx, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")

    sum_row = 6
    for cat_name, prods in category_product_map.items():
        if not prods:
            continue
        sorted_prods = sorted(prods, key=lambda x: x.get("Cash Value ($)", 0), reverse=True)
        top_item = sorted_prods[0] if sorted_prods else {}
        cat_cash_total = sum(p.get("Cash Value ($)", 0) for p in prods)
        cat_vouch_total = sum(p.get("Voucher Value ($)", 0) for p in prods)

        ws_summary.cell(row=sum_row, column=1, value=cat_name).font = bold_font
        ws_summary.cell(row=sum_row, column=2, value=len(prods)).number_format = "#,##0"
        c3 = ws_summary.cell(row=sum_row, column=3, value=cat_cash_total)
        c3.number_format = "$#,##0.00"
        c4 = ws_summary.cell(row=sum_row, column=4, value=cat_vouch_total)
        c4.number_format = "$#,##0.00"
        ws_summary.cell(row=sum_row, column=5, value=top_item.get("Product Name", ""))
        c6 = ws_summary.cell(row=sum_row, column=6, value=top_item.get("Cash Value ($)", 0))
        c6.number_format = "$#,##0.00"
        sum_row += 1

    ws_summary.cell(row=sum_row, column=1, value="TOTAL").font = Font(name="Segoe UI", size=10, bold=True, color="1E3A8A")
    ws_summary.cell(row=sum_row, column=2, value=len(all_products)).font = bold_font
    ws_summary.cell(row=sum_row, column=2).number_format = "#,##0"
    t_cash = ws_summary.cell(row=sum_row, column=3, value=sum(p.get("Cash Value ($)", 0) for p in all_products))
    t_cash.font = bold_font
    t_cash.number_format = "$#,##0.00"
    t_vouch = ws_summary.cell(row=sum_row, column=4, value=sum(p.get("Voucher Value ($)", 0) for p in all_products))
    t_vouch.font = bold_font
    t_vouch.number_format = "$#,##0.00"

    for c in range(1, 7):
        ws_summary.column_dimensions[get_column_letter(c)].width = 24
    ws_summary.column_dimensions["A"].width = 28
    ws_summary.column_dimensions["E"].width = 45

    def populate_sheet(ws, products_list):
        ws.views.sheetView[0].showGridLines = True
        for col_idx, (col_name, width, _, _, custom_fill) in enumerate(columns, 1):
            cell = ws.cell(row=1, column=col_idx, value=col_name)
            cell.font = header_font
            cell.fill = custom_fill if custom_fill else header_fill
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            ws.column_dimensions[get_column_letter(col_idx)].width = width

        ws.row_dimensions[1].height = 28

        for row_idx, p in enumerate(products_list, 2):
            ws.row_dimensions[row_idx].height = 20
            vals = [
                p.get("Product Name"),
                p.get("Year"),
                p.get("Cash Value ($)"),
                p.get("Voucher Value ($)"),
                p.get("CeX Sell Price ($)"),
                p.get("Voucher Bonus ($)"),
                p.get("Cash % of Sell"),
                p.get("Trade % of Sell"),
                p.get("Category"),
                p.get("Stock Status"),
                p.get("Barcode / ID"),
                p.get("CeX Sell Link"),
            ]

            for col_idx, (val, (_, _, cell_font, num_fmt, _)) in enumerate(zip(vals, columns), 1):
                cell = ws.cell(row=row_idx, column=col_idx)
                cell.border = thin_border
                cell.font = cell_font

                if col_idx == 12 and val:
                    cell.value = "Sell to CeX"
                    cell.hyperlink = val
                    cell.font = link_font
                    cell.alignment = Alignment(horizontal="center")
                else:
                    cell.value = val
                    if num_fmt:
                        cell.number_format = num_fmt
                    if col_idx in [2, 3, 4, 5, 6, 7]:
                        cell.alignment = Alignment(horizontal="right")
                    elif col_idx in [9, 10]:
                        cell.alignment = Alignment(horizontal="center")

        last_col = get_column_letter(len(columns))
        last_row = max(len(products_list) + 1, 1)
        ws.auto_filter.ref = f"A1:{last_col}{last_row}"

    ws_all = wb.create_sheet(title="All Products")
    populate_sheet(ws_all, all_products)

    for cat_name, prods in category_product_map.items():
        if not prods:
            continue
        clean_title = re.sub(r'[\\/*?:\[\]]', "", cat_name)[:31]
        ws_cat = wb.create_sheet(title=clean_title)
        sorted_cat_prods = sorted(prods, key=lambda x: x.get("Cash Value ($)", 0), reverse=True)
        populate_sheet(ws_cat, sorted_cat_prods)

    wb.save(filepath)
    print(f" Saved Excel Workbook: {filepath} ({len(all_products):,} total products across {len(category_product_map)} categories)")


def main():
    parser = argparse.ArgumentParser(
        description="CeX Australia Price & Trade Value Extractor (All Systems & Categories)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  # Extract all categories for Nintendo Wii, Switch, or PS5:
  python3 cex_scraper.py --system "Wii" -o wii_complete_catalog
  python3 cex_scraper.py --system "Switch" -o switch_complete_catalog
  python3 cex_scraper.py --system "PlayStation 5" -o ps5_catalog

  # Extract retro systems (N64, SNES, PS1, Game Boy, GBA, Dreamcast, Mega Drive, Saturn):
  python3 cex_scraper.py --system "N64" -o n64_catalog
  python3 cex_scraper.py --system "PS1" -o ps1_catalog
  python3 cex_scraper.py --system "SNES" -o snes_catalog
  python3 cex_scraper.py --system "Game Boy" -o gameboy_catalog
  python3 cex_scraper.py --system "Dreamcast" -o dreamcast_catalog

  # Extract specific category IDs:
  python3 cex_scraper.py --categories 795,796 -o wii_selection

  # Extract using direct CeX URLs:
  python3 cex_scraper.py "https://au.webuy.com/sell/search?categoryIds=795&categoryName=Wii%20Software"

  # Search keyword across all systems:
  python3 cex_scraper.py --query "Silent Hill" -o silent_hill_search

  # List all available gaming & tech systems:
  python3 cex_scraper.py --list-systems
""",
    )

    parser.add_argument("urls", nargs="*", help="One or more CeX category/search URLs")
    parser.add_argument("--system", "-s", type=str, help='System / Product line / Media name (e.g. "Wii", "Switch", "PS5", "N64", "Blu-Ray", "DVD", "Books")')
    parser.add_argument("--categories", "-c", type=str, help="Comma-separated category IDs (e.g. 795,796,797,1109,1119)")
    parser.add_argument("--query", "-q", type=str, default="", help="Optional search keyword filter")
    parser.add_argument("--output", "-o", type=str, default="cex_products", help="Base output filename (without extension)")
    parser.add_argument("--min-cash", type=float, default=0, help="Minimum cash price filter in AUD")
    parser.add_argument("--min-voucher", type=float, default=0, help="Minimum trade voucher price filter in AUD")
    parser.add_argument("--sort", choices=["cash", "voucher", "year_desc", "year_asc", "name"], default="cash", help="Sort order (cash, voucher, year_desc, year_asc, name)")
    parser.add_argument("--list-systems", action="store_true", help="List all available systems and platforms on CeX")

    args = parser.parse_args()

    if args.list_systems:
        print("\n Fetching available systems on CeX Australia...")
        systems = list_available_systems()
        print(f"\nFound {len(systems)} product lines/systems:")
        print(f"{'System / Product Line':<40} {'Item Count':>12}")
        print("-" * 54)
        for name, count in systems:
            print(f"{name:<40} {count:>12,}")
        print("\nSupported Aliases:")
        print("  Retro: N64, PS1, SNES, NES, Game Boy, GBA, Game Boy Color, Dreamcast, Saturn, Mega Drive")
        print("  Media: Blu-Ray / Bluray, DVD / DVDs, 4K UHD, Anime, Books")
        return

    category_product_map: Dict[str, List[Dict[str, Any]]] = {}

    if args.urls:
        print(f"\n Parsing {len(args.urls)} CeX URL(s)...")
        for url in args.urls:
            parsed = parse_cex_url(url)
            cat_ids = parsed["category_ids"]
            q = parsed["query"] or args.query
            cat_name = parsed["category_name"] or (f"Category {cat_ids[0]}" if cat_ids else "Search Results")

            if cat_ids:
                for cid in cat_ids:
                    print(f" Fetching category ID: {cid} ({cat_name})...")
                    raw_hits = fetch_category_items(category_id=cid, query=q)
                    products = [transform_product(h) for h in raw_hits]
                    category_product_map[cat_name] = products
            else:
                print(f" Fetching search query: '{q}'...")
                raw_hits = fetch_category_items(query=q)
                products = [transform_product(h) for h in raw_hits]
                category_product_map[cat_name] = products

    elif args.system:
        system_name = args.system
        print(f"\n Inspecting categories for system: '{system_name}'...")
        cat_info = get_categories_for_system(system_name)
        if not cat_info:
            print(f"No categories found for system '{system_name}'. Attempting direct fetch...")
            raw_hits = fetch_category_items(system_name=system_name, query=args.query)
            prods = [transform_product(h) for h in raw_hits]
            category_product_map[system_name] = prods
        else:
            print(f"Found {len(cat_info)} categories under '{system_name}':")
            for cid, cname, cnt in cat_info:
                print(f"  • {cname} (ID: {cid}) - {cnt:,} items")

            for cid, cname, _ in cat_info:
                print(f"\n Fetching {cname} (ID: {cid})...")
                raw_hits = fetch_category_items(category_id=cid, query=args.query)
                prods = [transform_product(h) for h in raw_hits]
                category_product_map[cname] = prods

    elif args.categories:
        cids = [c.strip() for c in args.categories.split(",") if c.strip()]
        for cid in cids:
            print(f"\n Fetching category ID: {cid}...")
            raw_hits = fetch_category_items(category_id=cid, query=args.query)
            prods = [transform_product(h) for h in raw_hits]
            cat_name = prods[0]["Category"] if prods else f"Category {cid}"
            category_product_map[cat_name] = prods

    elif args.query:
        print(f"\n Searching CeX Australia globally for: '{args.query}'...")
        raw_hits = fetch_category_items(query=args.query)
        prods = [transform_product(h) for h in raw_hits]
        category_product_map[f"Search: {args.query}"] = prods

    else:
        default_url = "https://au.webuy.com/sell/search?categoryIds=795&categoryName=Wii%20Software"
        print(f"No arguments provided. Defaulting to Wii Software:\n  {default_url}")
        parsed = parse_cex_url(default_url)
        raw_hits = fetch_category_items(category_id="795")
        prods = [transform_product(h) for h in raw_hits]
        category_product_map["Wii Software"] = prods

    if args.min_cash > 0 or args.min_voucher > 0:
        for cat_name in list(category_product_map.keys()):
            category_product_map[cat_name] = [
                p for p in category_product_map[cat_name]
                if p.get("Cash Value ($)", 0) >= args.min_cash
                and p.get("Voucher Value ($)", 0) >= args.min_voucher
            ]

    all_products = []
    for prods in category_product_map.values():
        all_products.extend(prods)

    if args.sort == "year_desc":
        all_products.sort(key=lambda x: (x.get("Year") or 0, x.get("Cash Value ($)", 0)), reverse=True)
    elif args.sort == "year_asc":
        all_products.sort(key=lambda x: (x.get("Year") if isinstance(x.get("Year"), int) else 99999, -x.get("Cash Value ($)", 0)))
    elif args.sort == "voucher":
        all_products.sort(key=lambda x: x.get("Voucher Value ($)", 0), reverse=True)
    elif args.sort == "name":
        all_products.sort(key=lambda x: x.get("Product Name", "").lower())
    else:
        all_products.sort(key=lambda x: x.get("Cash Value ($)", 0), reverse=True)

    print(f"\n{'=' * 60}")
    print(f" Extraction Complete: {len(all_products):,} total products retrieved.")
    print(f"{'=' * 60}")

    base_name = args.output
    if base_name.endswith(".xlsx") or base_name.endswith(".csv"):
        base_name = os.path.splitext(base_name)[0]

    csv_path = f"{base_name}.csv"
    xlsx_path = f"{base_name}.xlsx"

    export_to_csv(all_products, csv_path)
    export_to_excel(category_product_map, xlsx_path, title=f"CeX Australia Catalog - {args.system or args.query or 'Export'}")

    print("\n Top 5 Highest Cash Value Products:")
    top_5 = sorted(all_products, key=lambda x: x.get("Cash Value ($)", 0), reverse=True)[:5]
    for idx, p in enumerate(top_5, 1):
        print(f"  {idx}. {p['Product Name']} ({p['Category']})")
        print(f"     Cash: ${p['Cash Value ($)']:.2f} | Voucher: ${p['Voucher Value ($)']:.2f} | CeX Sells for: ${p['CeX Sell Price ($)']:.2f}")


if __name__ == "__main__":
    main()
