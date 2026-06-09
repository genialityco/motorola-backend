import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { EmailService, EmailConfig } from './email.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('email')
@UseGuards(FirebaseAuthGuard, RolesGuard)
@Roles('admin')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  @Get('config')
  getConfig(): Promise<EmailConfig> {
    return this.emailService.getConfig();
  }

  @Patch('config')
  saveConfig(@Body() config: EmailConfig): Promise<EmailConfig> {
    return this.emailService.updateConfig(config);
  }

  @Get('recipients')
  listRecipientOptions() {
    return this.emailService.listRecipientOptions();
  }
}
