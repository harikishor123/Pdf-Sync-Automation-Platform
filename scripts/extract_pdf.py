#!/usr/bin/env python3
"""
FlixBus PDF extractor — pdfplumber for text-based PDFs, OCR fallback for vector-text PDFs.
Called by pdf-parser.service.ts as a subprocess.

Usage:  python3 extract_pdf.py <path-to-pdf>
Output: JSON to stdout matching the FlixBusParsed TypeScript interface.
Errors: non-zero exit code + message on stderr.
"""
import pdfplumber
import json
import sys
import re
from datetime import datetime


def cell(value) -> str:
    return str(value).strip() if value is not None else ''


# =============================================================================
# Metadata extraction — shared between table and OCR paths
# =============================================================================

def _apply_metadata_regexes(v: str, meta: dict) -> None:
    """Apply all metadata field regexes to one text chunk, writing into meta."""

    if 'bus_partner' not in meta:
        m = re.search(r'Bus\s+Partner\s*:\s*(.+)', v, re.I)
        if m:
            meta['bus_partner'] = m.group(1).strip()

    if 'vehicle_number' not in meta:
        m = re.search(r'\bPlate\s+([A-Z0-9]+)', v, re.I)
        if m:
            meta['vehicle_number'] = m.group(1).strip()

    if 'date' not in meta:
        m = re.search(r'\bDate\s+(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})', v, re.I)
        if m:
            raw = m.group(1)
            for fmt in ('%d.%m.%Y', '%d/%m/%Y', '%d-%m-%Y', '%Y-%m-%d'):
                try:
                    meta['date'] = datetime.strptime(raw, fmt).strftime('%Y-%m-%d')
                    break
                except ValueError:
                    pass

    if 'departure_time' not in meta:
        m = re.search(r'Departure\s+Time\s+(\d{1,2}:\d{2})', v, re.I)
        if m:
            meta['departure_time'] = m.group(1) + ':00'

    if 'arrival_time' not in meta:
        m = re.search(r'Arrival\s+Time\s+(\d{1,2}:\d{2})', v, re.I)
        if m:
            meta['arrival_time'] = m.group(1) + ':00'

    # Stop departure city before "Arrival" or end of string
    if 'departure' not in meta:
        m = re.search(
            r'\bDeparture\s+(?!Time\b)([A-Za-z][A-Za-z ]+?)(?=\s*(?:Arrival\b|$))',
            v, re.I,
        )
        if m:
            meta['departure'] = m.group(1).strip()

    if 'arrival' not in meta:
        m = re.search(
            r'\bArrival\s+(?!Time\b)([A-Za-z][A-Za-z ]+?)(?=\s*$)',
            v, re.I,
        )
        if m:
            meta['arrival'] = m.group(1).strip()

    if 'line_number' not in meta:
        m = re.search(r'\bLine\s+([A-Z]{2}\d{3,6})\b', v, re.I)
        if m:
            meta['line_number'] = m.group(1).upper()


def parse_metadata_from_text(text: str) -> dict:
    """Scan raw text line-by-line for trip-level metadata fields."""
    meta: dict = {}
    for line in text.splitlines():
        line = line.strip()
        if line:
            _apply_metadata_regexes(line, meta)
    return meta


def parse_metadata_from_table(table: list) -> dict:
    """Scan a pdfplumber table for trip-level metadata fields."""
    meta: dict = {}
    for row in table:
        for c in row:
            v = cell(c)
            if v:
                _apply_metadata_regexes(v, meta)
    return meta


# =============================================================================
# Table parsing — pdfplumber path
# =============================================================================

def parse_drivers_from_table(table: list) -> list:
    drivers = []
    header = [cell(c).lower() for c in (table[0] or [])]
    try:
        name_i  = header.index('name')
        role_i  = header.index('role')
        phone_i = header.index('phone')
    except ValueError:
        return drivers

    for row in table[1:]:
        if not row or not any(row):
            continue
        name  = cell(row[name_i]).lstrip(', ').strip()
        role  = cell(row[role_i]) or None
        phone = cell(row[phone_i])
        if name and phone:
            drivers.append({'driver_name': name, 'role': role, 'phone': phone})

    return drivers


def parse_seats_from_table(table: list) -> list:
    seats = []
    header = [cell(c).lower() for c in (table[0] or [])]
    try:
        seat_i  = header.index('seat number')
        name_i  = header.index('name')
        phone_i = header.index('phone')
        shop_i  = header.index('shop') if 'shop' in header else None
    except ValueError:
        return seats

    for row in table[1:]:
        if not row or not row[seat_i]:
            continue
        seat_no = cell(row[seat_i])
        name    = cell(row[name_i])
        phone   = cell(row[phone_i])
        shop    = cell(row[shop_i]) if shop_i is not None else None
        if seat_no and name:
            seats.append({
                'seat_no': seat_no,
                'name':    name,
                'phone':   phone,
                'shop':    shop or None,
            })

    return seats


# =============================================================================
# Table parsing — OCR text path
# =============================================================================

