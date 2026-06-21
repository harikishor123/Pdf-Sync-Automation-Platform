import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from '../supabase/supabase.module';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { PdfSyncController } from './pdf-sync.controller';
import { PdfSyncService } from './pdf-sync.service';
import { PdfParserService } from './pdf-parser.service';
import { WhatsAppService } from './whatsapp.service';
import { PdfSyncSchedulerService } from './pdf-sync-scheduler.service';

@Module({
  imports: [ConfigModule, SupabaseModule],
  controllers: [PdfSyncController],
  providers: [
    ApiKeyGuard,
    PdfSyncService,
    PdfParserService,
    WhatsAppService,
    PdfSyncSchedulerService,
  ],
})
export class PdfSyncModule {}
