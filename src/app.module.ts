import { Module } from '@nestjs/common';
import { FirebaseModule } from './firebase/firebase.module';
import { TicketsModule } from './tickets/tickets.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { HostsModule } from './hosts/hosts.module';
import { BotConfigModule } from './bot-config/bot-config.module';
import { UsersModule } from './users/users.module';
import { EmailModule } from './email/email.module';

@Module({
  imports: [FirebaseModule, EmailModule, TicketsModule, WhatsappModule, HostsModule, BotConfigModule, UsersModule],
})
export class AppModule {}
