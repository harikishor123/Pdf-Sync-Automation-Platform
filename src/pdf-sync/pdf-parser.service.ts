import { Injectable } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

// pdf-parse ships no TypeScript declarations; the require is intentional.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;

export interface DriverDetail {
  driver_name: string;
  role: string | null;
  phone: string;
}

export interface SeatDetail {
  seat_no: string;
  name: string;
  phone: string;
  shop: string | null;
}

export interface FlixBusParsed {
  bus_partner: string | null;
  plate: string | null;
  date: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  departure: string | null;
  arrival: string | null;
  driver_details: DriverDetail[];
  seat_details: SeatDetail[];
}

@Injectable()
export class PdfParserService {
  private readonly debugEnabled = process.env.PDF_SYNC_DEBUG === 'true';

  async parse(buffer: Buffer): Promise<FlixBusParsed> {
    const result = await pdfParse(buffer);
    const rawText = result.text ?? '';
    const normalizedText = this.normalizeText(rawText);
    if (this.debugEnabled) this.saveDebug(rawText, normalizedText);
    return this.parseText(normalizedText);
  }

  // ── Preprocessing ──────────────────────────────────────────────────────────

  private normalizeText(raw: string): string {
    let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Phase 1 – Insert newlines before line-level field labels.
    // Longer phrases must be processed before their prefixes (e.g. "Departure Time"
    // before "Departure") to avoid double-splitting.
    for (const label of [
      'Departure Time',
      'Arrival Time',
      'Date',
      'Departure',
      'Arrival',
    ]) {
      text = text.replace(
        new RegExp(`(?<=[^\\s])(${label})`, 'g'),
        '\n$1',
      );
    }

    // Phase 2 – Insert spaces before column-header keywords so that
    // "NameRolePhone" → "Name Role Phone"  and
    // "Seat NumberNamePhoneShop" → "Seat Number Name Phone Shop".
    // "Phone" uses a negative lookahead to avoid splitting the shop name "PhonePe".
    for (const pattern of ['Name', 'Role', 'Phone(?!Pe)', 'Shop']) {
      text = text.replace(new RegExp(`(?<=\\S)(${pattern})`, 'g'), ' $1');
    }

    // Phase 3 – Insert space between seat token and passenger name.
    // Seat token = \d{1,2}[A-Z] (e.g. 1D, 12A).  Name starts uppercase.
    text = text.replace(/^(\d{1,2}[A-Z])([A-Z])/gm, '$1 $2');

    // Phase 4 – Insert space before Indian phone numbers that are
    // immediately preceded by a non-whitespace character.
    text = text.replace(
      /([^\s])((?:\+?91[-\s]?)?[6-9]\d{9})/g,
      '$1 $2',
    );

    // Phase 5 – Insert space before booking-source names that immediately
    // follow a digit (the last digit of the phone number).
    const shops = [
      'Redbus', 'PayTM', 'Paytm', 'AbhiBus', 'IntrCity',
      'Offline', 'Agent', 'PhonePe', 'MakeMyTrip', 'Flix',
    ];
    for (const shop of shops) {
      text = text.replace(new RegExp(`(\\d)(${shop})`, 'gi'), '$1 $2');
    }

    return text;
  }

