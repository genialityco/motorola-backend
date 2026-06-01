import { Injectable } from '@nestjs/common';
import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { BotConfigService } from '../../../bot-config/bot-config.service';
import { FirebaseService } from '../../../firebase/firebase.service';
import { WhatsappSessionService } from '../whatsapp-session.service';
import { WhatsappFormattingService } from '../whatsapp-formatting.service';
import { WhatsappTicketCreationService } from '../whatsapp-ticket-creation.service';
import { setNestedValue, normalizeText } from './helpers';
import { FECHA_FORMAT_LABEL, isValidFecha } from '../../../tickets/_internal/utils';

interface FieldValues {
  [key: string]: unknown;
}

@Injectable()
export class WhatsappCreateFlowService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
    private readonly session: WhatsappSessionService,
    private readonly formatting: WhatsappFormattingService,
    private readonly ticketCreation: WhatsappTicketCreationService,
  ) {}

  async handleFieldCollection(
    phone: string,
    sessionRef: DocumentReference<DocumentData>,
    body: string,
    incomingPhotoUrl: string | undefined,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const allFields = await this.botConfig.getFields();
    const fields = allFields.filter(f => f.source === 'bot');
    const fieldIndex: number = typeof session.fieldIndex === 'number' ? session.fieldIndex : 0;
    const fieldValues: FieldValues = (session.fieldValues as FieldValues) || {};

    const currentField = fields[fieldIndex];
    if (!currentField) {
      await send('Error de configuración. Escribe cualquier mensaje para volver al menú.');
      await sessionRef.set({ state: 'IDLE' }, { merge: true });
      return;
    }

    const isPhotoField = currentField.type === 'photo';

    if (isPhotoField) {
      await this.handlePhotoField(
        phone,
        sessionRef,
        body,
        incomingPhotoUrl,
        fieldIndex,
        fieldValues,
        fields,
        send,
      );
    } else {
      await this.handleTextField(
        phone,
        sessionRef,
        body,
        fieldIndex,
        fieldValues,
        currentField,
        fields,
        send,
      );
    }
  }

  async handleOtherResponse(
    phone: string,
    sessionRef: DocumentReference<DocumentData>,
    body: string,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const allFields = await this.botConfig.getFields();
    const fields = allFields.filter(f => f.source === 'bot');
    const fieldIndex: number = typeof session.fieldIndex === 'number' ? session.fieldIndex : 0;
    const fieldValues: FieldValues = (session.fieldValues as FieldValues) || {};
    const currentField = fields[fieldIndex];

    if (!currentField) {
      await send('Error de configuración. Escribe cualquier mensaje para volver al menú.');
      await sessionRef.set({ state: 'IDLE' }, { merge: true });
      return;
    }

    if (!body) {
      const otherQuestion = currentField.otherLabel?.trim() || '¿Cuál es tu respuesta?';
      await send(otherQuestion);
      return;
    }

    const otherValue = `OTRO: ${body.trim()}`;
    setNestedValue(fieldValues, currentField.key, otherValue);
    const nextIndex = fieldIndex + 1;

    if (nextIndex < fields.length) {
      await sessionRef.set(
        { fieldIndex: nextIndex, fieldValues, state: 'WAITING_FIELD', tempFieldPhotos: [] },
        { merge: true },
      );
      await send(this.formatting.buildFieldQuestion(fields[nextIndex]));
    } else {
      await this.ticketCreation.createTicket(phone, sessionRef, fieldValues, send);
    }
  }

  private async handlePhotoField(
    phone: string,
    sessionRef: DocumentReference<DocumentData>,
    body: string,
    incomingPhotoUrl: string | undefined,
    fieldIndex: number,
    fieldValues: FieldValues,
    fields: any[],
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    if (incomingPhotoUrl) {
      const newLength = await this.firebase.db.runTransaction(async (tx) => {
        const docSnap = await tx.get(sessionRef);
        const existing: string[] = Array.isArray(docSnap.data()?.tempFieldPhotos)
          ? docSnap.data()!.tempFieldPhotos
          : [];
        const newPhotos = [...existing, incomingPhotoUrl];
        tx.set(
          sessionRef,
          { tempFieldPhotos: newPhotos, fieldValues, state: 'WAITING_FIELD' },
          { merge: true },
        );
        return newPhotos.length;
      });
      await send(
        `Foto ${newLength} recibida. Puedes enviar más fotos o escribe *listo* para continuar.`,
      );
    } else if (body) {
      const freshDoc = await sessionRef.get();
      const finalPhotos: string[] = Array.isArray(freshDoc.data()?.tempFieldPhotos)
        ? freshDoc.data()!.tempFieldPhotos
        : [];

      const currentField = fields[fieldIndex];
      if (finalPhotos.length === 0 && currentField.required !== false) {
        await send(`Por favor envía al menos una foto para continuar con "${currentField.label}".`);
        return;
      }

      setNestedValue(fieldValues, currentField.key, finalPhotos);
      const nextIndex = fieldIndex + 1;

      if (nextIndex < fields.length) {
        await sessionRef.set(
          { fieldIndex: nextIndex, fieldValues, state: 'WAITING_FIELD', tempFieldPhotos: [] },
          { merge: true },
        );
        await send(this.formatting.buildFieldQuestion(fields[nextIndex]));
      } else {
        await this.ticketCreation.createTicket(phone, sessionRef, fieldValues, send);
      }
    }
  }

  private async handleTextField(
    phone: string,
    sessionRef: DocumentReference<DocumentData>,
    body: string,
    fieldIndex: number,
    fieldValues: FieldValues,
    currentField: any,
    fields: any[],
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    if (!body) {
      await send(this.formatting.buildFieldQuestion(currentField));
      return;
    }

    let value: string;

    if (currentField.type === 'list' && currentField.options && currentField.options.length > 0) {
      const optIdx = parseInt(body) - 1;
      const totalOpts = currentField.allowOther
        ? currentField.options.length + 1
        : currentField.options.length;

      if (isNaN(optIdx) || optIdx < 0 || optIdx >= totalOpts) {
        const opts = currentField.options.map((o: string, i: number) => `${i + 1}. ${o}`).join('\n');
        const otherLine = currentField.allowOther ? `\n${currentField.options.length + 1}. Otro` : '';
        await send(`Opción no válida. Por favor selecciona:\n${opts}${otherLine}`);
        return;
      }

      if (currentField.allowOther && optIdx === currentField.options.length) {
        const otherQuestion = currentField.otherLabel?.trim() || '¿Cuál es tu respuesta?';
        await sessionRef.set(
          { state: 'WAITING_FIELD_OTHER_RESPONSE', fieldIndex, fieldValues },
          { merge: true },
        );
        await send(otherQuestion);
        return;
      }

      value = currentField.options[optIdx];
    } else if (currentField.type === 'boolean') {
      const lower = body.toLowerCase();
      if (['si', 'sí', '1', 'yes', 's'].includes(lower)) {
        value = 'true';
      } else if (['no', '2', 'n'].includes(lower)) {
        value = 'false';
      } else {
        await send('Por favor responde *Sí* (1) o *No* (2).');
        return;
      }
    } else if (currentField.type === 'fecha') {
      const trimmed = body.trim();
      if (!isValidFecha(trimmed)) {
        await send(`Formato inválido. Usa ${FECHA_FORMAT_LABEL} (ejemplo: 25/12/2026, 14:30).`);
        return;
      }
      value = trimmed;
    } else {
      value = currentField.normalize !== false ? normalizeText(body) : body.trim();
    }

    setNestedValue(fieldValues, currentField.key, value);
    const nextIndex = fieldIndex + 1;

    if (nextIndex < fields.length) {
      await sessionRef.set(
        { fieldIndex: nextIndex, fieldValues, state: 'WAITING_FIELD', tempFieldPhotos: [] },
        { merge: true },
      );
      await send(this.formatting.buildFieldQuestion(fields[nextIndex]));
    } else {
      await this.ticketCreation.createTicket(phone, sessionRef, fieldValues, send);
    }
  }
}
