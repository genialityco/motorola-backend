import { Injectable, Logger } from '@nestjs/common';
import { COLLECTIONS, FirebaseService } from '../../firebase/firebase.service';
import { BotConfigService, interpolate } from '../../bot-config/bot-config.service';
import { WhatsappApiClient } from './whatsapp-api.client';
import { flattenExtraFieldsForInterpolation, getNestedValue, normalizePhoneForWhatsApp } from './utils';

@Injectable()
export class WhatsappNotificationsService {
  private readonly logger = new Logger(WhatsappNotificationsService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
    private readonly api: WhatsappApiClient,
  ) {}

  async notifyStatusChange(
    prevStatus: string,
    newStatus: string,
    ticketData: Record<string, unknown>,
  ): Promise<void> {
    if (!prevStatus || prevStatus === newStatus || newStatus === 'ARCHIVADO') return;

    const rawPhone = (ticketData.reporter as Record<string, unknown>)?.phone as string;
    const phone = rawPhone ? normalizePhoneForWhatsApp(rawPhone) : '';
    if (!phone) return;

    if (newStatus === 'APROBACION_PIEZAS') {
      await this.notifyApprovalPhotos(phone, prevStatus, newStatus, ticketData);
    } else {
      await this.notifyGenericStatusChange(phone, prevStatus, newStatus, ticketData);
    }
  }

  async requestFieldUpdate(
    ticketId: string,
    fieldKey: string,
    fieldLabel: string,
    customMessage?: string,
  ): Promise<void> {
    const db = this.firebase.db;
    const ticketSnap = await db.collection(COLLECTIONS.TICKETS).doc(ticketId).get();
    if (!ticketSnap.exists) throw new Error('Ticket no encontrado');
    const ticket = ticketSnap.data()!;
    const phone: string = ticket.reporter?.phone;
    if (!phone) throw new Error('El ticket no tiene teléfono de reportante');
    const ticketNumber: string = ticket.ticketNumber;

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const template = msgs?.adminRequestUpdate ??
      '📋 El administrador te solicita actualizar el campo *{fieldLabel}* de tu ticket *{ticketNumber}*.\n\nPara actualizar esta información, selecciona la opción *3* (Editar) en el menú.';

    const extraVars = flattenExtraFieldsForInterpolation(
      (ticket.extraFields as Record<string, unknown>) || {},
    );
    let msg = interpolate(template, {
      fieldLabel, ticketNumber, customMessage: customMessage || '', ...extraVars,
    });
    if (customMessage?.trim()) msg += `\n\n_${customMessage.trim()}_`;

    const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(phone);
    await sessionRef.set(
      { state: 'WAITING_ADMIN_REQUESTED_UPDATE', requestedFieldKey: fieldKey, requestedFieldLabel: fieldLabel, requestedTicketId: ticketId },
      { merge: true },
    );
    await this.api.sendMessage(phone, msg);
    await this.api.saveMessage(phone, 'bot', msg);
  }

  private async notifyApprovalPhotos(
    phone: string, prevStatus: string, newStatus: string, ticketData: Record<string, unknown>,
  ): Promise<void> {
    const allFields = await this.botConfig.getFields().catch(() => []);
    const adminPhotoFields = allFields.filter(f => f.type === 'photo' && f.source === 'admin');
    const extraFields = (ticketData.extraFields as Record<string, string | string[]>) || {};
    const approvalPhotos: string[] = [];
    for (const field of adminPhotoFields) {
      const urls = getNestedValue(extraFields, field.key);
      if (Array.isArray(urls)) approvalPhotos.push(...urls);
    }

    const descField = allFields.find(f => f.type !== 'photo' && f.source === 'bot');
    const description = descField ? String(getNestedValue(extraFields, descField.key) || '') : '';

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const extraVars = flattenExtraFieldsForInterpolation(
      (ticketData.extraFields as Record<string, unknown>) || {},
    );
    const msg = approvalPhotos.length > 0
      ? interpolate(
          msgs?.aprobacionPiezasMessage ?? 'Estas son las piezas propuestas para la aprobación de tu solicitud *{ticketNumber}*:',
          { ticketNumber: String(ticketData.ticketNumber), description, ...extraVars },
        )
      : interpolate(
          msgs?.statusChanged ?? 'El estado de su solicitud *{ticketNumber}* ha cambiado de "{prevStatus}" a "{newStatus}".',
          { ticketNumber: String(ticketData.ticketNumber), prevStatus, newStatus, ...extraVars },
        );

    await this.api.saveMessage(phone, 'bot', msg).catch((err) =>
      this.logger.error('Error guardando notificación APROBACION_PIEZAS:', err),
    );
    await this.api.sendMessage(phone, msg).catch((err) =>
      this.logger.error('Error enviando notificación APROBACION_PIEZAS:', err),
    );

    for (const photoUrl of approvalPhotos) {
      await this.api.saveMessage(phone, 'bot', '[imagen]', photoUrl).catch(() => null);
      await this.api.sendImageMessage(phone, photoUrl, 'Pieza propuesta para aprobación').catch(() => null);
    }
  }

  private async notifyGenericStatusChange(
    phone: string, prevStatus: string, newStatus: string, ticketData: Record<string, unknown>,
  ): Promise<void> {
    const msgs = await this.botConfig.getMessages().catch(() => null);
    const extraVars = flattenExtraFieldsForInterpolation(
      (ticketData.extraFields as Record<string, unknown>) || {},
    );
    const msg = interpolate(
      msgs?.statusChanged ?? 'El estado de su solicitud *{ticketNumber}* ha cambiado de "{prevStatus}" a "{newStatus}".',
      { ticketNumber: String(ticketData.ticketNumber), prevStatus, newStatus, ...extraVars },
    );
    await this.api.saveMessage(phone, 'bot', msg).catch(() => null);
    await this.api.sendMessage(phone, msg).catch(() => null);
  }
}
