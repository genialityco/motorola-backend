import { Injectable } from '@nestjs/common';
import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { BotConfigService, TicketField, interpolate } from '../../../bot-config/bot-config.service';
import { COLLECTIONS, FirebaseService } from '../../../firebase/firebase.service';
import { WhatsappFormattingService } from '../whatsapp-formatting.service';
import { WhatsappTicketsUtilService } from '../whatsapp-tickets-util.service';
import { getNestedValue, setNestedValue, normalizeText } from './helpers';

interface PendingTicket {
  id: string;
  ticketNumber: string;
  status: string;
  extraFields?: Record<string, string | string[]>;
}

@Injectable()
export class WhatsappEditFlowService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
    private readonly formatting: WhatsappFormattingService,
    private readonly ticketsUtil: WhatsappTicketsUtilService,
  ) {}

  async handleEditSelection(
    phone: string,
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const tickets = await this.ticketsUtil.getTicketsByPhone(phone);
    if (tickets.length === 0) {
      const msgs = await this.botConfig.getMessages().catch(() => null);
      await send(msgs?.noTickets ?? 'No tienes tickets disponibles para editar. ¿Puedo ayudarte en algo más?');
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
    await send(`Tus tickets:\n\n${list}\n\n${interpolate(selectTemplate, { action: 'editar' })}`);
    await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_EDIT' }, { merge: true });
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

    const selectedTicket = tickets[idx];
    const [allFields, msgsEdit] = await Promise.all([
      this.botConfig.getFields(),
      this.botConfig.getMessages(),
    ]);

    const editableFields = allFields.filter(f => f.source === 'bot');
    const fieldList = editableFields.map((f, i) => `${i + 1}. ${f.label}`).join('\n');
    const extraVarsEdit = this.formatting.flattenExtraFieldsForInterpolation(
      (selectedTicket.extraFields as Record<string, unknown>) || {},
    );

    await send(
      interpolate(msgsEdit.editFieldPrompt, {
        ticketNumber: selectedTicket.ticketNumber,
        fieldList,
        ...extraVarsEdit,
      }),
    );

    await sessionRef.set(
      {
        state: 'WAITING_EDIT_FIELD_SELECTION',
        pendingTicketId: selectedTicket.id,
        pendingTicketData: selectedTicket,
        editableFields,
      },
      { merge: true },
    );
  }

  async handleFieldSelection(
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const editableFields = (session.editableFields as TicketField[]) || [];
    const ticketData = session.pendingTicketData as PendingTicket;

    if (body === '0') {
      await send('Operación cancelada.');
      await this.resetSession(sessionRef);
      return;
    }

    const fieldIdx = parseInt(body) - 1;
    if (isNaN(fieldIdx) || fieldIdx < 0 || fieldIdx >= editableFields.length) {
      const fieldList = editableFields.map((f, i) => `${i + 1}. ${f.label}`).join('\n');
      await send(`Selecciona un número entre 1 y ${editableFields.length} o 0 para cancelar:\n${fieldList}`);
      return;
    }

    const selectedField = editableFields[fieldIdx];

    if (selectedField.type === 'photo') {
      await this.handlePhotoFieldSelection(selectedField, ticketData, sessionRef, send);
    } else {
      await this.handleTextFieldSelection(selectedField, ticketData, sessionRef, send);
    }
  }

  async handleFieldValue(
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    if (!body) {
      await send('Por favor ingresa el nuevo valor.');
      return;
    }

    const ticketId = session.pendingTicketId as string;
    const editFieldKey = session.editFieldKey as string;
    const editFieldType = session.editFieldType as string;
    const editFieldOptions = (session.editFieldOptions as string[]) || [];
    const editFieldNormalize = session.editFieldNormalize as boolean | undefined;
    const editFieldAllowOther = (session.editFieldAllowOther as boolean) || false;

    let newValue: string;

    if (editFieldType === 'list' && editFieldOptions.length > 0) {
      const optIdx = parseInt(body) - 1;
      const totalOpts = editFieldAllowOther
        ? editFieldOptions.length + 1
        : editFieldOptions.length;

      if (isNaN(optIdx) || optIdx < 0 || optIdx >= totalOpts) {
        const opts = editFieldOptions.map((o, i) => `${i + 1}. ${o}`).join('\n');
        const otherLine = editFieldAllowOther ? `\n${editFieldOptions.length + 1}. Otro` : '';
        await send(`Opción no válida:\n${opts}${otherLine}`);
        return;
      }

      if (editFieldAllowOther && optIdx === editFieldOptions.length) {
        const otherQuestion =
          (session.editFieldOtherLabel as string)?.trim() || '¿Cuál es tu respuesta?';
        await sessionRef.set({ state: 'WAITING_EDIT_OTHER_RESPONSE' }, { merge: true });
        await send(otherQuestion);
        return;
      }

      newValue = editFieldOptions[optIdx];
    } else if (editFieldType === 'boolean') {
      const lower = body.toLowerCase();
      if (['si', 'sí', '1', 'yes', 's'].includes(lower)) {
        newValue = 'true';
      } else if (['no', '2', 'n'].includes(lower)) {
        newValue = 'false';
      } else {
        await send('Por favor responde *Sí* (1) o *No* (2).');
        return;
      }
    } else {
      newValue = editFieldNormalize ? normalizeText(body) : body.trim();
    }

    const db = this.firebase.db;
    if (ticketId) {
      await db.collection(COLLECTIONS.TICKETS).doc(ticketId).update({
        [`extraFields.${editFieldKey}`]: newValue,
        'timestamps.updatedAt': Date.now(),
      });

      const msgs = await this.botConfig.getMessages().catch(() => null);
      const ticketDataEdit = session.pendingTicketData as PendingTicket | null;
      const extraVarsEdit = this.formatting.flattenExtraFieldsForInterpolation(
        (ticketDataEdit?.extraFields as Record<string, unknown>) || {},
      );

      const editMsg = interpolate(
        msgs?.ticketCreated ??
          '✅ Ticket *{ticketNumber}* {action} exitosamente.\n\nTe notificaremos cuando haya actualizaciones de estados.',
        { ticketNumber: ticketDataEdit?.ticketNumber ?? '', action: 'editado', ...extraVarsEdit },
      );

      await send(editMsg);
    }

    await this.resetSession(sessionRef);
  }

  async handleOtherResponse(
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    if (!body) {
      const otherQuestion =
        (session.editFieldOtherLabel as string)?.trim() || '¿Cuál es tu respuesta?';
      await send(otherQuestion);
      return;
    }

    const ticketId = session.pendingTicketId as string;
    const editFieldKey = session.editFieldKey as string;
    const otherValue = `OTRO: ${body.trim()}`;

    const db = this.firebase.db;
    if (ticketId) {
      await db.collection(COLLECTIONS.TICKETS).doc(ticketId).update({
        [`extraFields.${editFieldKey}`]: otherValue,
        'timestamps.updatedAt': Date.now(),
      });

      const msgs = await this.botConfig.getMessages().catch(() => null);
      const ticketDataEdit = session.pendingTicketData as PendingTicket | null;
      const extraVarsEdit = this.formatting.flattenExtraFieldsForInterpolation(
        (ticketDataEdit?.extraFields as Record<string, unknown>) || {},
      );

      const editMsg = interpolate(
        msgs?.ticketCreated ??
          '✅ Ticket *{ticketNumber}* {action} exitosamente.\n\nTe notificaremos cuando haya actualizaciones de estados.',
        { ticketNumber: ticketDataEdit?.ticketNumber ?? '', action: 'editado', ...extraVarsEdit },
      );

      await send(editMsg);
    }

    await this.resetSession(sessionRef);
  }

  private async handleTextFieldSelection(
    selectedField: TicketField,
    ticketData: PendingTicket,
    sessionRef: DocumentReference<DocumentData>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const currentValue =
      ((getNestedValue(
        ticketData.extraFields as Record<string, unknown> ?? {},
        selectedField.key,
      ) as string) || 'Sin valor');
    const currentDisplay =
      currentValue === 'true' ? 'Sí' : currentValue === 'false' ? 'No' : currentValue;

    await send(
      `Valor actual: *${currentDisplay}*\n\n${this.formatting.buildFieldQuestion(selectedField)}`,
    );

    await sessionRef.set(
      {
        state: 'WAITING_EDIT_FIELD_VALUE',
        editFieldKey: selectedField.key,
        editFieldType: selectedField.type,
        editFieldOptions: selectedField.options || [],
        editFieldNormalize: selectedField.normalize,
        editFieldAllowOther: selectedField.allowOther || false,
        editFieldOtherLabel: selectedField.otherLabel || null,
      },
      { merge: true },
    );
  }

  private async handlePhotoFieldSelection(
    selectedField: TicketField,
    ticketData: PendingTicket,
    sessionRef: DocumentReference<DocumentData>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const photos =
      ((getNestedValue(
        ticketData.extraFields as Record<string, unknown> ?? {},
        selectedField.key,
      ) as string[]) || []);
    const hasPhotos = photos.length > 0;
    const photoList = hasPhotos ? `Fotos actuales: ${photos.length}\n\n` : 'Este campo no tiene fotos aún.\n\n';

    await send(
      `${photoList}¿Qué deseas hacer?\n1. Reemplazar una foto${!hasPhotos ? ' (no disponible)' : ''}\n2. Agregar nuevas fotos\n0. Cancelar`,
    );

    await sessionRef.set({ state: 'WAITING_EDIT_PHOTO_ACTION', editFieldKey: selectedField.key }, { merge: true });
  }

  private async resetSession(sessionRef: DocumentReference<DocumentData>): Promise<void> {
    await sessionRef.set(
      {
        state: 'IDLE',
        pendingTicketId: null,
        pendingTickets: null,
        pendingTicketData: null,
        editableFields: null,
        editFieldKey: null,
        editFieldType: null,
        editFieldOptions: null,
        editFieldAllowOther: null,
        editFieldOtherLabel: null,
      },
      { merge: true },
    );
  }
}
