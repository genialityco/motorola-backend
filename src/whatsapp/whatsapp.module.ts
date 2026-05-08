import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { BotConfigModule } from '../bot-config/bot-config.module';

@Module({
  imports: [BotConfigModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, FirebaseAuthGuard],
  exports: [WhatsappService],
})
export class WhatsappModule {}
