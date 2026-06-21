import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PdfSyncService } from './pdf-sync.service';

@Injectable()
export class PdfSyncSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PdfSyncSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly pdfSync: PdfSyncService,
  ) {}

  onModuleInit() {
    if (
      this.configService.get<string>('PDF_SYNC_SCHEDULER_ENABLED') !== 'true'
    ) {
      this.logger.log(
        'PDF Sync scheduler disabled. Set PDF_SYNC_SCHEDULER_ENABLED=true to enable.',
      );
      return;
    }
    this.scheduleNextRun();
  }

  onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNextRun() {
    const delay = this.delayUntilNextRun();
    this.timer = setTimeout(async () => {
      try {
        await this.pdfSync.checkForNewPdfs();
      } catch (error) {
        this.logger.error('Scheduled PDF sync failed', error as Error);
      } finally {
        this.scheduleNextRun();
      }
    }, delay);
    this.logger.log(
      `Next PDF Sync run scheduled in ${Math.round(delay / 60000)} minutes.`,
    );
  }

  private delayUntilNextRun(): number {
    const configured =
      this.configService.get<string>('PDF_SYNC_DAILY_TIME') ?? '03:00';
    const [hour, minute] = configured.split(':').map((part) => Number(part));
    const next = new Date();
    next.setHours(
      Number.isFinite(hour) ? hour : 3,
      Number.isFinite(minute) ? minute : 0,
      0,
      0,
    );
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    return next.getTime() - Date.now();
  }
}
