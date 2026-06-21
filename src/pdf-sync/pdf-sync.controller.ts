import {
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { PdfSyncService } from './pdf-sync.service';

@Controller('pdf-sync')
@UseGuards(ApiKeyGuard)
export class PdfSyncController {
  constructor(private readonly service: PdfSyncService) {}

  // ── Monitor ────────────────────────────────────────────────────────────────

  @Get('summary')
  getSummary() {
    return this.service.getSummary();
  }

  @Get('imports')
  getImports(@Query('limit') limit?: string) {
    return this.service.getImports(Number(limit) || 20);
  }

  @Get('health')
  checkHealth() {
    return this.service.checkHealth();
  }

  // ── Pipeline ───────────────────────────────────────────────────────────────

  @Post('test-parse')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  testParse(@UploadedFile() file: any) {
    return this.service.testParsePdf(file);
  }

  @Post('import-pdf')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  importPdf(@UploadedFile() file: any) {
    return this.service.importUploadedPdf(file);
  }

  @Post('sync')
  runSync() {
    return this.service.checkForNewPdfs();
  }
}
