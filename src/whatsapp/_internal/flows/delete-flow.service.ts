import { Injectable } from '@nestjs/common';
import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { BotConfigService, interpolate } from '../../../bot-config/bot-config.service';
import { FirebaseService } from '../../../firebase/firebase.service';
import { WhatsappFormattingService } from '../whatsapp-formatting.service';
import { WhatsappTicketsUtilService } from '../whatsapp-tickets-util.service';

interface PendingTicket {
  id: string;
  ticketNumber: string;
  status: string;
  extraFields?: Record<string, string | string[]>;
}

@Injectable()
export class WhatsappDeleteFlowService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
    private readonly formatting: WhatsappFormattingService,
    private readonly ticketsUtil: WhatsappTicketsUtilService,
  ) {}

  async handleDeleteSelection(
    phone: string,
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const tickets = await this.ticketsUtil.getTicketsByPhone(phone);
    if (tickets.length === 0) {
      const msgs = await this.botConfig.getMessages().catch(() => null);
      await send(msgs?.noTickets ?? 'No tienes tickets disponibles para eliminar. ¿Puedo ayudarte en algo más?');
      return;
    }

    const allFields = await this.botConfig.getFields().catch(() => []);
    const list = this.formatting.formatTicketsListDetailed(
      tickets,
      allFields,
      (await this.botConfig.getMessages())?.ticketListItemTemplate,
    );

    await sessionRef.set({ pendingTickets: tickets }, { merge: true });

    const selectTemplate =
      (await this.botConfig.getMessages())?.ticketSelectPrompt ??
      'Selecciona el número del ticket que deseas *{action}*:';
    await send(`Tus tickets:\n\n${list}\n\n${interpolate(selectTemplate, { action: 'eliminar' })}`);
    await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_DELETE' }, { merge: true });
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
      await send(`Por favor selecciona un número entre 1 y ${tickets.length}.`);
      return;
    }

    const deletedTicket = tickets[idx];
    const db = this.firebase.db;

    await db.collection('tickets').doc(deletedTicket.id).update({
      status: 'ARCHIVADO',
      'timestamps.updatedAt': Date.now(),
    });

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const extraVarsDelete = this.formatting.flattenExtraFieldsForInterpolation(
      (deletedTicket.extraFields as Record<string, unknown>) || {},
    );

    const deleteMsg = interpolate(
      msgs?.ticketDeleted ?? '✅ Ticket *{ticketNumber}* eliminado correctamente.',
      { ticketNumber: deletedTicket.ticketNumber, ...extraVarsDelete },
    );

    await send(deleteMsg);
    await sessionRef.set({ state: 'IDLE', pendingTickets: null }, { merge: true });
  }
}
