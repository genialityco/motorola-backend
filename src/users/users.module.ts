import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { GestorAssignmentsService } from './_internal/gestor-assignments.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@Module({
  controllers: [UsersController],
  providers: [UsersService, GestorAssignmentsService, FirebaseAuthGuard],
  exports: [UsersService],
})
export class UsersModule {}
