import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { SupabaseService } from '../supabase/supabase.service';
import { PdfParserService, FlixBusParsed, DriverDetail, SeatDetail } from './pdf-parser.service';
import { WhatsAppService, DownloadedPdf } from './whatsapp.service';

@Injectable()
export class PdfSyncService {
  private readonly logger = new Logger(PdfSyncService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly configService: ConfigService,
    private readonly parser: PdfParserService,
    private readonly whatsApp: WhatsAppService,
  ) {}

  // ── Monitor endpoints ──────────────────────────────────────────────────────

  async getSummary() {
    const supabase = this.supabaseService.getClient();
    const [{ count }, { data: last }] = await Promise.all([
      supabase.from('trips').select('id', { count: 'exact', head: true }),
      supabase
        .from('v_trip_summary')
        .select('bus_partner, plate, trip_date, created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    return {
      syncStatus:      'idle',
      lastSyncTime:    last?.created_at ?? null,
      pdfsImported:    count ?? 0,
      lastImportedPdf: last
        ? [last.bus_partner, last.plate, last.trip_date].filter(Boolean).join(' · ')
        : null,
      whatsappGroup: this.configService.get<string>('PDF_SYNC_WHATSAPP_GROUP') ?? null,
    };
  }

  async getImports(limit = 20) {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from('v_trip_summary')
      .select('id, bus_partner, plate, trip_date, departure, arrival, passenger_count, created_at')
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 100));
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []).map((row) => ({
      id:              row.id,
      bus_partner:     row.bus_partner,
      plate:           row.plate,
      date:            row.trip_date,
      departure:       row.departure,
      arrival:         row.arrival,
      passenger_count: row.passenger_count,
      created_at:      row.created_at,
    }));
  }

  async checkHealth() {
    const supabase = this.supabaseService.getClient();
    let supabaseOk = false;
    try {
      const { error } = await supabase
        .from('trips')
        .select('id', { count: 'exact', head: true });
      supabaseOk = !error;
    } catch { /* supabase unreachable */ }
    return {
      backend:                 true,
      supabase:                supabaseOk,
      whatsappGroupConfigured: !!this.configService.get<string>('PDF_SYNC_WHATSAPP_GROUP'),
      whatsappGroup:           this.configService.get<string>('PDF_SYNC_WHATSAPP_GROUP') ?? null,
    };
  }

  // ── PDF sync endpoints ─────────────────────────────────────────────────────

  async testParsePdf(file: any) {
    const { buffer, originalname } = this.validateUploadedPdf(file);
    this.logger.log(`[PDF Sync] Test parsing: ${originalname}`);
    const parsed = await this.parser.parse(buffer);
    this.logger.log(
      `[PDF Sync] Test parse done: seats=${parsed.seat_details.length}, plate=${parsed.plate ?? 'unknown'}`,
    );
    return { pdfName: originalname, pdfHash: this.hashBuffer(buffer), parsed };
  }

  async importUploadedPdf(file: any) {
    const { buffer, originalname } = this.validateUploadedPdf(file);
    this.logger.log(`[PDF Sync] Import received: ${originalname}`);
    return this.importPdfBuffer(buffer, originalname);
  }

  async checkForNewPdfs() {
    this.logger.log('[PDF Sync] Manual sync started.');
    const results: Array<Record<string, any>> = [];
    let scanned = 0;
    let consecutiveDuplicates = 0;
    // Stop only after 2 consecutive duplicates — a single duplicate may mean a
    // prior run was interrupted before finishing, leaving older PDFs unimported.
    const stopAfterConsecutive = 2;

    const knownFilenames = await this.loadKnownFilenames();
    this.logger.log(`[PDF Sync] ${knownFilenames.size} known filename(s) loaded for pre-download check.`);

    for await (const download of this.whatsApp.streamPdfsNewestFirst(
      async (filename) => knownFilenames.has(filename),
    )) {
      scanned++;

      let result: Record<string, any>;
      if (download.skipped) {
        this.logger.warn(`[PDF Sync] Pre-check skipped (known): ${download.pdfName}`);
        result = { status: 'duplicate', pdfName: download.pdfName };
      } else {
        this.logger.log(`[PDF Sync] Processing: ${download.pdfName}`);
        result = await this.ingestDownloadedPdf(download);
      }

      results.push(result);
      if (result.status === 'duplicate') {
        consecutiveDuplicates++;
        if (consecutiveDuplicates >= stopAfterConsecutive) {
          this.logger.log(`[PDF Sync] ${consecutiveDuplicates} consecutive duplicates — stopping scan.`);
          break;
        }
        this.logger.log('[PDF Sync] Duplicate — continuing to check older PDFs.');
      } else {
        consecutiveDuplicates = 0;
      }
    }

    const summary = {
      scanned,
      imported: results.filter((r) => r.status === 'imported').length,
      skipped:  results.filter((r) => r.status === 'duplicate').length,
      failed:   results.filter((r) => r.status === 'failed').length,
      results,
    };
    this.logger.log(
      `[PDF Sync] Sync complete. scanned=${summary.scanned}, imported=${summary.imported}, skipped=${summary.skipped}, failed=${summary.failed}`,
    );
    return summary;
  }

  // ── Core import pipeline ───────────────────────────────────────────────────

  private async loadKnownFilenames(): Promise<Set<string>> {
    const supabase = this.supabaseService.getClient();
    const { data } = await supabase
      .from('trips')
      .select('source_filename')
      .not('source_filename', 'is', null);
    return new Set((data ?? []).map((r) => r.source_filename).filter(Boolean));
  }

  private async ingestDownloadedPdf(download: DownloadedPdf) {
    const pdfName = download.pdfName || basename(download.filePath);
    const buffer  = readFileSync(download.filePath);
    return this.importPdfBuffer(buffer, pdfName, download.sourceFilename, download.filePath);
  }

  private async importPdfBuffer(
    buffer: Buffer,
    pdfName: string,
    sourceFilename?: string,
    filePath?: string,
  ) {
    const pdfHash  = this.hashBuffer(buffer);
    const supabase = this.supabaseService.getClient();

    // Layer 2 dedup: hash check (layer 1 is the pre-download filename check)
    const { data: existing } = await supabase
      .from('trips')
      .select('id')
      .eq('pdf_hash', pdfHash)
      .maybeSingle();

    if (existing) {
      this.logger.warn(`[PDF Sync] Duplicate skipped: ${pdfName}`);
      return { status: 'duplicate', id: existing.id, pdfName };
    }

    let parsed: FlixBusParsed;
    try {
      parsed = filePath
        ? await this.parser.parseFile(filePath)
        : await this.parser.parse(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[PDF Sync] Parse failed for ${pdfName}: ${message}`);
      return { status: 'failed', pdfName, error: message };
    }

    // Upsert all dimension rows and collect their IDs
    const [busPartnerId, routeId, vehicleId] = await Promise.all([
      parsed.bus_partner                        ? this.upsertBusPartner(parsed.bus_partner) : null,
      parsed.departure && parsed.arrival        ? this.upsertRoute(parsed.departure, parsed.arrival) : null,
      parsed.plate                              ? this.upsertVehicle(parsed.plate) : null,
    ]);

    // Insert the trip row
    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .insert({
        route_id:        routeId        ?? null,
        vehicle_id:      vehicleId      ?? null,
        bus_partner_id:  busPartnerId   ?? null,
        trip_date:       parsed.date,
        departure_time:  parsed.departure_time,
        arrival_time:    parsed.arrival_time,
        pdf_hash:        pdfHash,
        source_filename: sourceFilename ?? null,
      })
      .select('id')
      .single();

    if (tripError) throw new InternalServerErrorException(tripError.message);

    // Insert drivers and passengers (independent — run concurrently)
    await Promise.all([
      this.insertTripDrivers(trip.id, parsed.driver_details),
      this.insertTripPassengers(trip.id, parsed.seat_details),
    ]);

    this.logger.log(`[PDF Sync] Imported ${pdfName} → trip ${trip.id}`);
    return { status: 'imported', id: trip.id, pdfName, parsed };
  }

  // ── Dimension upserts ──────────────────────────────────────────────────────

  private async upsertBusPartner(name: string): Promise<string> {
    const { data } = await this.supabaseService.getClient()
      .from('bus_partners')
      .upsert({ name }, { onConflict: 'name' })
      .select('id')
      .single();
    return data!.id;
  }

  private async upsertRoute(departure: string, arrival: string): Promise<string> {
    const { data } = await this.supabaseService.getClient()
      .from('routes')
      .upsert({ departure, arrival }, { onConflict: 'departure,arrival' })
      .select('id')
      .single();
    return data!.id;
  }

  private async upsertVehicle(plate: string): Promise<string> {
    const { data } = await this.supabaseService.getClient()
      .from('vehicles')
      .upsert({ plate }, { onConflict: 'plate' })
      .select('id')
      .single();
    return data!.id;
  }

  private async upsertDriver(name: string, phone: string | null): Promise<string> {
    const { data } = await this.supabaseService.getClient()
      .from('drivers')
      .upsert({ name, phone: phone || null }, { onConflict: 'name,phone' })
      .select('id')
      .single();
    return data!.id;
  }

  private async upsertBookingSource(name: string): Promise<string> {
    const { data } = await this.supabaseService.getClient()
      .from('booking_sources')
      .upsert({ name }, { onConflict: 'name' })
      .select('id')
      .single();
    return data!.id;
  }

  // ── Bridge table inserts ───────────────────────────────────────────────────

  private async insertTripDrivers(tripId: string, drivers: DriverDetail[]): Promise<void> {
    if (!drivers.length) return;
    const rows = await Promise.all(
      drivers.map(async (d) => ({
        trip_id:   tripId,
        driver_id: await this.upsertDriver(d.driver_name, d.phone || null),
        role:      d.role || null,
      })),
    );
    await this.supabaseService.getClient().from('trip_drivers').insert(rows);
  }

  private async insertTripPassengers(tripId: string, seats: SeatDetail[]): Promise<void> {
    if (!seats.length) return;
    const rows = await Promise.all(
      seats.map(async (p) => ({
        trip_id:           tripId,
        seat_no:           p.seat_no   || null,
        passenger_name:    p.name      || null,
        phone:             p.phone     || null,
        booking_source_id: p.shop ? await this.upsertBookingSource(p.shop) : null,
      })),
    );
    await this.supabaseService.getClient().from('trip_passengers').insert(rows);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private validateUploadedPdf(file: any): { buffer: Buffer; originalname: string } {
    if (!file?.buffer) {
      throw new BadRequestException('Upload a PDF using multipart field name "file".');
    }
    const originalname = String(file.originalname ?? 'passenger-list.pdf');
    const mimetype     = String(file.mimetype ?? '');
    if (!originalname.toLowerCase().endsWith('.pdf') && mimetype !== 'application/pdf') {
      throw new BadRequestException('Only PDF uploads are supported.');
    }
    return { buffer: file.buffer, originalname };
  }

  private hashBuffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }
}
