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
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as XLSX from 'xlsx';
import { TicketsService } from './tickets.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { EmailService } from '../email/email.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { BotConfigService, interpolate } from '../bot-config/bot-config.service';

type MulterFile = {
  buffer: Buffer;
  mimetype: string;
};

type AuthenticatedRequest = {
  user: { uid: string; role?: string; email?: string };
};

@Controller('tickets')
@UseGuards(FirebaseAuthGuard, RolesGuard)
export class TicketsController {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly whatsappService: WhatsappService,
    private readonly emailService: EmailService,
    private readonly botConfigService: BotConfigService,
  ) {}

  @Get('admins')
  @Roles('admin', 'gestor')
  listAdmins() {
    return this.emailService.listAdmins();
  }

  @Patch(':id/notify-admins')
  @Roles('admin', 'gestor')
  updateNotifyAdmins(
    @Param('id') ticketId: string,
    @Body() body: { emails: string[] },
  ) {
    return this.ticketsService.updateNotifyAdmins(ticketId, body.emails ?? []);
  }

  @Post('import')
  @Roles('admin')
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
        req.user.email,
      );

    await this.whatsappService
      .notifyStatusChange(prevStatus, body.newStatus, ticketData)
      .catch((err) => console.error('Error enviando notificación WhatsApp:', err));

    await this.emailService
      .notifyStatusChanged({ ...ticketData, id: ticketId }, prevStatus, body.newStatus)
      .catch((err) => console.error('Error enviando email de cambio de estado:', err));

    return { success, message };
  }

  @Post(':id/observations')
  @Roles('admin', 'gestor')
  addObservation(
    @Param('id') ticketId: string,
    @Body() body: { text: string },
    @Req() req: AuthenticatedRequest,
  ) {
    return this.ticketsService.addObservation(
      ticketId,
      req.user.uid,
      req.user.role ?? 'user',
      body.text ?? '',
    );
  }

  @Delete(':id/photos/:fieldKey/:index')
  @Roles('admin')
  async deletePhoto(
    @Param('id') ticketId: string,
    @Param('fieldKey') fieldKey: string,
    @Param('index') index: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const photoIndex = parseInt(index, 10);
    if (isNaN(photoIndex)) throw new BadRequestException('Índice inválido.');

    const fieldLabel = (await this.botConfigService.getFields().catch(() => []))
      .find((f) => f.key === fieldKey)?.label ?? fieldKey;

    const { ticketNumber, reporterPhone } =
      await this.ticketsService.deletePhotoFromField(ticketId, fieldKey, photoIndex, {
        actor: { uid: req.user.uid, role: req.user.role ?? 'admin', email: req.user.email },
        fieldLabel,
      });

    if (reporterPhone) {
      const messages = await this.botConfigService.getMessages();
      const msg = interpolate(messages.deletePhotoRequest, { ticketNumber: String(ticketNumber), fieldLabel });
      await this.whatsappService.saveMessage(reporterPhone, 'bot', msg).catch(() => null);
      await this.whatsappService.sendMessage(reporterPhone, msg).catch(() => null);
    }

    return { success: true };
  }

  @Post(':id/photos/:fieldKey')
  @Roles('admin', 'gestor')
  @UseInterceptors(FileInterceptor('file'))
  async uploadPhoto(
    @Param('id') ticketId: string,
    @Param('fieldKey') fieldKey: string,
    @UploadedFile() file: MulterFile,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!file) throw new BadRequestException('No se adjuntó ningún archivo.');

    const photoUrl = await this.ticketsService.uploadToStorage(
      file.buffer,
      file.mimetype || 'image/jpeg',
      `ticket_photos/${ticketId}/${fieldKey}`,
    );

    const fieldLabel = (await this.botConfigService.getFields().catch(() => []))
      .find((f) => f.key === fieldKey)?.label ?? fieldKey;

    await this.ticketsService.addPhotoToField(ticketId, fieldKey, photoUrl, {
      actor: { uid: req.user.uid, role: req.user.role ?? 'admin', email: req.user.email },
      fieldLabel,
    });

    return { success: true, photoUrl };
  }

  @Patch(':id/extra/:fieldKey')
  @Roles('admin')
  async updateExtraField(
    @Param('id') ticketId: string,
    @Param('fieldKey') fieldKey: string,
    @Body() body: { value: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const fieldLabel = (await this.botConfigService.getFields().catch(() => []))
      .find((f) => f.key === fieldKey)?.label ?? fieldKey;

    return this.ticketsService.updateExtraField(ticketId, fieldKey, body.value ?? '', {
      actor: { uid: req.user.uid, role: req.user.role ?? 'admin', email: req.user.email },
      fieldLabel,
    });
  }
}
