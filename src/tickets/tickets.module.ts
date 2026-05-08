import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [WhatsappModule],
  controllers: [TicketsController],
  providers: [TicketsService, FirebaseAuthGuard],
})
export class TicketsModule {}
