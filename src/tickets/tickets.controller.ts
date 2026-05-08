import {
  Controller,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TicketsService } from './tickets.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

type UploadedFile = {
  buffer: Buffer;
  mimetype: string;
};

@Controller('tickets')
@UseGuards(FirebaseAuthGuard)
export class TicketsController {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly whatsappService: WhatsappService,
  ) {}

  @Post(':id/transition')
  transition(
    @Param('id') ticketId: string,
    @Body() body: { newStatus: string; comments?: string },
    @Req() req: any,
  ) {
    return this.ticketsService.transitionStatus(
      ticketId,
      body.newStatus as any,
      req.user.uid,
      req.user.role || 'user',
      body.comments,
    );
  }

  @Delete(':id/photos/evidence/:index')
  async deleteEvidencePhoto(
    @Param('id') ticketId: string,
    @Param('index') index: string,
  ) {
    const photoIndex = parseInt(index, 10);
    if (isNaN(photoIndex)) throw new BadRequestException('Índice inválido.');

    const { ticketNumber, reporterPhone } =
      await this.ticketsService.deleteEvidencePhoto(ticketId, photoIndex);

    if (reporterPhone) {
      const msg = `Para el ticket número *${ticketNumber}* vuelva adjuntar las evidencias.`;
      await this.whatsappService
        .saveMessage(reporterPhone, 'bot', msg)
        .catch(() => null);
      await this.whatsappService
        .sendMessage(reporterPhone, msg)
        .catch(() => null);
    }

    return { success: true };
  }

  @Delete(':id/photos/repair/:index')
  async deleteRepairPhoto(
    @Param('id') ticketId: string,
    @Param('index') index: string,
  ) {
    const photoIndex = parseInt(index, 10);
    if (isNaN(photoIndex)) throw new BadRequestException('Índice inválido.');
    await this.ticketsService.deleteRepairPhoto(ticketId, photoIndex);
    return { success: true };
  }

  @Patch(':id/observation')
  updateObservation(
    @Param('id') ticketId: string,
    @Body() body: { observations: string },
  ) {
    return this.ticketsService.updateObservation(ticketId, body.observations ?? '');
  }

  @Post(':id/photos/repair')
  @UseInterceptors(FileInterceptor('file'))
  async uploadRepairPhoto(
    @Param('id') ticketId: string,
    @UploadedFile() file: UploadedFile,
  ) {
    if (!file) throw new BadRequestException('No se adjuntó ningún archivo.');

    const photoUrl = await this.ticketsService.uploadToStorage(
      file.buffer,
      file.mimetype || 'image/jpeg',
      `repair_photos/${ticketId}`,
    );

    await this.ticketsService.addRepairPhoto(ticketId, photoUrl);

    return { success: true, photoUrl };
  }
}