def parse_drivers_from_text(lines: list) -> list:
    """Parse the driver table from OCR-extracted text lines."""
    drivers = []
    in_table = False

    for line in lines:
        lower = line.lower()

        if 'name' in lower and 'role' in lower and 'phone' in lower:
            in_table = True
            continue

        if not in_table:
            continue

        # Stop when we hit the passenger table header
        if 'seat number' in lower or ('seat' in lower and 'name' in lower):
            break

        if not line:
            continue

        # Phone: last numeric-looking token
        phone_m = re.search(r'(\+?\d[\d\s]{7,14}\d)', line)
        if not phone_m:
            continue

        phone = re.sub(r'\s+', '', phone_m.group(1))
        before_phone = line[:phone_m.start()].strip()

        # Role is typically one token immediately before the phone number
        parts = before_phone.rsplit(None, 1)
        if len(parts) == 2:
            name, role = parts[0].strip(), parts[1].strip()
        else:
            name, role = before_phone, None

        name = name.lstrip(', ').strip()
        if name:
            drivers.append({'driver_name': name, 'role': role or None, 'phone': phone})

    return drivers


def parse_seats_from_text(lines: list) -> list:
    """Parse the passenger table from OCR-extracted text lines."""
    seats = []
    in_table = False

    for line in lines:
        lower = line.lower()

        if 'seat number' in lower or ('seat' in lower and 'name' in lower and 'phone' in lower):
            in_table = True
            continue

        if not in_table or not line:
            continue

        # Each passenger row starts with a seat like "1B", "2A", "3F".
        # Allow OCR noise after the letter (e.g. "1C¢ " → seat "1C").
        seat_m = re.match(r'^(\d{1,2}[A-F])\W*\s+', line, re.I)
        if not seat_m:
            continue

        seat_no = seat_m.group(1).upper()
        rest    = line[seat_m.end():].strip()

        # Phone: numeric pattern with optional +91 prefix
        phone_m = re.search(r'(\+?\d[\d\s]{7,14}\d)', rest)
        if not phone_m:
            continue

        phone = re.sub(r'\s+', '', phone_m.group(1))
        name  = rest[:phone_m.start()].strip()
        shop  = rest[phone_m.end():].strip() or None

        if seat_no and name:
            seats.append({'seat_no': seat_no, 'name': name, 'phone': phone, 'shop': shop})

    return seats


# =============================================================================
# OCR extraction path (for PDFs where text is stored as vector curves)
# =============================================================================

def extract_via_ocr(pdf_path: str) -> dict:
    try:
        from pdf2image import convert_from_path
        import pytesseract
    except ImportError as e:
        raise RuntimeError(
            f'OCR dependencies missing: {e}. '
            'Run: pip3 install pdf2image pytesseract  &&  brew install tesseract poppler'
        )

    result = _empty_result()

    # 200 DPI: table grid lines stay thin enough that Tesseract reads all rows.
    # Higher DPI makes the grid more prominent and causes most rows to be missed.
    images = convert_from_path(pdf_path, dpi=200)

    # PSM 4 (single-column): best for the header block — preserves the
    # "Plate … Date … Departure Time … Arrival Time" row as a single line.
    text_psm4 = '\n'.join(
        pytesseract.image_to_string(img, config='--psm 4') for img in images
    )

    # PSM 3 (auto): best for the passenger/driver table rows.
    text_psm3 = '\n'.join(
        pytesseract.image_to_string(img, config='--psm 3') for img in images
    )

    meta = parse_metadata_from_text(text_psm4)
    result.update({k: v for k, v in meta.items() if v is not None})

    lines = [l.strip() for l in text_psm3.splitlines()]
    result['driver_details'] = parse_drivers_from_text(lines)
    result['seat_details']   = parse_seats_from_text(lines)

    return result


# =============================================================================
# Main entry point
# =============================================================================

def _empty_result() -> dict:
    return {
        'line_number':    None,
        'bus_partner':    None,
        'vehicle_number':          None,
        'date':           None,
        'departure_time': None,
        'arrival_time':   None,
        'departure':      None,
        'arrival':        None,
        'driver_details': [],
        'seat_details':   [],
    }


def extract(pdf_path: str) -> dict:
    # Detect whether the PDF has selectable text or vector-only curves.
    with pdfplumber.open(pdf_path) as pdf:
        has_text = any(len(page.chars) > 0 for page in pdf.pages)
        if has_text:
            all_tables = [
                t for page in pdf.pages
                for t in (page.extract_tables() or [])
            ]
            page_text = '\n'.join(
                (page.extract_text() or '') for page in pdf.pages
            )

    if not has_text:
        return extract_via_ocr(pdf_path)

    # ── pdfplumber path ────────────────────────────────────────────────────────
    result = _empty_result()

    for table in all_tables:
        if not table or not table[0]:
            continue

        header_cells = [cell(c).lower() for c in table[0]]

        if 'name' in header_cells and 'role' in header_cells:
            result['driver_details'] = parse_drivers_from_table(table)

        elif 'seat number' in header_cells:
            result['seat_details'] = parse_seats_from_table(table)

        else:
            flat = ' '.join(cell(c) for row in table for c in row)
            if 'bus partner' in flat.lower():
                result.update(parse_metadata_from_table(table))

    # Fallback: fill missing metadata from raw page text
    if not result['bus_partner']:
        text_meta = parse_metadata_from_text(page_text)
        for key, value in text_meta.items():
            if value and not result.get(key):
                result[key] = value

    return result


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 extract_pdf.py <path>', file=sys.stderr)
        sys.exit(1)

    try:
        output = extract(sys.argv[1])
        print(json.dumps(output, ensure_ascii=False))
    except Exception as e:
        print(f'extract_pdf.py error: {e}', file=sys.stderr)
        sys.exit(1)
