import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { BotConfigService, interpolate, TicketField } from '../bot-config/bot-config.service';
import { FieldValue, DocumentReference, DocumentData } from 'firebase-admin/firestore';

type WhatsAppMessage = {
  from?: string;
  type?: string;
  text?: { body?: string };
  image?: {
    mime_type?: string;
    id?: string;
    caption?: string;
    directUrl?: string;
  };
};

type WhatsAppWebhookPayload = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: { messages?: WhatsAppMessage[] };
    }>;
  }>;
};

interface PendingTicket {
  id: string;
  ticketNumber: string;
  status: string;
  extraFields?: Record<string, string | string[]>;
  createdAt?: number;
}

const MENU_FALLBACK =
  `Hola, a continuación te mostraré las diferentes funcionalidades que poseo:\n` +
  `1. Para crear un ticket presiona 1\n` +
  `2. Para ver el estado de tus tickets presiona 2\n` +
  `3. Para editar un ticket presiona 3\n` +
  `4. Para eliminar un ticket presiona 4\n` ;

function normalizeText(text: string): string {
  return text
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, obj);
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
  ) {}

  async notifyStatusChange(
    prevStatus: string,
    newStatus: string,
    ticketData: Record<string, unknown>,
  ): Promise<void> {
    if (!prevStatus || prevStatus === newStatus || newStatus === 'ARCHIVADO') return;

    const rawPhone = (ticketData.reporter as Record<string, unknown>)?.phone as string;
    const phone = rawPhone ? this.normalizePhoneForWhatsApp(rawPhone) : '';
    if (!phone) return;

    if (newStatus === 'REPARADO') {
      const allFields = await this.botConfig.getFields().catch(() => []);
      const adminPhotoFields = allFields.filter(f => f.type === 'photo' && f.source === 'admin');
      const extraFields = (ticketData.extraFields as Record<string, string | string[]>) || {};
      const repairPhotos: string[] = [];
      for (const field of adminPhotoFields) {
        const urls = getNestedValue(extraFields, field.key);
        if (Array.isArray(urls)) repairPhotos.push(...urls);
      }

      const descField = allFields.find(f => f.type !== 'photo' && f.source === 'bot');
      const description = descField ? String(getNestedValue(extraFields, descField.key) || '') : '';

      const msgs = await this.botConfig.getMessages().catch(() => null);
      const extraVarsReparado = this.flattenExtraFieldsForInterpolation(
        (ticketData.extraFields as Record<string, unknown>) || {},
      );
      const msg = repairPhotos.length > 0
        ? interpolate(
            msgs?.reparadoMessage ?? 'Estas son las evidencias de que su ticket *{ticketNumber}* ha sido reparado:',
            { ticketNumber: String(ticketData.ticketNumber), description, ...extraVarsReparado },
          )
        : interpolate(
            msgs?.statusChanged ?? 'El estado de su solicitud *{ticketNumber}* ha cambiado de "{prevStatus}" a "{newStatus}".',
            { ticketNumber: String(ticketData.ticketNumber), prevStatus, newStatus, ...extraVarsReparado },
          );

      await this.saveMessage(phone, 'bot', msg).catch((err) =>
        this.logger.error('Error guardando notificación REPARADO:', err),
      );
      await this.sendMessage(phone, msg).catch((err) =>
        this.logger.error('Error enviando notificación REPARADO:', err),
      );

      for (const photoUrl of repairPhotos) {
        await this.saveMessage(phone, 'bot', '[imagen]', photoUrl).catch(() => null);
        await this.sendImageMessage(phone, photoUrl, 'Evidencia de reparación').catch(() => null);
      }
    } else {
      const msgs = await this.botConfig.getMessages().catch(() => null);
      const extraVars = this.flattenExtraFieldsForInterpolation(
        (ticketData.extraFields as Record<string, unknown>) || {},
      );
      const msg = interpolate(
        msgs?.statusChanged ?? 'El estado de su solicitud *{ticketNumber}* ha cambiado de "{prevStatus}" a "{newStatus}".',
        { ticketNumber: String(ticketData.ticketNumber), prevStatus, newStatus, ...extraVars },
      );
      await this.saveMessage(phone, 'bot', msg).catch(() => null);
      await this.sendMessage(phone, msg).catch(() => null);
    }
  }

  private async callWhatsAppApi(payload: Record<string, unknown>, logLabel: string) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;

    if (!token || !phoneId) {
      this.logger.warn('Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_ID');
      return;
    }

    const res = await fetch(
      `https://graph.facebook.com/v17.0/${phoneId}/messages`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );

    if (!res.ok) {
      this.logger.error(`Error ${logLabel}: ${res.status} ${await res.text()}`);
    }
  }

  async sendMessage(to: string, text: string) {
    await this.callWhatsAppApi(
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      'enviando WhatsApp',
    );
  }

  async sendImageMessage(to: string, imageUrl: string, caption?: string) {
    await this.callWhatsAppApi(
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl, ...(caption ? { caption } : {}) },
      },
      'enviando imagen WhatsApp',
    );
  }

  async saveMessage(
    phone: string,
    from: 'user' | 'bot' | 'admin',
    text: string,
    photoUrl?: string,
  ) {
    const ref = this.firebase.db.collection('whatsapp_sessions').doc(phone);
    const entry: Record<string, unknown> = { from, text, timestamp: Date.now() };
    if (photoUrl) entry.photoUrl = photoUrl;
    await ref.set({ messages: FieldValue.arrayUnion(entry) }, { merge: true });
  }

  private async reply(
    phone: string,
    text: string,
    onResponse?: (msg: string) => void,
    photoUrl?: string,
  ) {
    await this.saveMessage(phone, 'bot', text, photoUrl);
    if (onResponse) {
      onResponse(photoUrl ? `[IMG]${photoUrl}` : text);
    } else if (photoUrl) {
      await this.sendImageMessage(phone, photoUrl, text !== '[imagen]' ? text : undefined);
    } else {
      await this.sendMessage(phone, text);
    }
  }

  async sendAdminMessage(to: string, text: string) {
    await this.saveMessage(to, 'admin', text);
    await this.sendMessage(to, text);
  }

  async toggleBotForSession(phone: string, botEnabled: boolean) {
    const ref = this.firebase.db.collection('whatsapp_sessions').doc(phone);
    await ref.set({ botEnabled }, { merge: true });
    this.logger.log(`[${phone}] Bot ${botEnabled ? 'habilitado' : 'deshabilitado'}`);
  }

  private buildFieldQuestion(field: TicketField): string {
    const prompt = field.question?.trim() || field.placeholder?.trim() || field.label;
    if (field.type === 'list' && field.options && field.options.length > 0) {
      const opts = field.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
      return `${prompt}\n${opts}`;
    }
    if (field.type === 'boolean') {
      return `${prompt}\n1. Sí\n2. No`;
    }
    if (field.type === 'photo') {
      return `${prompt}\nEnvía las fotos y escribe *listo* cuando hayas terminado.`;
    }
    return prompt;
  }

  private formatTicketsListDetailed(tickets: PendingTicket[], allFields: TicketField[], template?: string): string {
    const textFields = allFields.filter(f => f.type !== 'photo' && f.type !== 'video');
    return tickets
      .map((t, i) => {
        const dateStr = t.createdAt
          ? new Date(t.createdAt).toLocaleDateString('es-CO')
          : 'Sin fecha';

        if (template) {
          const extraVars = this.flattenExtraFieldsForInterpolation(
            (t.extraFields as Record<string, unknown>) || {},
          );
          const vars: Record<string, string> = {
            index: String(i + 1),
            ticketNumber: t.ticketNumber,
            estado: t.status,
            fecha: dateStr,
            ...extraVars,
          };
          const rendered = template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
          return rendered.split('\n').filter(line => line.trim() !== '').join('\n');
        }

        const lines = [
          `${i + 1}. 📋 *${t.ticketNumber}*`,
          `   Estado: ${t.status}`,
          `   Fecha: ${dateStr}`,
        ];
        for (const field of textFields) {
          const value = getNestedValue((t.extraFields as Record<string, unknown>) || {}, field.key);
          if (value && typeof value === 'string') {
            const display = value === 'true' ? 'Sí' : value === 'false' ? 'No' : value;
            lines.push(`   ${field.label}: ${display}`);
          }
        }
        return lines.join('\n');
      })
      .join('\n\n');
  }

  private flattenExtraFieldsForInterpolation(extraFields: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {};
    const process = (obj: Record<string, unknown>, prefix: string) => {
      for (const [key, val] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof val === 'string') {
          result[fullKey] = val;
          result[key] = val;
          const underscored = fullKey.replace(/\./g, '_');
          if (underscored !== fullKey) result[underscored] = val;
        } else if (Array.isArray(val)) {
          result[key] = `${val.length} elemento(s)`;
          result[fullKey] = result[key];
        } else if (val && typeof val === 'object') {
          process(val as Record<string, unknown>, fullKey);
        }
      }
    };
    process(extraFields, '');
    return result;
  }

  private async getTicketsByPhone(phone: string): Promise<PendingTicket[]> {
    const snap = await this.firebase.db
      .collection('tickets')
      .where('reporter.phone', '==', phone)
      .get();
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ticketNumber: data.ticketNumber as string,
          status: data.status as string,
          extraFields: (data.extraFields as Record<string, string | string[]>) || {},
          createdAt: data.timestamps?.createdAt as number | undefined,
        };
      })
      .filter((t) => t.status !== 'ARCHIVADO');
  }

  async uploadBufferToStorage(buffer: Buffer, mimeType: string, phone: string): Promise<string> {
    try {
      const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
      if (!storageBucket) {
        this.logger.error('FIREBASE_STORAGE_BUCKET no está configurado');
        return '';
      }
      const bucket = this.firebase.storage.bucket(storageBucket);
      const ext = (mimeType.split('/')[1] || 'jpeg').toLowerCase();
      const filePath = `whatsapp_media/${phone}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const file = bucket.file(filePath);
      await file.save(buffer, { metadata: { contentType: mimeType } });
      await file.makePublic();
      return file.publicUrl();
    } catch (err) {
      this.logger.error('Error subiendo buffer a Storage:', err);
      return '';
    }
  }

  private async uploadMedia(mediaId: string, mimeType: string, phone: string): Promise<string> {
    const token = process.env.WHATSAPP_TOKEN;
    if (!token) return '';

    try {
      const meta = await fetch(
        `https://graph.facebook.com/v17.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ).then((r) => r.json());

      if (!meta.url) return '';

      const buffer = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.arrayBuffer());

      const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
      if (!storageBucket) return '';

      const bucket = this.firebase.storage.bucket(storageBucket);
      const ext = mimeType.split('/')[1] || 'jpeg';
      const filePath = `whatsapp_media/${phone}/${Date.now()}_${mediaId}.${ext}`;
      const file = bucket.file(filePath);
      await file.save(Buffer.from(buffer), { metadata: { contentType: mimeType } });
      await file.makePublic();
      return file.publicUrl();
    } catch (err) {
      this.logger.error('Error subiendo media a Storage:', err);
      return '';
    }
  }

  private normalizePhoneForWhatsApp(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
    return digits;
  }

  async processMessage(
    payload: WhatsAppWebhookPayload,
    onResponse?: (msg: string) => void,
  ) {
    const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const phone = message.from || '';
    const body = message.text?.body?.trim() || '';
    const db = this.firebase.db;
    const sessionRef = db.collection('whatsapp_sessions').doc(phone);
    const sessionDoc = await sessionRef.get();
    const session = sessionDoc.data() || {};
    const state: string = session.state || 'IDLE';

    const botEnabled = session.botEnabled !== false;

    let incomingPhotoUrl: string | undefined;
    if (message.type === 'image' && (message.image?.directUrl || message.image?.id)) {
      incomingPhotoUrl = message.image.directUrl;
      if (!incomingPhotoUrl && message.image?.id) {
        incomingPhotoUrl = await this.uploadMedia(
          message.image.id,
          message.image.mime_type || 'image/jpeg',
          phone,
        );
      }
      if (incomingPhotoUrl) {
        await this.saveMessage(phone, 'user', message.image.caption || '[imagen]', incomingPhotoUrl);
      }
    } else {
      await this.saveMessage(phone, 'user', body || '[imagen]');
    }

    if (!botEnabled) {
      this.logger.log(`[${phone}] Bot deshabilitado. Mensaje guardado sin respuesta automática.`);
      return;
    }

    const send = (text: string) => this.reply(phone, text, onResponse);
    const sendPhoto = (url: string) => this.reply(phone, '[imagen]', onResponse, url);

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const backKeyword = normalizeText(msgs?.backToMenuKeyword || 'INICIO');

    if (state !== 'IDLE' && body && normalizeText(body) === backKeyword) {
      await sessionRef.set({
        state: 'IDLE',
        fieldIndex: null, fieldValues: null, tempFieldPhotos: null,
        pendingTickets: null, pendingTicketId: null, pendingTicketData: null,
        editableFields: null, editFieldKey: null, editFieldType: null, editFieldOptions: null,
        requestedFieldKey: null, requestedFieldLabel: null, requestedTicketId: null,
        tempEditPhotos: null, pendingPhotoIndex: null,
      }, { merge: true });
      await send(msgs?.menu ?? MENU_FALLBACK);
      return;
    }

    // ─── IDLE ────────────────────────────────────────────────────────────────
    if (state === 'IDLE') {
      if (body === '1') {
        const allFields = await this.botConfig.getFields();
        const fields = allFields.filter(f => f.source === 'bot');
        if (fields.length === 0) {
          await send('El sistema no tiene campos configurados para crear tickets. Contacta al administrador.');
          return;
        }
        await send(this.buildFieldQuestion(fields[0]));
        await sessionRef.set(
          { state: 'WAITING_FIELD', fieldIndex: 0, fieldValues: {}, tempFieldPhotos: [] },
          { merge: true },
        );

      } else if (body === '2') {
        const myTickets = await this.getTicketsByPhone(phone);
        if (myTickets.length === 0) {
          await send(msgs?.noTickets ?? 'No tienes tickets registrados aún. ¿Puedo ayudarte en algo más?');
        } else {
          const allFields = await this.botConfig.getFields().catch(() => []);
          const list = this.formatTicketsListDetailed(myTickets, allFields, msgs?.ticketListItemTemplate);
          await send(`Tus tickets:\n\n${list}`);
        }

      } else if (body === '3' || body === '4' || body === '5') {
        const tickets = await this.getTicketsByPhone(phone);
        if (tickets.length === 0) {
          await send(msgs?.noTickets ?? 'No tienes tickets registrados. ¿Puedo ayudarte en algo más?');
          return;
        }
        const allFields = await this.botConfig.getFields().catch(() => []);
        const list = this.formatTicketsListDetailed(tickets, allFields, msgs?.ticketListItemTemplate);
        await sessionRef.set({ pendingTickets: tickets }, { merge: true });

        const selectTemplate = msgs?.ticketSelectPrompt ?? 'Selecciona el número del ticket que deseas *{action}*:';
        if (body === '3') {
          await send(`Tus tickets:\n\n${list}\n\n${interpolate(selectTemplate, { action: 'editar' })}`);
          await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_EDIT' }, { merge: true });
        } else if (body === '4') {
          await send(`Tus tickets:\n\n${list}\n\n${interpolate(selectTemplate, { action: 'eliminar' })}`);
          await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_DELETE' }, { merge: true });
        } else {
          await send(`Tus tickets:\n\n${list}\n\n${interpolate(selectTemplate, { action: 'finalizar' })}`);
          await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_FINALIZE' }, { merge: true });
        }

      } else {
        await send(msgs?.menu ?? MENU_FALLBACK);
      }

    // ─── FLUJO DINÁMICO DE CAMPOS (CREACIÓN) ─────────────────────────────────
    } else if (state === 'WAITING_FIELD') {
      const allFields = await this.botConfig.getFields();
      const fields = allFields.filter(f => f.source === 'bot');
      const fieldIndex: number = typeof session.fieldIndex === 'number' ? session.fieldIndex : 0;
      const fieldValues: Record<string, unknown> = session.fieldValues || {};

      const currentField = fields[fieldIndex];
      if (!currentField) {
        await send('Error de configuración. Escribe cualquier mensaje para volver al menú.');
        await sessionRef.set({ state: 'IDLE' }, { merge: true });
        return;
      }

      const isPhotoField = currentField.type === 'photo';

      if (isPhotoField) {
        if (incomingPhotoUrl) {
          // Acumular foto atómicamente
          const newLength = await this.firebase.db.runTransaction(async (tx) => {
            const docSnap = await tx.get(sessionRef);
            const existing: string[] = Array.isArray(docSnap.data()?.tempFieldPhotos) ? docSnap.data()!.tempFieldPhotos : [];
            const newPhotos = [...existing, incomingPhotoUrl];
            tx.set(sessionRef, { tempFieldPhotos: newPhotos, fieldValues, state: 'WAITING_FIELD' }, { merge: true });
            return newPhotos.length;
          });
          await send(`Foto ${newLength} recibida. Puedes enviar más fotos o escribe *listo* para continuar.`);
        } else if (body) {
          // Cualquier texto confirma las fotos recibidas
          const freshDoc = await sessionRef.get();
          const finalPhotos: string[] = Array.isArray(freshDoc.data()?.tempFieldPhotos) ? freshDoc.data()!.tempFieldPhotos : [];

          if (finalPhotos.length === 0 && currentField.required !== false) {
            await send(`Por favor envía al menos una foto para continuar con "${currentField.label}".`);
            return;
          }

          setNestedValue(fieldValues, currentField.key, finalPhotos);
          const nextIndex = fieldIndex + 1;
          if (nextIndex < fields.length) {
            await sessionRef.set({ fieldIndex: nextIndex, fieldValues, state: 'WAITING_FIELD', tempFieldPhotos: [] }, { merge: true });
            await send(this.buildFieldQuestion(fields[nextIndex]));
          } else {
            await this.createTicket(phone, sessionRef, fieldValues, send);
          }
        }
        return;
      }

      // Campo de tipo texto/numérico/booleano/lista
      if (!body) {
        await send(this.buildFieldQuestion(currentField));
        return;
      }

      let value: string;

      if (currentField.type === 'list' && currentField.options && currentField.options.length > 0) {
        const optIdx = parseInt(body) - 1;
        if (isNaN(optIdx) || optIdx < 0 || optIdx >= currentField.options.length) {
          const opts = currentField.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
          await send(`Opción no válida. Por favor selecciona:\n${opts}`);
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
      } else {
        value = currentField.normalize !== false ? normalizeText(body) : body.trim();
      }

      setNestedValue(fieldValues, currentField.key, value);
      const nextIndex = fieldIndex + 1;
      if (nextIndex < fields.length) {
        await sessionRef.set({ fieldIndex: nextIndex, fieldValues, state: 'WAITING_FIELD', tempFieldPhotos: [] }, { merge: true });
        await send(this.buildFieldQuestion(fields[nextIndex]));
      } else {
        await this.createTicket(phone, sessionRef, fieldValues, send);
      }

    // ─── VER TICKET: selección ───────────────────────────────────────────────
    } else if (state === 'WAITING_TICKET_SELECTION_VIEW') {
      const tickets: PendingTicket[] = session.pendingTickets || [];
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

    // ─── VER TICKET: opción info / fotos ────────────────────────────────────
    } else if (state === 'WAITING_VIEW_OPTION') {
      const ticket = session.pendingTicketData as PendingTicket;

      if (body === '1') {
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
        await sessionRef.set({ state: 'IDLE', pendingTicketData: null, pendingTickets: null }, { merge: true });

      } else if (body === '2') {
        const extraFields = ticket.extraFields || {};
        const allFields = await this.botConfig.getFields().catch(() => []);
        const photoFields = allFields.filter(f => f.type === 'photo');

        let hasPhotos = false;
        for (const field of photoFields) {
          const photos = getNestedValue(extraFields, field.key);
          if (Array.isArray(photos) && photos.length > 0) {
            hasPhotos = true;
            await send(`📷 *${field.label}* (${photos.length}):`);
            for (const url of photos) await sendPhoto(url);
          }
        }
        if (!hasPhotos) {
          await send('Este ticket no tiene fotos adjuntas.');
        }
        await sessionRef.set({ state: 'IDLE', pendingTicketData: null, pendingTickets: null }, { merge: true });

      } else {
        await send('Opción no válida. Responde *1* para ver info o *2* para ver fotos.');
      }

    // ─── EDITAR TICKET: selección de ticket ──────────────────────────────────
    } else if (state === 'WAITING_TICKET_SELECTION_EDIT') {
      const tickets: PendingTicket[] = session.pendingTickets || [];
      const idx = parseInt(body) - 1;
      if (isNaN(idx) || idx < 0 || idx >= tickets.length) {
        await send(`Por favor selecciona un número entre 1 y ${tickets.length}.`);
        return;
      }
      const selectedTicket = tickets[idx];

      const allFields = await this.botConfig.getFields();
      const editableFields = allFields.filter(f => f.source === 'bot');
      const fieldList = editableFields.map((f, i) => `${i + 1}. ${f.label}`).join('\n');

      await send(
        `¿Qué deseas editar en el ticket *${selectedTicket.ticketNumber}*?\n\n${fieldList}\n0. Cancelar`,
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

    // ─── EDITAR TICKET: selección de campo ───────────────────────────────────
    } else if (state === 'WAITING_EDIT_FIELD_SELECTION') {
      const editableFields = (session.editableFields as TicketField[]) || [];
      const ticketData = session.pendingTicketData as PendingTicket;

      if (body === '0') {
        await send('Operación cancelada.');
        await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null, editableFields: null }, { merge: true });
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
        const photos = (getNestedValue(ticketData.extraFields as Record<string, unknown> ?? {}, selectedField.key) as string[]) || [];
        const hasPhotos = photos.length > 0;
        const photoList = hasPhotos
          ? `Fotos actuales: ${photos.length}\n\n`
          : 'Este campo no tiene fotos aún.\n\n';
        await send(
          `${photoList}¿Qué deseas hacer?\n1. Reemplazar una foto${!hasPhotos ? ' (no disponible)' : ''}\n2. Agregar nuevas fotos\n0. Cancelar`,
        );
        await sessionRef.set({ state: 'WAITING_EDIT_PHOTO_ACTION', editFieldKey: selectedField.key }, { merge: true });
      } else {
        const currentValue = (getNestedValue(ticketData.extraFields as Record<string, unknown> ?? {}, selectedField.key) as string) || 'Sin valor';
        const currentDisplay = currentValue === 'true' ? 'Sí' : currentValue === 'false' ? 'No' : currentValue;
        await send(`Valor actual: *${currentDisplay}*\n\n${this.buildFieldQuestion(selectedField)}`);
        await sessionRef.set({ state: 'WAITING_EDIT_FIELD_VALUE', editFieldKey: selectedField.key, editFieldType: selectedField.type, editFieldOptions: selectedField.options || [] }, { merge: true });
      }

    // ─── EDITAR CAMPO DE TEXTO ────────────────────────────────────────────────
    } else if (state === 'WAITING_EDIT_FIELD_VALUE') {
      if (!body) {
        await send('Por favor ingresa el nuevo valor.');
        return;
      }
      const ticketId = session.pendingTicketId as string;
      const editFieldKey = session.editFieldKey as string;
      const editFieldType = session.editFieldType as string;
      const editFieldOptions = (session.editFieldOptions as string[]) || [];

      let newValue: string;
      if (editFieldType === 'list' && editFieldOptions.length > 0) {
        const optIdx = parseInt(body) - 1;
        if (isNaN(optIdx) || optIdx < 0 || optIdx >= editFieldOptions.length) {
          const opts = editFieldOptions.map((o, i) => `${i + 1}. ${o}`).join('\n');
          await send(`Opción no válida:\n${opts}`);
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
        newValue = body.trim();
      }

      if (ticketId) {
        await db.collection('tickets').doc(ticketId).update({
          [`extraFields.${editFieldKey}`]: newValue,
          'timestamps.updatedAt': Date.now(),
        });
        const msgsEdit = await this.botConfig.getMessages().catch(() => null);
        const ticketDataEdit = session.pendingTicketData as PendingTicket | null;
        const extraVarsEdit = this.flattenExtraFieldsForInterpolation(
          (ticketDataEdit?.extraFields as Record<string, unknown>) || {},
        );
        const editMsg = interpolate(
          msgsEdit?.ticketCreated ?? '✅ Ticket *{ticketNumber}* {action} exitosamente.\n\nTe notificaremos cuando haya actualizaciones de estados.',
          { ticketNumber: ticketDataEdit?.ticketNumber ?? '', action: 'editado', ...extraVarsEdit },
        );
        await send(editMsg);
      }
      await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null, editableFields: null, editFieldKey: null, editFieldType: null, editFieldOptions: null }, { merge: true });

    // ─── EDITAR FOTOS ─────────────────────────────────────────────────────────
    } else if (state === 'WAITING_EDIT_PHOTO_ACTION') {
      const ticketData = session.pendingTicketData as PendingTicket;
      const editFieldKey = session.editFieldKey as string;
      const photos = (getNestedValue(ticketData?.extraFields || {}, editFieldKey) as string[]) || [];

      if (body === '0') {
        await send('Operación cancelada.');
        await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null, editableFields: null }, { merge: true });
      } else if (body === '1') {
        if (photos.length === 0) {
          await send('No hay fotos para editar. Selecciona *2* para agregar fotos nuevas, o *0* para cancelar.');
          return;
        }
        const photoList = photos.map((_, i) => `Foto ${i + 1}`).join('\n');
        await send(`${photoList}\n\n¿Cuál deseas reemplazar? (responde el número o 0 para cancelar)`);
        await sessionRef.set({ state: 'WAITING_EDIT_PHOTO_SELECTION' }, { merge: true });
      } else if (body === '2') {
        await send('Adjunta las fotos que deseas agregar. Cuando termines, escribe *listo*.');
        await sessionRef.set({ state: 'WAITING_EDIT_ADD_PHOTOS', tempEditPhotos: [] }, { merge: true });
      } else {
        await send('Opción no válida. Responde *1* para editar, *2* para agregar, o *0* para cancelar.');
      }

    } else if (state === 'WAITING_EDIT_ADD_PHOTOS') {
      const latestDoc = await sessionRef.get();
      const ls = latestDoc.data() || {};
      let tempEditPhotos: string[] = Array.isArray(ls.tempEditPhotos) ? ls.tempEditPhotos : [];
      const ticketId = ls.pendingTicketId as string;
      const editFieldKey = ls.editFieldKey as string;

      if (body === '0') {
        await send('Operación cancelada.');
        await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null, editableFields: null, tempEditPhotos: null }, { merge: true });
      } else if (incomingPhotoUrl) {
        tempEditPhotos = [...tempEditPhotos, incomingPhotoUrl];
        await sessionRef.set({ tempEditPhotos }, { merge: true });
        await send(`✅ Foto ${tempEditPhotos.length} recibida. Adjunta más fotos o escribe *listo* para guardar.`);
      } else if (body) {
        if (tempEditPhotos.length === 0) {
          await send('Aún no has adjuntado ninguna foto. Envía imágenes y luego escribe *listo*, o escribe *0* para cancelar.');
          return;
        }
        const freshDoc = await sessionRef.get();
        const freshData = freshDoc.data() || {};
        const finalPhotos: string[] = Array.isArray(freshData.tempEditPhotos) ? freshData.tempEditPhotos : tempEditPhotos;

        const ticketSnap = await db.collection('tickets').doc(ticketId).get();
        const existing: string[] = (getNestedValue(ticketSnap.data()?.extraFields || {}, editFieldKey) as string[]) || [];

        await db.collection('tickets').doc(ticketId).update({
          [`extraFields.${editFieldKey}`]: [...existing, ...finalPhotos],
          'timestamps.updatedAt': Date.now(),
        });
        await send(`✅ ${finalPhotos.length} foto(s) agregada(s) correctamente.`);
        await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null, editableFields: null, tempEditPhotos: null }, { merge: true });
      }

    } else if (state === 'WAITING_EDIT_PHOTO_SELECTION') {
      const ticketData = session.pendingTicketData as PendingTicket;
      const editFieldKey = session.editFieldKey as string;
      const photos = (getNestedValue(ticketData?.extraFields || {}, editFieldKey) as string[]) || [];
      const photoIdx = parseInt(body) - 1;

      if (body === '0') {
        await send('Operación cancelada.');
        await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null, editableFields: null }, { merge: true });
        return;
      }
      if (isNaN(photoIdx) || photoIdx < 0 || photoIdx >= photos.length) {
        await send(`Por favor selecciona un número entre 1 y ${photos.length}, o 0 para cancelar.`);
        return;
      }
      await sessionRef.set({ state: 'WAITING_EDIT_NEW_PHOTO', pendingPhotoIndex: photoIdx }, { merge: true });
      await send(`Adjunta la nueva foto para reemplazar la *Foto ${photoIdx + 1}*:`);

    } else if (state === 'WAITING_EDIT_NEW_PHOTO') {
      if (!incomingPhotoUrl) {
        await send('Por favor adjunta una imagen para continuar.');
        return;
      }
      const latestSessionDoc = await sessionRef.get();
      const ls = latestSessionDoc.data() || {};
      const pendingPhotoIndex = ls.pendingPhotoIndex as number;
      const ticketId = ls.pendingTicketId as string;
      const editFieldKey = ls.editFieldKey as string;

      const ticketSnap = await db.collection('tickets').doc(ticketId).get();
      const currentPhotos: string[] = [...((getNestedValue(ticketSnap.data()?.extraFields || {}, editFieldKey) as string[]) || [])];

      if (pendingPhotoIndex >= 0 && pendingPhotoIndex < currentPhotos.length) {
        currentPhotos[pendingPhotoIndex] = incomingPhotoUrl;
      } else {
        currentPhotos.push(incomingPhotoUrl);
      }

      await db.collection('tickets').doc(ticketId).update({
        [`extraFields.${editFieldKey}`]: currentPhotos,
        'timestamps.updatedAt': Date.now(),
      });
      await send('✅ Foto actualizada correctamente.');
      await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingPhotoIndex: null, pendingTicketData: null, editableFields: null }, { merge: true });

    // ─── ELIMINAR TICKET ─────────────────────────────────────────────────────
    } else if (state === 'WAITING_TICKET_SELECTION_DELETE') {
      const tickets: PendingTicket[] = session.pendingTickets || [];
      const idx = parseInt(body) - 1;
      if (isNaN(idx) || idx < 0 || idx >= tickets.length) {
        await send(`Por favor selecciona un número entre 1 y ${tickets.length}.`);
        return;
      }
      const deletedTicket = tickets[idx];
      await db.collection('tickets').doc(deletedTicket.id).update({
        status: 'ARCHIVADO',
        'timestamps.updatedAt': Date.now(),
      });
      const msgsDelete = await this.botConfig.getMessages().catch(() => null);
      const extraVarsDelete = this.flattenExtraFieldsForInterpolation(
        (deletedTicket.extraFields as Record<string, unknown>) || {},
      );
      const deleteMsg = interpolate(
        msgsDelete?.ticketDeleted ?? '✅ Ticket *{ticketNumber}* eliminado correctamente.',
        { ticketNumber: deletedTicket.ticketNumber, ...extraVarsDelete },
      );
      await send(deleteMsg);
      await sessionRef.set({ state: 'IDLE', pendingTickets: null }, { merge: true });

    // ─── FINALIZAR TICKET ────────────────────────────────────────────────────
    } else if (state === 'WAITING_TICKET_SELECTION_FINALIZE') {
      const tickets: PendingTicket[] = session.pendingTickets || [];
      const idx = parseInt(body) - 1;
      if (isNaN(idx) || idx < 0 || idx >= tickets.length) {
        await send(`Por favor selecciona un número entre 1 y ${tickets.length}.`);
        return;
      }
      const ticket = tickets[idx];
      await db.collection('tickets').doc(ticket.id).update({
        status: 'ENTREGADO',
        'timestamps.updatedAt': Date.now(),
      });
      await send(`✅ Ticket *${ticket.ticketNumber}* marcado como ENTREGADO.`);
      await sessionRef.set({ state: 'IDLE', pendingTickets: null }, { merge: true });

    // ─── ACTUALIZACIÓN SOLICITADA POR ADMIN ──────────────────────────────────
    } else if (state === 'WAITING_ADMIN_REQUESTED_UPDATE') {
      await sessionRef.set({ state: 'IDLE', requestedFieldKey: null, requestedFieldLabel: null, requestedTicketId: null }, { merge: true });
      await send(msgs?.menu ?? MENU_FALLBACK);

    // ─── RESET ───────────────────────────────────────────────────────────────
    } else {
      await sessionRef.set({ state: 'IDLE' }, { merge: true });
      await send('Operación cancelada. Escribe cualquier mensaje para volver al menú.');
    }
  }

  async requestFieldUpdate(
    ticketId: string,
    fieldKey: string,
    fieldLabel: string,
    customMessage?: string,
  ): Promise<void> {
    const db = this.firebase.db;
    const ticketSnap = await db.collection('tickets').doc(ticketId).get();
    if (!ticketSnap.exists) throw new Error('Ticket no encontrado');
    const ticket = ticketSnap.data()!;
    const phone: string = ticket.reporter?.phone;
    if (!phone) throw new Error('El ticket no tiene teléfono de reportante');
    const ticketNumber: string = ticket.ticketNumber;

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const template =
      msgs?.adminRequestUpdate ??
      '📋 El administrador te solicita actualizar el campo *{fieldLabel}* de tu ticket *{ticketNumber}*.\n\nPara actualizar esta información, selecciona la opción *3* (Editar) en el menú.';

    const extraVars = this.flattenExtraFieldsForInterpolation(
      (ticket.extraFields as Record<string, unknown>) || {},
    );
    const msg = interpolate(template, {
      fieldLabel,
      ticketNumber,
      customMessage: customMessage || '',
      ...extraVars,
    });

    const sessionRef = db.collection('whatsapp_sessions').doc(phone);
    await sessionRef.set(
      { state: 'WAITING_ADMIN_REQUESTED_UPDATE', requestedFieldKey: fieldKey, requestedFieldLabel: fieldLabel, requestedTicketId: ticketId },
      { merge: true },
    );
    await this.sendMessage(phone, msg);
    await this.saveMessage(phone, 'bot', msg);
  }

  private async createTicket(
    phone: string,
    sessionRef: DocumentReference<DocumentData>,
    fieldValues: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const db = this.firebase.db;
    this.logger.log(`[${phone}] Creando ticket con ${Object.keys(fieldValues).length} campo(s).`);

    const ticketData: Record<string, unknown> = {
      ticketNumber: `TKT-${Math.floor(Math.random() * 90000) + 10000}`,
      status: 'REPORTADO',
      reporter: { phone, name: 'Usuario WhatsApp' },
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      extraFields: fieldValues,
    };

    const docRef = await db.collection('tickets').add(ticketData);
    this.logger.log(`[${phone}] Ticket creado: ${ticketData.ticketNumber} (ID: ${docRef.id})`);

    const hostRef = db.collection('hosts').doc(phone);
    const hostSnap = await hostRef.get();
    if (!hostSnap.exists) {
      await hostRef.set({ nombre: phone, telefono: phone, creadoEn: Date.now() });
    }

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const extraVarsCreate = this.flattenExtraFieldsForInterpolation(
      fieldValues as Record<string, unknown>,
    );
    const successMsg = interpolate(
      msgs?.ticketCreated ?? '✅ Ticket *{ticketNumber}* {action} exitosamente.\n\nTe notificaremos cuando haya actualizaciones de estados.',
      { ticketNumber: String(ticketData.ticketNumber), action: 'creado', ...extraVarsCreate },
    );
    await send(successMsg);
    await sessionRef.set(
      { state: 'IDLE', fieldValues: null, fieldIndex: null, tempFieldPhotos: null },
      { merge: true },
    );
  }

  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return challenge;
    }
    return null;
  }

  async getChatHistory(phone: string): Promise<Array<{ from: string; text?: string; photoUrl?: string; timestamp: number }>> {
    const sessionRef = this.firebase.db.collection('whatsapp_sessions').doc(phone);
    const sessionDoc = await sessionRef.get();
    const data = sessionDoc.data();
    return data?.messages || [];
  }
}
