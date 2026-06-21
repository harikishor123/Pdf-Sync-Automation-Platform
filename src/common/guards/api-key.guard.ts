import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * Guards all PDF Sync endpoints with a static API key.
 *
 * Configure PDF_SYNC_API_KEY in .env.
 * Pass the key on every request via:
 *   Header:  X-API-Key: <key>
 *   — or —
 *   Header:  Authorization: Bearer <key>
 *
 * If PDF_SYNC_API_KEY is not set the guard allows all requests (dev mode).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedKey = this.configService.get<string>('PDF_SYNC_API_KEY');
    if (!expectedKey) return true; // No key configured — open access

    const request = context.switchToHttp().getRequest<Request>();
    const provided =
      (request.headers['x-api-key'] as string | undefined) ??
      (request.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');

    if (!provided || provided !== expectedKey) {
      throw new UnauthorizedException('Invalid or missing API key.');
    }
    return true;
  }
}
