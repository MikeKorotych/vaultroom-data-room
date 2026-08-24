import { Module } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { SharedController } from './shared.controller';

@Module({
  controllers: [RoomsController, SharedController],
  providers: [RoomsService, ClerkAuthGuard],
})
export class RoomsModule {}
