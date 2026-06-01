import { Injectable, Logger } from '@nestjs/common';
import { BotConfigService, interpolate } from '../bot-config/bot-config.service';
import { COLLECTIONS, FirebaseService } from '../firebase/firebase.service';
import { WhatsappFlowOrchestratorService } from './_internal/whatsapp-flow-orchestrator.service';
import { WhatsappSessionService } from './_internal/whatsapp-session.service';
import { WhatsappFormattingService } from './_internal/whatsapp-formatting.service';
import { WhatsappMediaService } from './_internal/whatsapp-media.service';
import { getNestedValue } from './_internal/flows/helpers';


interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: { messages?: unknown[] };
    }>;
  }>;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
    private readonly session: WhatsappSessionService,
    private readonly formatting: WhatsappFormattingService,
    private readonly media: WhatsappMediaService,
    private readonly orchestrator: WhatsappFlowOrchestratorService,
  ) {}

  /**
   * Notifica al usuario sobre cambios de estado de un ticket
   */
  async notifyStatusChange(
    prevStatus: string,
    newStatus: string,
    ticketData: Record<string, unknown>,
  ): Promise<void> {
    if (!prevStatus || prevStatus === newStatus || newStatus === 'ARCHIVADO') return;

    const rawPhone = (ticketData.reporter as Record<string, unknown>)?.phone as string;
    const phone = rawPhone ? this.media.normalizePhoneForWhatsApp(rawPhone) : '';
    if (!phone) return;

    if (newStatus === 'APROBACION_PIEZAS') {
      await this.notifyApprovalPhotos(phone, ticketData);
    } else {
      await this.notifyStatusChanged(phone, ticketData, prevStatus, newStatus);
    }
  }

  /**
   * Solicita al usuario actualizar un campo específico del ticket
   */
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

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const extraVars = this.formatting.flattenExtraFieldsForInterpolation(
      (ticket.extraFields as Record<string, unknown>) || {},
    );

    const template =
      msgs?.adminRequestUpdate ??
      '📋 El administrador te solicita actualizar el campo *{fieldLabel}* de tu ticket *{ticketNumber}*.\n\nPara actualizar esta información, selecciona la opción *3* (Editar) en el menú.';

    let msg = interpolate(template, {
      fieldLabel,
      ticketNumber: ticket.ticketNumber as string,
      customMessage: customMessage || '',
      ...extraVars,
    });

    if (customMessage?.trim()) {
      msg += `\n\n_${customMessage.trim()}_`;
    }

    const sessionRef = db.collection(COLLECTIONS.SESSIONS).doc(phone);
    await sessionRef.set(
      {
        state: 'WAITING_ADMIN_REQUESTED_UPDATE',
        requestedFieldKey: fieldKey,
        requestedFieldLabel: fieldLabel,
        requestedTicketId: ticketId,
      },
      { merge: true },
    );

    await this.session.sendAdminMessage(phone, msg);
  }

  /**
   * Procesa un mensaje entrante del webhook de WhatsApp
   */
  async processMessage(payload: WhatsAppWebhookPayload, onResponse?: (msg: string) => void): Promise<void> {
    await this.orchestrator.processMessage(payload, onResponse);
  }

  /**
   * Verifica el webhook de WhatsApp (challenge)
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return challenge;
    }
    return null;
  }

  /**
   * Obtiene el historial de chat de una sesión
   */
  async getChatHistory(phone: string): Promise<Array<{ from: string; text?: string; photoUrl?: string; timestamp: number }>> {
    return this.session.getChatHistory(phone);
  }

  /**
   * Alterna el bot para una sesión (habilitar/deshabilitar)
   */
  async toggleBotForSession(phone: string, botEnabled: boolean): Promise<void> {
    await this.session.toggleBotForSession(phone, botEnabled);
    this.logger.log(`[${phone}] Bot ${botEnabled ? 'habilitado' : 'deshabilitado'}`);
  }

  /**
   * Carga un archivo de fotos de usuario a Storage
   */
  async uploadBufferToStorage(buffer: Buffer, mimeType: string, phone: string): Promise<string> {
    return this.media.uploadBufferToStorage(buffer, mimeType, phone);
  }

  /**
   * Guarda un mensaje en el historial de sesión
   */
  async saveMessage(
    phone: string,
    from: 'user' | 'bot' | 'admin',
    text: string,
    photoUrl?: string,
  ): Promise<void> {
    return this.session.saveMessage(phone, from, text, photoUrl);
  }

  /**
   * Envía un mensaje via WhatsApp
   */
  async sendMessage(phone: string, text: string): Promise<void> {
    // Implementation delegated to orchestrator/session
    return this.session.reply(phone, text);
  }

  /**
   * Envía un mensaje de administrador y lo guarda en historial
   */
  async sendAdminMessage(phone: string, text: string): Promise<void> {
    return this.session.sendAdminMessage(phone, text);
  }

  /**
   * Notifica al usuario las piezas propuestas para su aprobación
   */
  private async notifyApprovalPhotos(phone: string, ticketData: Record<string, unknown>): Promise<void> {
    const allFields = await this.botConfig.getFields().catch(() => []);
    const adminPhotoFields = allFields.filter(f => f.type === 'photo' && f.source === 'admin');
    const extraFields = (ticketData.extraFields as Record<string, string | string[]>) || {};

    const approvalPhotos: string[] = [];
    for (const field of adminPhotoFields) {
      const urls = getNestedValue(extraFields, field.key);
      if (Array.isArray(urls)) approvalPhotos.push(...urls);
    }

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const extraVars = this.formatting.flattenExtraFieldsForInterpolation(extraFields);
    const msg = interpolate(
      msgs?.aprobacionPiezasMessage ??
        'Estas son las piezas propuestas para la aprobación de tu solicitud *{ticketNumber}*:',
      { ticketNumber: String(ticketData.ticketNumber), ...extraVars },
    );

    await this.session.saveMessage(phone, 'bot', msg).catch(err => {
      this.logger.error('Error guardando notificación APROBACION_PIEZAS:', err);
    });
    await this.session.reply(phone, msg).catch(err => {
      this.logger.error('Error enviando notificación APROBACION_PIEZAS:', err);
    });

    for (const photoUrl of approvalPhotos) {
      await this.session.saveMessage(phone, 'bot', '[imagen]', photoUrl).catch(() => null);
      await this.session.reply(phone, '[imagen]', undefined, photoUrl).catch(() => null);
    }
  }

  /**
   * Notifica cambio de estado a un usuario
   */
  private async notifyStatusChanged(
    phone: string,
    ticketData: Record<string, unknown>,
    prevStatus: string,
    newStatus: string,
  ): Promise<void> {
    const msgs = await this.botConfig.getMessages().catch(() => null);
    const extraVars = this.formatting.flattenExtraFieldsForInterpolation(
      (ticketData.extraFields as Record<string, unknown>) || {},
    );

    const msg = interpolate(
      msgs?.statusChanged ??
        'El estado de su solicitud *{ticketNumber}* ha cambiado de "{prevStatus}" a "{newStatus}".',
      {
        ticketNumber: String(ticketData.ticketNumber),
        prevStatus,
        newStatus,
        ...extraVars,
      },
    );

    await this.session.saveMessage(phone, 'bot', msg).catch(() => null);
    await this.session.reply(phone, msg).catch(() => null);
  }
}
