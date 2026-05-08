import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { BotConfigService, BotMessages, TicketField, SystemFieldConfig } from './bot-config.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@Controller('config')
@UseGuards(FirebaseAuthGuard)
export class BotConfigController {
  constructor(private readonly botConfig: BotConfigService) {}

  @Get()
  getAll() {
    return this.botConfig.getAll();
  }

  @Patch('messages')
  updateMessages(@Body() body: Partial<BotMessages>) {
    return this.botConfig.updateMessages(body);
  }

  @Patch('fields')
  updateFields(@Body() body: { fields: TicketField[]; systemFields?: SystemFieldConfig[] }) {
    return this.botConfig.updateFields(body.fields, body.systemFields);
  }
}
