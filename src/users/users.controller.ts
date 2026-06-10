import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  UsersService,
  CreateGestorDto,
  UpdateGestorDto,
} from './users.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

type AuthenticatedRequest = { user: { uid: string; role?: string } };

@Controller('users')
@UseGuards(FirebaseAuthGuard, RolesGuard)
@Roles('admin')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Override class-level @Roles('admin') — only requires valid auth token + setup key
  @Post('promote-admin')
  @Roles()
  async promoteAdmin(
    @Req() req: AuthenticatedRequest,
    @Body() body: { setupKey: string },
  ) {
    await this.usersService.promoteToAdmin(req.user.uid, body.setupKey ?? '');
    return { success: true, message: 'Tu cuenta fue promovida a administrador. Recarga la página para continuar.' };
  }

  @Post()
  createGestor(@Body() dto: CreateGestorDto) {
    return this.usersService.createGestor(dto);
  }

  @Get()
  listUsers() {
    return this.usersService.listUsers();
  }

  @Post('recompute-assignments')
  recomputeAssignments() {
    return this.usersService.recomputeAllTicketAssignments();
  }

  @Get(':uid')
  getUser(@Param('uid') uid: string) {
    return this.usersService.getUser(uid);
  }

  @Patch(':uid')
  async updateUser(@Param('uid') uid: string, @Body() dto: UpdateGestorDto) {
    await this.usersService.updateUser(uid, dto);
    return { success: true };
  }

  @Delete(':uid')
  async deleteUser(@Param('uid') uid: string) {
    await this.usersService.deleteUser(uid);
    return { success: true };
  }
}
