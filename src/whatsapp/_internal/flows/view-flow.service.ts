import { Injectable } from '@nestjs/common';
import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { BotConfigService } from '../../../bot-config/bot-config.service';
import { WhatsappFormattingService } from '../whatsapp-formatting.service';
import { WhatsappTicketsUtilService } from '../whatsapp-tickets-util.service';

@Injectable()
export class WhatsappViewFlowService {
  constructor(
    private readonly botConfig: BotConfigService,
    private readonly formatting: WhatsappFormattingService,
    private readonly ticketsUtil: WhatsappTicketsUtilService,
  ) {}

  /**
   * Opción "Ver": muestra el listado de tickets del usuario usando la plantilla
   * configurada (`ticketListItemTemplate`) para conocer su estado. No pide
   * seleccionar un ticket; solo muestra la información.
   */
  async handleViewSelection(
    phone: string,
    sessionRef: DocumentReference<DocumentData>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const myTickets = await this.ticketsUtil.getTicketsByPhone(phone);
    if (myTickets.length === 0) {
      const msgs = await this.botConfig.getMessages().catch(() => null);
      await send(msgs?.noTickets ?? 'No tienes tickets disponibles. ¿Puedo ayudarte en algo más?');
      await sessionRef.set({ state: 'IDLE', pendingTickets: null }, { merge: true });
      return;
    }

    const [allFields, msgs] = await Promise.all([
      this.botConfig.getFields().catch(() => []),
      this.botConfig.getMessages().catch(() => null),
    ]);
    const list = this.formatting.formatTicketsListDetailed(
      myTickets,
      allFields,
      msgs?.ticketListItemTemplate,
    );

    await send(`Tus tickets:\n\n${list}`);
    await sessionRef.set({ state: 'IDLE', pendingTickets: null }, { merge: true });
  }
}
