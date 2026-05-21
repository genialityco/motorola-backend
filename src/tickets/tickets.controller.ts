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
import * as XLSX from 'xlsx';
import { TicketsService } from './tickets.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { BotConfigService, interpolate } from '../bot-config/bot-config.service';

type MulterFile = {
  buffer: Buffer;
  mimetype: string;
};

type AuthenticatedRequest = {
  user: { uid: string; role?: string };
};

@Controller('tickets')
@UseGuards(FirebaseAuthGuard)
export class TicketsController {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly whatsappService: WhatsappService,
    private readonly botConfigService: BotConfigService,
  ) {}

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importTickets(@UploadedFile() file: MulterFile) {
    if (!file) throw new BadRequestException('No se adjuntó archivo Excel.');

    let rows: Array<Record<string, string>>;
    try {
      const wb = XLSX.read(file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, {
        defval: '',
        raw: false,
      });
    } catch {
      throw new BadRequestException(
        'No se pudo leer el archivo. Asegúrate de que sea un Excel válido (.xlsx).',
      );
    }

    if (rows.length === 0) {
      throw new BadRequestException('El archivo no contiene filas de datos.');
    }

    const configFields = await this.ticketsService.getConfigFields();
    return this.ticketsService.importTickets(rows, configFields);
  }

  @Post(':id/transition')
  async transition(
    @Param('id') ticketId: string,
    @Body() body: { newStatus: string; comments?: string; scheduledDate?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const { success, message, prevStatus, ticketData } =
      await this.ticketsService.transitionStatus(
        ticketId,
        body.newStatus as any,
        req.user.uid,
        req.user.role ?? 'user',
        body.comments,
        body.scheduledDate,
      );

    await this.whatsappService
      .notifyStatusChange(prevStatus, body.newStatus, ticketData)
      .catch((err) => console.error('Error enviando notificación WhatsApp:', err));

    return { success, message };
  }

  @Delete(':id/photos/:fieldKey/:index')
  async deletePhoto(
    @Param('id') ticketId: string,
    @Param('fieldKey') fieldKey: string,
    @Param('index') index: string,
  ) {
    const photoIndex = parseInt(index, 10);
    if (isNaN(photoIndex)) throw new BadRequestException('Índice inválido.');

    const { ticketNumber, reporterPhone } =
      await this.ticketsService.deletePhotoFromField(ticketId, fieldKey, photoIndex);

    if (reporterPhone) {
      const [messages, fields] = await Promise.all([
        this.botConfigService.getMessages(),
        this.botConfigService.getFields(),
      ]);
      const fieldLabel = fields.find((f) => f.key === fieldKey)?.label ?? fieldKey;
      const msg = interpolate(messages.deletePhotoRequest, { ticketNumber: String(ticketNumber), fieldLabel });
      await this.whatsappService.saveMessage(reporterPhone, 'bot', msg).catch(() => null);
      await this.whatsappService.sendMessage(reporterPhone, msg).catch(() => null);
    }

    return { success: true };
  }

  @Post(':id/photos/:fieldKey')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPhoto(
    @Param('id') ticketId: string,
    @Param('fieldKey') fieldKey: string,
    @UploadedFile() file: MulterFile,
  ) {
    if (!file) throw new BadRequestException('No se adjuntó ningún archivo.');

    const photoUrl = await this.ticketsService.uploadToStorage(
      file.buffer,
      file.mimetype || 'image/jpeg',
      `ticket_photos/${ticketId}/${fieldKey}`,
    );

    await this.ticketsService.addPhotoToField(ticketId, fieldKey, photoUrl);

    return { success: true, photoUrl };
  }

  @Patch(':id/extra/:fieldKey')
  updateExtraField(
    @Param('id') ticketId: string,
    @Param('fieldKey') fieldKey: string,
    @Body() body: { value: string },
  ) {
    return this.ticketsService.updateExtraField(ticketId, fieldKey, body.value ?? '');
  }
}
