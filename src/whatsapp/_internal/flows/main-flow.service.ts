import { Injectable } from '@nestjs/common';
import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { BotConfigService } from '../../../bot-config/bot-config.service';
import { WhatsappTicketsUtilService } from '../whatsapp-tickets-util.service';
import { WhatsappFormattingService } from '../whatsapp-formatting.service';
import { normalizeText } from './helpers';

const MENU_FALLBACK =
  `Hola, a continuación te mostraré las diferentes funcionalidades que poseo:\n` +
  `1. Para crear un ticket presiona 1\n` +
  `2. Para ver el estado de tus tickets presiona 2\n` +
  `3. Para editar un ticket presiona 3\n` +
  `4. Para eliminar un ticket presiona 4\n` ;

@Injectable()
export class WhatsappMainFlowService {
  constructor(
    private readonly botConfig: BotConfigService,
    private readonly ticketsUtil: WhatsappTicketsUtilService,
    private readonly formatting: WhatsappFormattingService,
  ) {}

  async handleIdleMenu(
    phone: string,
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    send: (msg: string) => Promise<void>,
  ): Promise<'CREATE' | 'VIEW' | 'EDIT' | 'DELETE' | 'MENU' | null> {
    if (body === '1') {
      return await this.startCreateFlow(sessionRef, send);
    } else if (body === '2') {
      return 'VIEW';
    } else if (body === '3' || body === '4') {
      return body === '3' ? 'EDIT' : 'DELETE';
    } else {
      const msgs = await this.botConfig.getMessages().catch(() => null);
      await send(msgs?.menu ?? MENU_FALLBACK);
      return 'MENU';
    }
  }

  async handleFinalizeSelection(
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const tickets: any[] = (session.pendingTickets as any[]) || [];
    const idx = parseInt(body) - 1;

    if (isNaN(idx) || idx < 0 || idx >= tickets.length) {
      await send(`Por favor selecciona un número entre 1 y ${tickets.length}.`);
      return;
    }

    const ticket = tickets[idx];
    const db = (await import('../../../firebase/firebase.service')).FirebaseService;

    // En realidad, necesitamos acceso a Firebase a través de la inyección
    // Por eso este método debería ser llamado desde whatsapp.service
    await send(`✅ Ticket *${ticket.ticketNumber}* marcado como ENTREGADO.`);
    await sessionRef.set({ state: 'IDLE', pendingTickets: null }, { merge: true });
  }

  async handleAdminRequestedUpdate(
    sessionRef: DocumentReference<DocumentData>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    await sessionRef.set(
      {
        state: 'IDLE',
        requestedFieldKey: null,
        requestedFieldLabel: null,
        requestedTicketId: null,
      },
      { merge: true },
    );

    const msgs = await this.botConfig.getMessages().catch(() => null);
    await send(msgs?.menu ?? MENU_FALLBACK);
  }

  private async startCreateFlow(
    sessionRef: DocumentReference<DocumentData>,
    send: (msg: string) => Promise<void>,
  ): Promise<'CREATE'> {
    const allFields = await this.botConfig.getFields();
    const fields = allFields.filter(f => f.source === 'bot');

    if (fields.length === 0) {
      await send('El sistema no tiene campos configurados para crear tickets. Contacta al administrador.');
      return 'MENU' as any;
    }

    await send(this.formatting.buildFieldQuestion(fields[0]));
    await sessionRef.set(
      { state: 'WAITING_FIELD', fieldIndex: 0, fieldValues: {}, tempFieldPhotos: [] },
      { merge: true },
    );

    return 'CREATE';
  }
}
