import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyToken } from '@clerk/backend';

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      userId?: string;
    }>();
    const bypassUser = this.config.get<string>('AUTH_BYPASS_USER_ID');
    if (bypassUser && this.config.get('NODE_ENV') !== 'production') {
      request.userId = bypassUser;
      return true;
    }

    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;
    const secretKey = this.config.get<string>('CLERK_SECRET_KEY');
    if (!token || !secretKey)
      throw new UnauthorizedException('Sign in required');

    try {
      const payload = await verifyToken(token, {
        secretKey,
        authorizedParties: [
          this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000',
        ],
      });
      request.userId = payload.sub;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }
  }
}
