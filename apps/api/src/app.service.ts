import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getServiceInfo() {
    return {
      service: 'Vaultroom API',
      status: 'ok',
      frontend: 'https://vaultroom-ruby.vercel.app',
      health: '/health',
    };
  }

  getHealth() {
    return { status: 'ok' };
  }
}
