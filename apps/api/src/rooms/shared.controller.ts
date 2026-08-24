import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient, verifyToken } from '@clerk/backend';
import type { Request, Response } from 'express';
import { RoomsService } from './rooms.service';

@Controller('shared')
export class SharedController {
  constructor(
    private readonly rooms: RoomsService,
    private readonly config: ConfigService,
  ) {}

  @Get(':token')
  async view(@Param('token') token: string, @Req() request: Request) {
    return this.rooms.sharedView(token, await this.viewer(request));
  }

  @Get(':token/documents/:documentId')
  async document(
    @Param('token') token: string,
    @Param('documentId') documentId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const { document, stream } = await this.rooms.sharedDocumentStream(
      token,
      documentId,
      await this.viewer(request),
    );
    response.setHeader('Content-Type', document.mimeType);
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(document.name)}`,
    );
    response.setHeader('Content-Length', document.size.toString());
    stream.pipe(response);
  }

  private async viewer(request: Request) {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : null;
    const secretKey = this.config.get<string>('CLERK_SECRET_KEY');
    if (!token || !secretKey) return undefined;
    try {
      const payload = await verifyToken(token, {
        secretKey,
        authorizedParties: [
          this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000',
        ],
      });
      const user = await createClerkClient({ secretKey }).users.getUser(
        payload.sub,
      );
      return {
        userId: payload.sub,
        emails: user.emailAddresses.map((entry) =>
          entry.emailAddress.toLowerCase(),
        ),
      };
    } catch {
      return undefined;
    }
  }
}
