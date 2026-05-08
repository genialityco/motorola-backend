import { Controller, Get, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { HostsService } from './hosts.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@Controller('hosts')
@UseGuards(FirebaseAuthGuard)
export class HostsController {
  constructor(private readonly hostsService: HostsService) {}

  @Get()
  getAll() {
    return this.hostsService.getAll();
  }

  @Patch(':phone')
  update(
    @Param('phone') phone: string,
    @Body() body: { nombre: string },
  ) {
    return this.hostsService.update(phone, body.nombre);
  }
}
