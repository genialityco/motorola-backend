import { Injectable } from '@nestjs/common';
import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { BotConfigService } from '../../../bot-config/bot-config.service';
import { WhatsappFormattingService } from '../whatsapp-formatting.service';
import { WhatsappTicketsUtilService } from '../whatsapp-tickets-util.service';
import { getNestedValue } from './helpers';

interface PendingTicket {
  id: string;
  ticketNumber: string;
  status: string;
  extraFields?: Record<string, string | string[]>;
  createdAt?: number;
}

@Injectable()
export class WhatsappViewFlowService {
  constructor(
    private readonly botConfig: BotConfigService,
    private readonly formatting: WhatsappFormattingService,
    private readonly ticketsUtil: WhatsappTicketsUtilService,
  ) {}

  async handleViewSelection(
    phone: string,
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    send: (msg: string) => Promise<void>,
    sendPhoto: (url: string) => Promise<void>,
  ): Promise<void> {
    const myTickets = await this.ticketsUtil.getTicketsByPhone(phone);
    if (myTickets.length === 0) {
      const msgs = await this.botConfig.getMessages().catch(() => null);
      await send(msgs?.noTickets ?? 'No tienes tickets disponibles. ¿Puedo ayudarte en algo más?');
      return;
    }

    const allFields = await this.botConfig.getFields().catch(() => []);
    const list = this.formatting.formatTicketsListDetailed(
      myTickets,
      allFields,
      (await this.botConfig.getMessages())?.ticketListItemTemplate,
    );

    const selectTemplate =
      (await this.botConfig.getMessages())?.ticketSelectPrompt ??
      'Selecciona el número del ticket que deseas *ver*:';

    await send(`Tus tickets:\n\n${list}\n\n${selectTemplate}`);
    await sessionRef.set({
      pendingTickets: myTickets,
      state: 'WAITING_TICKET_SELECTION_VIEW',
    }, { merge: true });
  }

  async handleSelectTicket(
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const tickets: PendingTicket[] = (session.pendingTickets as PendingTicket[]) || [];
    const idx = parseInt(body) - 1;

    if (isNaN(idx) || idx < 0 || idx >= tickets.length) {
      await send(`Por favor responde un número entre 1 y ${tickets.length}.`);
      return;
    }

    const selected = tickets[idx];
    await sessionRef.set({ state: 'WAITING_VIEW_OPTION', pendingTicketData: selected }, { merge: true });
    await send(
      `Ticket *${selected.ticketNumber}* — ${selected.status}\n\n¿Qué deseas ver?\n1. Info del ticket\n2. Ver fotos`,
    );
  }

  async handleViewOption(
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
    sendPhoto: (url: string) => Promise<void>,
  ): Promise<void> {
    const ticket = session.pendingTicketData as PendingTicket;

    if (body === '1') {
      await this.showTicketInfo(ticket, send);
    } else if (body === '2') {
      await this.showTicketPhotos(ticket, send, sendPhoto);
    } else {
      await send('Opción no válida. Responde *1* para ver info o *2* para ver fotos.');
      return;
    }

    await sessionRef.set({ state: 'IDLE', pendingTicketData: null, pendingTickets: null }, { merge: true });
  }

  private async showTicketInfo(
    ticket: PendingTicket,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const dateStr = ticket.createdAt
      ? new Date(ticket.createdAt).toLocaleDateString('es-CO')
      : 'Sin fecha';
    const extraFields = ticket.extraFields || {};
    const allFields = await this.botConfig.getFields().catch(() => []);

    let info = `📋 *${ticket.ticketNumber}*\nEstado: ${ticket.status}\nFecha: ${dateStr}\n`;

    for (const field of allFields) {
      if (field.type === 'photo') continue;
      const value = getNestedValue(extraFields, field.key);
      if (value && typeof value === 'string') {
        const display = value === 'true' ? 'Sí' : value === 'false' ? 'No' : value;
        info += `${field.label}: ${display}\n`;
      }
    }

    await send(info.trim());
  }

  private async showTicketPhotos(
    ticket: PendingTicket,
    send: (msg: string) => Promise<void>,
    sendPhoto: (url: string) => Promise<void>,
  ): Promise<void> {
    const extraFields = ticket.extraFields || {};
    const allFields = await this.botConfig.getFields().catch(() => []);
    const photoFields = allFields.filter(f => f.type === 'photo');

    let hasPhotos = false;
    for (const field of photoFields) {
      const photos = getNestedValue(extraFields, field.key);
      if (Array.isArray(photos) && photos.length > 0) {
        hasPhotos = true;
        await send(`📷 *${field.label}* (${photos.length}):`);
        for (const url of photos) {
          await sendPhoto(url);
        }
      }
    }

    if (!hasPhotos) {
      await send('Este ticket no tiene fotos adjuntas.');
    }
  }
}
