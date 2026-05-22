import { Module } from '@nestjs/common';
import { FirebaseModule } from './firebase/firebase.module';
import { TicketsModule } from './tickets/tickets.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { HostsModule } from './hosts/hosts.module';
import { BotConfigModule } from './bot-config/bot-config.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [FirebaseModule, TicketsModule, WhatsappModule, HostsModule, BotConfigModule, UsersModule],
})
export class AppModule {}
