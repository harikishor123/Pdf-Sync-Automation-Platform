import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

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
  line_number: string | null;
  bus_partner: string | null;
  vehicle_number: string | null;
  date: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  departure: string | null;
  arrival: string | null;
  driver_details: DriverDetail[];
  seat_details: SeatDetail[];
}

// Absolute path to the Python extraction script, resolved once at module load.
const EXTRACT_SCRIPT = resolve(process.cwd(), 'scripts', 'extract_pdf.py');

@Injectable()
export class PdfParserService {
  private readonly logger = new Logger(PdfParserService.name);

  async parse(buffer: Buffer): Promise<FlixBusParsed> {
    // Write to a temp file so the Python subprocess can read it by path.
    const tmpPath = join(tmpdir(), `flixbus-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    writeFileSync(tmpPath, buffer);
    try {
      return await this.runExtractScript(tmpPath);
    } finally {
      unlinkSync(tmpPath);
    }
  }

  // Call this directly when the file is already on disk (download case).
  // Avoids writing a redundant temp file.
  async parseFile(filePath: string): Promise<FlixBusParsed> {
    return this.runExtractScript(filePath);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private runExtractScript(pdfPath: string): Promise<FlixBusParsed> {
    return new Promise((resolve, reject) => {
      execFile(
        'python3',
        [EXTRACT_SCRIPT, pdfPath],
        { maxBuffer: 10 * 1024 * 1024 }, // 10 MB — generous for large passenger lists
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`pdfplumber extraction failed: ${stderr || error.message}`));
            return;
          }
          if (stderr) {
            this.logger.warn(`[PDF Parser] extract_pdf.py stderr: ${stderr.trim()}`);
          }
          try {
            const parsed = JSON.parse(stdout) as FlixBusParsed;
            resolve(parsed);
          } catch {
            reject(new Error(`Failed to parse JSON from extract_pdf.py: ${stdout.slice(0, 200)}`));
          }
        },
      );
    });
  }
}
