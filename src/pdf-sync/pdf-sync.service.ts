import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "fs";
import { basename, join } from "path";
import { SupabaseService } from "../supabase/supabase.service";
import {
  PdfParserService,
  FlixBusParsed,
  DriverDetail,
  SeatDetail,
} from "./pdf-parser.service";
import { WhatsAppService, DownloadedPdf } from "./whatsapp.service";

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
      supabase.from("flix_trips").select("id", { count: "exact", head: true }),
      supabase
        .from("v_flix_trip_summary")
        .select("line_number, vehicle_number, trip_date, created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    return {
      syncStatus: "idle",
      lastSyncTime: last?.created_at ?? null,
      pdfsImported: count ?? 0,
      lastImportedPdf: last
        ? [last.line_number, last.vehicle_number, last.trip_date]
            .filter(Boolean)
            .join(" · ")
        : null,
      whatsappGroup:
        this.configService.get<string>("PDF_SYNC_WHATSAPP_GROUP") ?? null,
    };
  }

  async getImports(limit = 20) {
    const supabase = this.supabaseService.getClient();
    const { data, error } = await supabase
      .from("v_flix_trip_summary")
      .select(
        "id, line_number, bus_partner, vehicle_number, trip_date, departure, arrival, passenger_count, whatsapp_received_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(Math.min(limit, 100));
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []).map((row) => ({
      id: row.id,
      line_number: row.line_number,
      bus_partner: row.bus_partner,
      vehicle_number: row.vehicle_number,
      date: row.trip_date,
      departure: row.departure,
      arrival: row.arrival,
      passenger_count: row.passenger_count,
      whatsapp_received_at: row.whatsapp_received_at,
      created_at: row.created_at,
    }));
  }

  async checkHealth() {
    const supabase = this.supabaseService.getClient();
    let supabaseOk = false;
    try {
      const { error } = await supabase
        .from("flix_trips")
        .select("id", { count: "exact", head: true });
      supabaseOk = !error;
    } catch {
      /* supabase unreachable */
    }
    return {
      backend: true,
      supabase: supabaseOk,
      whatsappGroupConfigured: !!this.configService.get<string>(
        "PDF_SYNC_WHATSAPP_GROUP",
      ),
      whatsappGroup:
        this.configService.get<string>("PDF_SYNC_WHATSAPP_GROUP") ?? null,
    };
  }

  // ── PDF sync endpoints ─────────────────────────────────────────────────────

  async testParsePdf(file: any) {
    const { buffer, originalname } = this.validateUploadedPdf(file);
    this.logger.log(`[PDF Sync] Test parsing: ${originalname}`);
    const parsed = await this.parser.parse(buffer);
    this.logger.log(
      `[PDF Sync] Test parse done: seats=${parsed.seat_details.length}, vehicle_number=${parsed.vehicle_number ?? "unknown"}`,
    );
    return { pdfName: originalname, pdfHash: this.hashBuffer(buffer), parsed };
  }

  async importUploadedPdf(file: any) {
    const { buffer, originalname } = this.validateUploadedPdf(file);
    this.logger.log(`[PDF Sync] Import received: ${originalname}`);
    return this.importPdfBuffer(buffer, originalname);
  }

  async checkForNewPdfs() {
    this.logger.log("[PDF Sync] Manual sync started.");
    const results: Array<Record<string, any>> = [];
    let scanned = 0;

    const checkpoint = await this.loadCheckpoint();
    if (checkpoint) {
      this.logger.log(`[PDF Sync] Checkpoint: ${checkpoint.toISOString()}`);
    } else {
      this.logger.log("[PDF Sync] No checkpoint — full scan.");
    }

    for await (const download of this.whatsApp.streamPdfs(checkpoint)) {
      scanned++;
      this.logger.log(`[PDF Sync] Processing: ${download.pdfName}`);
      const result = await this.ingestDownloadedPdf(download);
      results.push(result);
    }

    const summary = {
      scanned,
      imported: results.filter((r) => r.status === "imported").length,
      skipped: results.filter((r) => r.status === "duplicate").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    };
    this.logger.log(
      `[PDF Sync] Sync complete. scanned=${summary.scanned}, imported=${summary.imported}, skipped=${summary.skipped}, failed=${summary.failed}`,
    );
    await this.cleanupOldDownloads();
    return summary;
  }

  // ── Core import pipeline ───────────────────────────────────────────────────

  private async loadCheckpoint(): Promise<Date | null> {
    const supabase = this.supabaseService.getClient();
    const { data } = await supabase
      .from('flix_trips')
      .select('whatsapp_received_at')
      .not('whatsapp_received_at', 'is', null)
      .order('whatsapp_received_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data?.whatsapp_received_at) return null;
    // Column is timestamp (no TZ) storing IST — append +05:30 so JS parses it correctly.
    const raw = (data.whatsapp_received_at as string).replace(' ', 'T');
    const d = new Date(raw.endsWith('Z') || raw.includes('+') ? raw : raw + '+05:30');
    return isNaN(d.getTime()) ? null : d;
  }

  private async ingestDownloadedPdf(download: DownloadedPdf) {
    const pdfName = download.pdfName || basename(download.filePath);
    const buffer = readFileSync(download.filePath);
    const captionLineNumber = this.extractLineNumberFromCaption(download.caption);
    return this.importPdfBuffer(buffer, pdfName, download.filePath, captionLineNumber, download.whatsappReceivedAt);
  }

  private extractLineNumberFromCaption(caption?: string): string | null {
    if (!caption) return null;
    // Caption format: "IN2511 TN52" — extract only the line number (3+ digits), not the vehicle number.
    const m = caption.match(/\b([A-Z]{2}\d{3,6})\b/i);
    return m ? m[1].toUpperCase() : null;
  }

  private async importPdfBuffer(
    buffer: Buffer,
    pdfName: string,
    filePath?: string,
    captionLineNumber?: string | null,
    whatsappReceivedAt?: Date,
  ) {
    const pdfHash = this.hashBuffer(buffer);
    const supabase = this.supabaseService.getClient();

    // Layer 2 dedup: hash check (layer 1 is the pre-download filename check)
    const { data: existing } = await supabase
      .from("flix_trips")
      .select("id")
      .eq("pdf_hash", pdfHash)
      .maybeSingle();

    if (existing) {
      this.logger.warn(`[PDF Sync] Duplicate skipped: ${pdfName}`);
      return { status: "duplicate", id: existing.id, pdfName };
    }

    let parsed: FlixBusParsed;
    try {
      parsed = filePath
        ? await this.parser.parseFile(filePath)
        : await this.parser.parse(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[PDF Sync] Parse failed for ${pdfName}: ${message}`);
      return { status: "failed", pdfName, error: message };
    }

    // Insert trip row
    const { data: trip, error: tripError } = await supabase
      .from("flix_trips")
      .insert({
        line_number: captionLineNumber ?? parsed.line_number,
        bus_partner: parsed.bus_partner,
        vehicle_number: parsed.vehicle_number,
        trip_date: parsed.date,
        departure_time: parsed.departure_time,
        arrival_time: parsed.arrival_time,
        departure: parsed.departure,
        arrival: parsed.arrival,
        pdf_hash:             pdfHash,
        whatsapp_received_at: whatsappReceivedAt
          ? whatsappReceivedAt.toLocaleString('sv', { timeZone: 'Asia/Kolkata' })
          : null,
      })
      .select("id")
      .single();

    if (tripError) throw new InternalServerErrorException(tripError.message);

    // Insert drivers and passengers concurrently
    await Promise.all([
      this.insertTripDrivers(trip.id, parsed.driver_details),
      this.insertTripPassengers(trip.id, parsed.seat_details),
    ]);

    // If line_number is still null, look up service_id from the trips table
    // using vehicle_number + trip_date and backfill it.
    const effectiveLineNumber = captionLineNumber ?? parsed.line_number;
    if (!effectiveLineNumber && parsed.vehicle_number && parsed.date) {
      const serviceId = await this.lookupServiceId(parsed.vehicle_number, parsed.date);
      if (serviceId) {
        await supabase.from("flix_trips").update({ line_number: serviceId }).eq("id", trip.id);
        this.logger.log(`[PDF Sync] Filled line_number="${serviceId}" from trips table for ${pdfName}`);
      } else {
        this.logger.warn(`[PDF Sync] No matching service_id found for vehicle=${parsed.vehicle_number} date=${parsed.date}`);
      }
    }

    this.logger.log(`[PDF Sync] Imported ${pdfName} → trip ${trip.id}`);
    return { status: "imported", id: trip.id, pdfName, parsed };
  }

  // ── Bridge table inserts ───────────────────────────────────────────────────

  private async insertTripDrivers(
    tripId: string,
    drivers: DriverDetail[],
  ): Promise<void> {
    if (!drivers.length) return;
    await this.supabaseService
      .getClient()
      .from("flix_trip_drivers")
      .insert(
        drivers.map((d) => ({
          trip_id: tripId,
          driver_name: d.driver_name || null,
          role: d.role || null,
          phone: d.phone || null,
        })),
      );
  }

  private async insertTripPassengers(
    tripId: string,
    seats: SeatDetail[],
  ): Promise<void> {
    if (!seats.length) return;
    await this.supabaseService
      .getClient()
      .from("flix_trip_passengers")
      .insert(
        seats.map((p) => ({
          trip_id: tripId,
          seat_no: p.seat_no || null,
          passenger_name: p.name || null,
          phone: p.phone || null,
          booking_source: p.shop || null,
        })),
      );
  }

  // ── Fleetzen trips lookup ──────────────────────────────────────────────────

  private async lookupServiceId(vehicleNumber: string, tripDate: string): Promise<string | null> {
    try {
      // departure_datetime is timestamptz — filter by IST midnight boundaries for the trip date.
      const nextDate = new Date(tripDate);
      nextDate.setDate(nextDate.getDate() + 1);
      const nextDateStr = nextDate.toISOString().split("T")[0];

      const { data, error } = await this.supabaseService
        .getClient()
        .from("trips")
        .select("service_id")
        .eq("vehicle_number", vehicleNumber)
        .gte("departure_datetime", `${tripDate}T00:00:00+05:30`)
        .lt("departure_datetime", `${nextDateStr}T00:00:00+05:30`)
        .limit(1)
        .maybeSingle();

      if (error) {
        this.logger.warn(`[PDF Sync] trips lookup error: ${error.message}`);
        return null;
      }
      return (data as any)?.service_id ?? null;
    } catch {
      return null;
    }
  }

  // ── Download cleanup ───────────────────────────────────────────────────────

  private async cleanupOldDownloads(): Promise<void> {
    const downloadDir =
      this.configService.get<string>("PDF_SYNC_DOWNLOAD_DIR") ??
      join(process.cwd(), ".runtime", "pdf-sync", "downloads");

    if (!existsSync(downloadDir)) return;

    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - TWO_DAYS_MS;
    let deleted = 0;

    for (const file of readdirSync(downloadDir)) {
      const filePath = join(downloadDir, file);
      try {
        const stat = statSync(filePath);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch {
        /* file already gone */
      }
    }

    if (deleted > 0) {
      this.logger.log(
        `[PDF Sync] Cleaned up ${deleted} download(s) older than 2 days.`,
      );
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private validateUploadedPdf(file: any): {
    buffer: Buffer;
    originalname: string;
  } {
    if (!file?.buffer) {
      throw new BadRequestException(
        'Upload a PDF using multipart field name "file".',
      );
    }
    const originalname = String(file.originalname ?? "passenger-list.pdf");
    const mimetype = String(file.mimetype ?? "");
    if (
      !originalname.toLowerCase().endsWith(".pdf") &&
      mimetype !== "application/pdf"
    ) {
      throw new BadRequestException("Only PDF uploads are supported.");
    }
    return { buffer: file.buffer, originalname };
  }

  private hashBuffer(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
  }
}
