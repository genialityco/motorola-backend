import { Module } from '@nestjs/common';
import { BotConfigController } from './bot-config.controller';
import { BotConfigService } from './bot-config.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@Module({
  controllers: [BotConfigController],
  providers: [BotConfigService, FirebaseAuthGuard],
  exports: [BotConfigService],
})
export class BotConfigModule {}
