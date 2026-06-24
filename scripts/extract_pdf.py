#!/usr/bin/env python3
"""
FlixBus PDF extractor — uses pdfplumber table extraction.
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
    """Safely coerce a table cell to a trimmed string."""
    return str(value).strip() if value is not None else ''


def parse_metadata(table: list) -> dict:
    """
    Extract trip-level fields from the header table.

    Expected layout (3 rows x 4 cols):
      Row 0: ["Bus Partner: Divya Enterprises", null, null, null]
      Row 1: ["Plate MH49CW1053", "Date 16.06.2026", "Departure Time 19:30", "Arrival Time 10:55"]
      Row 2: ["Departure Hyderabad", null, "Arrival Pune", null]
    """
    meta: dict = {}
    for row in table:
        for c in row:
            v = cell(c)
            if not v:
                continue

            m = re.search(r'Bus\s+Partner\s*:\s*(.+)', v, re.I)
            if m:
                meta['bus_partner'] = m.group(1).strip()

            m = re.search(r'\bPlate\s+([A-Z0-9]+)', v, re.I)
            if m:
                meta['plate'] = m.group(1).strip()

            m = re.search(r'\bDate\s+(\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4})', v, re.I)
            if m:
                raw = m.group(1)
                for fmt in ('%d.%m.%Y', '%d/%m/%Y', '%d-%m-%Y', '%Y-%m-%d'):
                    try:
                        meta['date'] = datetime.strptime(raw, fmt).strftime('%Y-%m-%d')
                        break
                    except ValueError:
                        pass

            m = re.search(r'Departure\s+Time\s+(\d{1,2}:\d{2})', v, re.I)
            if m:
                meta['departure_time'] = m.group(1) + ':00'

            m = re.search(r'Arrival\s+Time\s+(\d{1,2}:\d{2})', v, re.I)
            if m:
                meta['arrival_time'] = m.group(1) + ':00'

            # "Departure Hyderabad" — avoid matching "Departure Time"
            m = re.search(r'\bDeparture\s+(?!Time\b)([A-Za-z][A-Za-z ]+)', v, re.I)
            if m:
                meta['departure'] = m.group(1).strip()

            # "Arrival Pune" — avoid matching "Arrival Time"
            m = re.search(r'\bArrival\s+(?!Time\b)([A-Za-z][A-Za-z ]+)', v, re.I)
            if m:
                meta['arrival'] = m.group(1).strip()

    return meta


def parse_drivers(table: list) -> list:
    """
    Parse the Name | Role | Phone driver table.
    Returns list of {driver_name, role, phone} dicts.
    """
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


def parse_seats(table: list) -> list:
    """
    Parse the Seat Number | Name | Phone | Shop passenger table.
    Returns list of {seat_no, name, phone, shop} dicts.
    """
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


def extract(pdf_path: str) -> dict:
    result = {
        'bus_partner':    None,
        'plate':          None,
        'date':           None,
        'departure_time': None,
        'arrival_time':   None,
        'departure':      None,
        'arrival':        None,
        'driver_details': [],
        'seat_details':   [],
    }

    with pdfplumber.open(pdf_path) as pdf:
        all_tables = [
            t for page in pdf.pages
            for t in (page.extract_tables() or [])
        ]

    for table in all_tables:
        if not table or not table[0]:
            continue

        header_cells = [cell(c).lower() for c in table[0]]

        if 'name' in header_cells and 'role' in header_cells:
            result['driver_details'] = parse_drivers(table)

        elif 'seat number' in header_cells:
            result['seat_details'] = parse_seats(table)

        else:
            flat = ' '.join(cell(c) for row in table for c in row)
            if 'bus partner' in flat.lower():
                result.update(parse_metadata(table))

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
