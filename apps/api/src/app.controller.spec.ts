import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('describes the deployed service', () => {
      expect(appController.getServiceInfo()).toEqual({
        service: 'Vaultroom API',
        status: 'ok',
        frontend: 'https://vaultroom-ruby.vercel.app',
        health: '/health',
      });
    });

    it('exposes a stable health response', () => {
      expect(appController.getHealth()).toEqual({ status: 'ok' });
    });
  });
});
