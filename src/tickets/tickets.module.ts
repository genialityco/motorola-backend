import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { BotConfigModule } from '../bot-config/bot-config.module';

@Module({
  imports: [BotConfigModule],
  controllers: [TicketsController],
  providers: [TicketsService, FirebaseAuthGuard],
})
export class TicketsModule {}