  private saveDebug(rawText: string, normalizedText: string): void {
    try {
      const dir = resolve(process.cwd(), 'debug');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'raw-text.txt'),        rawText,        'utf8');
      writeFileSync(join(dir, 'normalized-text.txt'), normalizedText, 'utf8');
    } catch { /* never fail a parse because of debug I/O */ }
  }

  private parseText(text: string): FlixBusParsed {
    const normalized = text.replace(/\r/g, '\n').replace(/\t/g, ' ');
    const lines = normalized
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return {
      bus_partner:    this.field(lines, /Bus\s+Partner\s*:\s*(.+)/i),
      plate:          this.field(lines, /\bPlate\s+([A-Z0-9]+)/i),
      date:           this.parseDate(lines),
      departure_time: this.parseTime(lines, 'Departure Time'),
      arrival_time:   this.parseTime(lines, 'Arrival Time'),
      departure:      this.parseDepartureCity(lines),
      arrival:        this.parseArrivalCity(lines),
      driver_details: this.parseDrivers(lines),
      seat_details:   this.parseSeats(lines),
    };
  }

  // ── Field helpers ──────────────────────────────────────────────────────────

  private field(lines: string[], pattern: RegExp): string | null {
    for (const line of lines) {
      const m = line.match(pattern);
      if (m?.[1]) return m[1].trim();
    }
    return null;
  }

  private parseDate(lines: string[]): string | null {
    for (const line of lines) {
      const m = line.match(/\bDate\s+(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})/i);
      if (m) return this.toIsoDate(m[1]);
    }
    return null;
  }

  private parseTime(lines: string[], label: string): string | null {
    const escaped = label.replace(/\s+/g, '\\s+');
    const re = new RegExp(`\\b${escaped}\\s+(\\d{1,2}:\\d{2})`, 'i');
    for (const line of lines) {
      const m = line.match(re);
      if (!m) continue;
      const [hh, mm] = m[1].split(':');
      return `${hh.padStart(2, '0')}:${mm}:00`;
    }
    return null;
  }

  // Matches "Departure Pune" or "Departure Pune Arrival Hyderabad".
  // Negative lookahead prevents matching "Departure Time".
  private parseDepartureCity(lines: string[]): string | null {
    for (const line of lines) {
      const m = line.match(
        /\bDeparture\s+(?!Time\b)([A-Za-z][A-Za-z\s]*?)(?=\s+Arrival\b|\s*$)/i,
      );
      if (m?.[1]) return m[1].trim();
    }
    return null;
  }

  // Matches "Arrival Hyderabad". Negative lookahead prevents "Arrival Time".
  private parseArrivalCity(lines: string[]): string | null {
    for (const line of lines) {
      const m = line.match(/\bArrival\s+(?!Time\b)([A-Za-z][A-Za-z\s]+)/i);
      if (m?.[1]) return m[1].trim();
    }
    return null;
  }

  // ── Section parsers ────────────────────────────────────────────────────────

  // Driver section is bounded by a "Name | Role | Phone" header and ends when
  // the "Seat Number" header appears. Role is the last token before the phone;
  // no fixed role vocabulary — any value is accepted.
  private parseDrivers(lines: string[]): DriverDetail[] {
    const drivers: DriverDetail[] = [];
    const driverHeader  = /\bname\b.+\brole\b.+\bphone\b/i;
    const passengerHeader = /\bseat\b/i;

    let inSection = false;
    for (const line of lines) {
      if (driverHeader.test(line))    { inSection = true;  continue; }
      if (passengerHeader.test(line)) { inSection = false; continue; }
      if (!inSection) continue;

      const phoneMatch = line.match(/(?:\+?91[-\s]?)?[6-9]\d{9}\b/);
      if (!phoneMatch) continue;

      const phone = phoneMatch[0].replace(/[\s-]/g, '');
      const remainder = line
        .replace(phoneMatch[0], '')
        .replace(/[|,:\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const parts = remainder.split(/\s+/).filter(Boolean);

      if (parts.length === 0) continue;
      if (parts.length === 1) {
        drivers.push({ driver_name: parts[0], role: null, phone });
        continue;
      }
      const role = parts[parts.length - 1];
      const driver_name = parts.slice(0, -1).join(' ').trim();
      if (!driver_name || /^\d+$/.test(driver_name)) continue;
      drivers.push({ driver_name, role, phone });
    }
    return drivers;
  }

  // Passenger section starts at the "Seat Number" header. Each data row must
  // begin with a seat token (e.g. 1A, 2D, 12B).
  private parseSeats(lines: string[]): SeatDetail[] {
    const seats: SeatDetail[] = [];
    const shops = [
      'Redbus', 'PayTM', 'Paytm', 'AbhiBus', 'IntrCity',
      'Offline', 'Agent', 'PhonePe', 'MakeMyTrip', 'Flix',
    ];
    const seatHeader = /\bseat\b/i;
    const seatToken  = /^([A-Z]?\d{1,2}[A-Z]?)\s+/i;

    let inSection = false;
    for (const line of lines) {
      if (seatHeader.test(line)) { inSection = true; continue; }
      if (!inSection) continue;

      const seatMatch = line.match(seatToken);
      if (!seatMatch) continue;

      const seat_no = seatMatch[1];
      const rest    = line.slice(seatMatch[0].length);

      const phoneMatch = rest.match(/(?:\+?91[-\s]?)?[6-9]\d{9}\b/);
      if (!phoneMatch) continue;

      const phone      = phoneMatch[0];
      const name       = rest.slice(0, phoneMatch.index ?? 0).replace(/[|,]/g, ' ').trim();
      const afterPhone = rest.slice((phoneMatch.index ?? 0) + phoneMatch[0].length).trim();
      const shop       = shops.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(afterPhone)) ?? null;

      if (!name) continue;
      seats.push({ seat_no, name, phone, shop });
    }
    return seats;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private toIsoDate(value: string): string | null {
    const parts = value.split(/[.\/-]/).map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
    const [a, b, c] = parts;
    const year  = a > 1000 ? a : c > 1000 ? c : null;
    if (!year) return null;
    const month = a > 1000 ? b : b;
    const day   = a > 1000 ? c : a;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
}
