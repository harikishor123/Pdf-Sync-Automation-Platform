import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from './supabase/supabase.module';
import { PdfSyncModule } from './pdf-sync/pdf-sync.module';
import { MonitorController } from './monitor/monitor.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SupabaseModule,
    PdfSyncModule,
  ],
  controllers: [MonitorController],
})
export class AppModule {}
