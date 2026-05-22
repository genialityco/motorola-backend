import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketsStatusService } from './_internal/tickets-status.service';
import { TicketsImportService } from './_internal/tickets-import.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { BotConfigModule } from '../bot-config/bot-config.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [BotConfigModule, UsersModule],
  controllers: [TicketsController],
  providers: [
    TicketsService,
    TicketsStatusService,
    TicketsImportService,
    FirebaseAuthGuard,
  ],
})
export class TicketsModule {}
