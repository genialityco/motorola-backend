import { Module } from '@nestjs/common';
import { HostsController } from './hosts.controller';
import { HostsService } from './hosts.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@Module({
  controllers: [HostsController],
  providers: [HostsService, FirebaseAuthGuard],
  exports: [HostsService],
})
export class HostsModule {}
