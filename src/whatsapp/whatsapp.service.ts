import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { BotConfigService, interpolate } from '../bot-config/bot-config.service';
import { FieldValue, DocumentReference, DocumentData } from 'firebase-admin/firestore';

type WhatsAppMessage = {
  from?: string;
  type?: string;
  text?: { body?: string };
  image?: {
    mime_type?: string;
    id?: string;
    caption?: string;
    // Used by el simulador: la imagen ya está subida a Storage
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
  photos?: string[];
  repairPhotos?: string[];
  description?: string;
  ciudad?: string;
  canal?: string;
  punto?: string;
  createdAt?: number;
}

// Fallback estático por si la config de Firestore no está disponible
const MENU_FALLBACK =
  `Hola, a continuación te mostraré las diferentes funcionalidades que poseo:\n` +
  `1. Para crear un ticket presiona 1\n` +
  `2. Para ver el estado de tus tickets presiona 2\n` +
  `3. Para editar un ticket presiona 3\n` +
  `4. Para eliminar un ticket presiona 4\n` +
  `5. Para finalizar un ticket presiona 5`;

// Elimina tildes/diacríticos y convierte a mayúsculas para consistencia de datos
function normalizeText(text: string): string {
  return text
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly ticketStatusCache = new Map<string, string>();

  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
  ) {}

  onModuleInit() {
    this.startTicketStatusListener();
  }

  // Reemplaza onTicketStatusUpdated (Cloud Functions trigger)
  private startTicketStatusListener() {
    this.firebase.db.collection('tickets').onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
          const data = change.doc.data();
          const ticketId = change.doc.id;
          const newStatus = data.status as string;

          if (change.type === 'added') {
            this.ticketStatusCache.set(ticketId, newStatus);
            return;
          }

          if (change.type === 'modified') {
            const prevStatus = this.ticketStatusCache.get(ticketId);
            this.ticketStatusCache.set(ticketId, newStatus);

            if (prevStatus && prevStatus !== newStatus && newStatus !== 'ARCHIVADO') {
              const rawPhone = data.reporter?.phone as string;
              const phone = rawPhone ? this.normalizePhoneForWhatsApp(rawPhone) : '';
              if (phone) {
                if (newStatus === 'REPARADO') {
                  const repairPhotos = (data.photos?.repair as string[]) || [];
                  const description = (data.novelty?.description as string) || '';
                  const msgs = await this.botConfig.getMessages().catch(() => null);
                  const msg = repairPhotos.length > 0
                    ? interpolate((msgs?.reparadoMessage ?? 'Estas son las evidencias de que su ticket *{ticketNumber}* ha sido reparado:'), { ticketNumber: String(data.ticketNumber), description })
                    : interpolate((msgs?.statusChanged ?? 'El estado de su solicitud *{ticketNumber}* ha cambiado de "{prevStatus}" a "{newStatus}".'), { ticketNumber: String(data.ticketNumber), prevStatus: prevStatus!, newStatus });

                  await this.saveMessage(phone, 'bot', msg).catch((err) =>
                    this.logger.error('Error guardando notificación REPARADO:', err),
                  );
                  await this.sendMessage(phone, msg).catch((err) =>
                    this.logger.error('Error enviando notificación REPARADO:', err),
                  );

                  for (const photoUrl of repairPhotos) {
                    await this.saveMessage(phone, 'bot', '[imagen]', photoUrl).catch((err) =>
                      this.logger.error('Error guardando foto reparación en historial:', err),
                    );
                    await this.sendImageMessage(phone, photoUrl, 'Evidencia de reparación').catch((err) =>
                      this.logger.error('Error enviando foto de reparación:', err),
                    );
                  }
                } else {
                  const msgs = await this.botConfig.getMessages().catch(() => null);
                  const msg = interpolate(
                    (msgs?.statusChanged ?? 'El estado de su solicitud *{ticketNumber}* ha cambiado de "{prevStatus}" a "{newStatus}".'),
                    { ticketNumber: String(data.ticketNumber), prevStatus: prevStatus!, newStatus },
                  );
                  await this.saveMessage(phone, 'bot', msg).catch((err) =>
                    this.logger.error('Error guardando notificación en historial:', err),
                  );
                  await this.sendMessage(phone, msg).catch((err) =>
                    this.logger.error('Error en notificación de estado:', err),
                  );
                }
              }
            }
          }
        });
      },
      (err) => this.logger.error('Error en listener de tickets:', err),
    );
    this.logger.log('Listener de cambios de estado de tickets activo.');
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
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
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

  // Guarda un mensaje en el historial de la sesión (visible para el admin)
  async saveMessage(
    phone: string,
    from: 'user' | 'bot' | 'admin',
    text: string,
    photoUrl?: string,
  ) {
    const ref = this.firebase.db.collection('whatsapp_sessions').doc(phone);
    const entry: Record<string, unknown> = {
      from,
      text,
      timestamp: Date.now(),
    };
    if (photoUrl) entry.photoUrl = photoUrl;
    await ref.set(
      { messages: FieldValue.arrayUnion(entry) },
      { merge: true },
    );
  }

  // Responde: guarda en historial y envía (o colecciona para el simulador)
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

  // Endpoint admin: enviar mensaje manualmente a un usuario
  async sendAdminMessage(to: string, text: string) {
    await this.saveMessage(to, 'admin', text);
    await this.sendMessage(to, text);
  }

  // Habilita o deshabilita las respuestas automáticas del bot para una sesión
  async toggleBotForSession(phone: string, botEnabled: boolean) {
    const ref = this.firebase.db.collection('whatsapp_sessions').doc(phone);
    await ref.set({ botEnabled }, { merge: true });
    this.logger.log(`[${phone}] Bot ${botEnabled ? 'habilitado' : 'deshabilitado'}`);
  }

  private formatTicketsList(tickets: PendingTicket[]): string {
    return tickets
      .map((t, i) => {
        const lines = [`${i + 1}. *${t.ticketNumber}*`];
        if (t.punto) lines.push(`   Punto de venta: ${t.punto}`);
        lines.push(`   Estado: ${t.status}`);
        return lines.join('\n');
      })
      .join('\n\n');
  }

  private formatTicketsListWithDate(tickets: PendingTicket[]): string {
    return tickets
      .map((t, i) => {
        const dateStr = t.createdAt
          ? new Date(t.createdAt).toLocaleDateString('es-CO')
          : 'Sin fecha';
        const lines = [`${i + 1}. *${t.ticketNumber}*`, `   Fecha: ${dateStr}`];
        if (t.punto) lines.push(`   Punto de venta: ${t.punto}`);
        lines.push(`   Estado: ${t.status}`);
        return lines.join('\n');
      })
      .join('\n\n');
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
          photos: (data.photos?.evidence as string[]) || [],
          repairPhotos: (data.photos?.repair as string[]) || [],
          description: (data.novelty?.description as string) || '',
          ciudad: (data.ciudad as string) || '',
          canal: (data.canal as string) || '',
          punto: (data.point?.name as string) || '',
          createdAt: data.timestamps?.createdAt as number | undefined,
        };
      })
      .filter((t) => t.status !== 'ARCHIVADO');
  }

  // Sube un buffer arbitrario a Storage (usado por el simulador).
  // Devuelve la URL pública del archivo.
  async uploadBufferToStorage(
    buffer: Buffer,
    mimeType: string,
    phone: string,
  ): Promise<string> {
    try {
      const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
      if (!storageBucket) {
        this.logger.error('FIREBASE_STORAGE_BUCKET no está configurado');
        return '';
      }
      const bucket = this.firebase.storage.bucket(storageBucket);
      const ext = (mimeType.split('/')[1] || 'jpeg').toLowerCase();
      const filePath = `whatsapp_media/${phone}/${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
      const file = bucket.file(filePath);
      await file.save(buffer, { metadata: { contentType: mimeType } });
      await file.makePublic();
      const url = file.publicUrl();
      this.logger.log(`[${phone}] Imagen guardada en Storage: ${url}`);
      return url;
    } catch (err) {
      this.logger.error('Error subiendo buffer a Storage:', err);
      return '';
    }
  }

  private async uploadMedia(
    mediaId: string,
    mimeType: string,
    phone: string,
  ): Promise<string> {
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
      if (!storageBucket) {
        this.logger.error('FIREBASE_STORAGE_BUCKET no está configurado');
        return '';
      }
      const bucket = this.firebase.storage.bucket(storageBucket);
      const ext = mimeType.split('/')[1] || 'jpeg';
      const filePath = `whatsapp_media/${phone}/${Date.now()}_${mediaId}.${ext}`;
      const file = bucket.file(filePath);

      await file.save(Buffer.from(buffer), { metadata: { contentType: mimeType } });
      await file.makePublic();
      const url = file.publicUrl();
      this.logger.log(`[${phone}] Media de WhatsApp guardada en Storage: ${url}`);
      return url;
    } catch (err) {
      this.logger.error('Error subiendo media a Storage:', err);
      return '';
    }
  }

  // Asegura que el teléfono tenga código de país (57 para Colombia si tiene 10 dígitos)
  private normalizePhoneForWhatsApp(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
    return digits;
  }

  // Procesa un mensaje entrante. Si se pasa onResponse, las respuestas se colectan
  // en lugar de enviarse por WhatsApp (usado por el simulador).
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

    // Verificar si el bot está habilitado. Por defecto está activo (true)
    const botEnabled = session.botEnabled !== false;

    // Extraer URL de imagen entrante (una sola vez para todos los estados)
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
        await this.saveMessage(
          phone,
          'user',
          message.image.caption || '[imagen]',
          incomingPhotoUrl,
        );
      }
    } else {
      await this.saveMessage(phone, 'user', body || '[imagen]');
    }

    // Si el bot está deshabilitado, solo guardar el mensaje y retornar
    if (!botEnabled) {
      this.logger.log(`[${phone}] Bot deshabilitado. Mensaje guardado sin respuesta automática.`);
      return;
    }

    const send = (text: string) => this.reply(phone, text, onResponse);
    const sendPhoto = (url: string) => this.reply(phone, '[imagen]', onResponse, url);

    // ─── IDLE ────────────────────────────────────────────────────────────────
    if (state === 'IDLE') {
      if (body === '1') {
        const allFields = await this.botConfig.getFields();
        const fields = allFields.filter(f => f.source === 'bot');
        if (fields.length === 0) {
          await send('El sistema no tiene campos configurados para crear tickets. Contacta al administrador.');
          return;
        }
        await send(fields[0].question);
        await sessionRef.set(
          { state: 'WAITING_FIELD', fieldIndex: 0, fieldValues: {}, tempPhotos: [] },
          { merge: true },
        );
      } else if (body === '2') {
        const myTickets = await this.getTicketsByPhone(phone);
        if (myTickets.length === 0) {
          await send('No tienes tickets registrados aún. ¿Puedo ayudarte en algo más?');
        } else {
          const list = this.formatTicketsListWithDate(myTickets);
          await send(`Tus tickets:\n\n${list}\n\nResponde el número del ticket que deseas consultar:`);
          await sessionRef.set(
            { state: 'WAITING_TICKET_SELECTION_VIEW', pendingTickets: myTickets },
            { merge: true },
          );
        }
      } else if (body === '3' || body === '4' || body === '5') {
        const tickets = await this.getTicketsByPhone(phone);
        if (tickets.length === 0) {
          await send('No tienes tickets registrados. ¿Puedo ayudarte en algo más?');
          return;
        }
        const list = this.formatTicketsList(tickets);
        await sessionRef.set({ pendingTickets: tickets }, { merge: true });

        if (body === '3') {
          await send(
            `Tus tickets:\n${list}\n\nSelecciona el número del ticket que deseas *editar*:`,
          );
          await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_EDIT' }, { merge: true });
        } else if (body === '4') {
          await send(
            `Tus tickets:\n${list}\n\nSelecciona el número del ticket que deseas *eliminar*:`,
          );
          await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_DELETE' }, { merge: true });
        } else {
          await send(
            `Tus tickets:\n${list}\n\nSelecciona el número del ticket que deseas *finalizar*:`,
          );
          await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_FINALIZE' }, { merge: true });
        }
      } else {
        const msgs = await this.botConfig.getMessages().catch(() => null);
        await send(msgs?.menu ?? MENU_FALLBACK);
      }

    // ─── FLUJO DINÁMICO DE CAMPOS ────────────────────────────────────────────
    } else if (state === 'WAITING_FIELD') {
      const allFields = await this.botConfig.getFields();
      const fields = allFields.filter(f => f.source === 'bot');
      const fieldIndex: number = typeof session.fieldIndex === 'number' ? session.fieldIndex : 0;
      const fieldValues: Record<string, string> = session.fieldValues || {};

      const currentField = fields[fieldIndex];
      if (!currentField) {
        await send('Error de configuración. Escribe cualquier mensaje para volver al menú.');
        await sessionRef.set({ state: 'IDLE' }, { merge: true });
        return;
      }

      // Detectar si es campo de foto por tipo O por clave
      const isPhotoField = currentField.type === 'photo' || currentField.key?.includes('photo');

      // Si el campo es de tipo foto y llegó una foto, usarla directamente
      if (isPhotoField && incomingPhotoUrl) {
        const nextIndex = fieldIndex + 1;
        if (nextIndex < fields.length) {
          fieldValues[currentField.key] = incomingPhotoUrl;
          await sessionRef.set({ fieldIndex: nextIndex, fieldValues, state: 'WAITING_FIELD' }, { merge: true });
          await send(fields[nextIndex].question);
        } else {
          // Último campo: acumular foto atómicamente y esperar confirmación por texto
          const newLength = await this.firebase.db.runTransaction(async (tx) => {
            const doc = await tx.get(sessionRef);
            const existing: string[] = Array.isArray(doc.data()?.tempPhotos) ? doc.data()!.tempPhotos : [];
            const newPhotos = [...existing, incomingPhotoUrl];
            tx.set(sessionRef, { state: 'WAITING_PHOTOS_AND_DESC', fieldValues, targetPhone: phone, tempPhotos: newPhotos }, { merge: true });
            return newPhotos.length;
          });
          await send(`Foto ${newLength} recibida. Puedes enviar más fotos o escribe *listo* para crear el ticket.`);
        }
        return;
      }

      // Si el campo es de tipo foto pero no llegó foto, pedir que envíe
      if (isPhotoField && !incomingPhotoUrl) {
        if (body === '0' && currentField.required === false) {
          // Permitir saltar campos no requeridos
          fieldValues[currentField.key] = '';
          const nextIndex = fieldIndex + 1;
          if (nextIndex < fields.length) {
            await sessionRef.set({ fieldIndex: nextIndex, fieldValues, state: 'WAITING_FIELD' }, { merge: true });
            await send(fields[nextIndex].question);
          } else {
            await sessionRef.set(
              { state: 'WAITING_PHOTOS_AND_DESC', fieldValues, targetPhone: phone, tempPhotos: [] },
              { merge: true },
            );
            await send('Por favor sube las fotos y confirma.');
          }
        } else {
          await send(currentField.question);
        }
        return;
      }

      // Para campos de texto
      if (!body) {
        await send(fields[fieldIndex].question);
        return;
      }

      const value = currentField.normalize !== false ? normalizeText(body) : body.trim();
      fieldValues[currentField.key] = value;

      const nextIndex = fieldIndex + 1;
      if (nextIndex < fields.length) {
        await sessionRef.set({ fieldIndex: nextIndex, fieldValues, state: 'WAITING_FIELD' }, { merge: true });
        await send(fields[nextIndex].question);
      } else {
        await sessionRef.set(
          { state: 'WAITING_PHOTOS_AND_DESC', fieldValues, targetPhone: phone, tempPhotos: [] },
          { merge: true },
        );
        await send('Por favor sube las fotos y confirma.');
      }

    // ─── CREAR TICKET: Ciudad → Canal → Punto (legacy) ───────────────────────
    } else if (state === 'WAITING_CITY') {
      if (!body) {
        await send('Por favor ingresa el nombre de la ciudad:');
        return;
      }
      await sessionRef.set(
        { state: 'WAITING_CANAL', tempCity: normalizeText(body) },
        { merge: true },
      );
      await send('¿Cuál es el canal de venta? (ejemplo: Retail, Operador, Online):');

    } else if (state === 'WAITING_CANAL') {
      if (!body) {
        await send('Por favor ingresa el canal de venta:');
        return;
      }
      await sessionRef.set(
        { state: 'WAITING_PUNTO_VENTA', tempCanal: normalizeText(body) },
        { merge: true },
      );
      await send('¿Cuál es el nombre del punto de venta?');

    } else if (state === 'WAITING_PUNTO_VENTA') {
      if (!body) {
        await send('Por favor ingresa el nombre del punto de venta:');
        return;
      }
      // El teléfono del reportante es el mismo número de WhatsApp del usuario
      await sessionRef.set(
        { state: 'WAITING_PHOTOS_AND_DESC', tempPunto: normalizeText(body), tempPhotos: [], targetPhone: phone },
        { merge: true },
      );
      await send('Sube unas fotos y añade una descripción para el ticket.');

    } else if (state === 'WAITING_PHOTOS_AND_DESC') {
      const targetPhone: string = session.targetPhone || phone;

      if (incomingPhotoUrl) {
        // ⚠️ Transacción para evitar race condition cuando llegan múltiples fotos en paralelo
        const newLength = await this.firebase.db.runTransaction(async (tx) => {
          const doc = await tx.get(sessionRef);
          const existing: string[] = Array.isArray(doc.data()?.tempPhotos) ? doc.data()!.tempPhotos : [];
          const newPhotos = [...existing, incomingPhotoUrl];
          tx.set(sessionRef, { tempPhotos: newPhotos, state: 'WAITING_PHOTOS_AND_DESC', targetPhone }, { merge: true });
          return newPhotos.length;
        });
        await send(`Foto ${newLength} recibida. Puedes enviar más fotos o escribe *listo* para crear el ticket.`);
      } else if (message.type === 'text' && body) {
        const freshDoc = await sessionRef.get();
        const freshData = freshDoc.data() || {};
        const finalPhotos: string[] = Array.isArray(freshData.tempPhotos) ? freshData.tempPhotos : [];
        if (finalPhotos.length === 0) {
          await send('Por favor envía al menos una foto.');
          return;
        }
        const fieldValues: Record<string, string> = (freshData.fieldValues as Record<string, string>) || {};
        await this.createTicket(
          phone, targetPhone, sessionRef, finalPhotos, body,
          fieldValues,
          { tempCity: freshData.tempCity as string, tempCanal: freshData.tempCanal as string, tempPunto: freshData.tempPunto as string },
          send,
        );
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
      await sessionRef.set(
        { state: 'WAITING_VIEW_OPTION', pendingTicketData: selected },
        { merge: true },
      );
      await send(
        `Ticket *${selected.ticketNumber}* — ${selected.status}\n\n` +
        `¿Qué deseas ver?\n1. Info del ticket\n2. Ver fotos`,
      );

    // ─── VER TICKET: opción info / fotos ────────────────────────────────────
    } else if (state === 'WAITING_VIEW_OPTION') {
      const ticket = session.pendingTicketData as PendingTicket;

      if (body === '1') {
        const dateStr = ticket.createdAt
          ? new Date(ticket.createdAt).toLocaleDateString('es-CO')
          : 'Sin fecha';
        const info =
          `📋 *${ticket.ticketNumber}*\n` +
          `Estado: ${ticket.status}\n` +
          `Fecha: ${dateStr}\n` +
          (ticket.ciudad ? `Ciudad: ${ticket.ciudad}\n` : '') +
          (ticket.canal ? `Canal: ${ticket.canal}\n` : '') +
          (ticket.punto ? `Punto: ${ticket.punto}\n` : '') +
          (ticket.description ? `Descripción: ${ticket.description}` : '');
        await send(info);
        await sessionRef.set({ state: 'IDLE', pendingTicketData: null, pendingTickets: null }, { merge: true });

      } else if (body === '2') {
        const evidencia = ticket.photos || [];
        const reparacion = ticket.repairPhotos || [];
        if (evidencia.length === 0 && reparacion.length === 0) {
          await send('Este ticket no tiene fotos adjuntas.');
        } else {
          if (evidencia.length > 0) {
            await send(`📷 Fotos de evidencia de *${ticket.ticketNumber}* (${evidencia.length}):`);
            for (const url of evidencia) await sendPhoto(url);
          }
          if (reparacion.length > 0) {
            await send(`🔧 Fotos de reparación (${reparacion.length}):`);
            for (const url of reparacion) await sendPhoto(url);
          }
        }
        await sessionRef.set({ state: 'IDLE', pendingTicketData: null, pendingTickets: null }, { merge: true });

      } else {
        await send('Opción no válida. Responde *1* para ver info o *2* para ver fotos.');
      }

    // ─── VER ESTADO (legacy) ─────────────────────────────────────────────────
    } else if (state === 'WAITING_PHONE_FOR_STATUS') {
      const tickets = await this.getTicketsByPhone(body);
      if (tickets.length === 0) {
        await send('No encontré tickets para ese número. ¿Deseas hacer algo más?');
        await sessionRef.set({ state: 'IDLE' }, { merge: true });
        return;
      }
      const list = this.formatTicketsList(tickets);
      await send(`Tus tickets:\n${list}`);
      // Enviar fotos de cada ticket para que el usuario pueda revisarlas
      for (const t of tickets) {
        if (t.photos && t.photos.length > 0) {
          await send(`📷 Fotos de *${t.ticketNumber}*:`);
          for (const url of t.photos) {
            await sendPhoto(url);
          }
        }
      }
      await send(
        `¿Deseas:\n1. Editar\n2. Eliminar\n3. Terminar algún ticket?\n` +
        `Responde *No* para salir del chat.`,
      );
      await sessionRef.set(
        { state: 'WAITING_ACTION_AFTER_STATUS', pendingTickets: tickets, targetPhone: body },
        { merge: true },
      );

    } else if (state === 'WAITING_ACTION_AFTER_STATUS') {
      const tickets: PendingTicket[] = session.pendingTickets || [];
      const list = this.formatTicketsList(tickets);

      if (body === '1') {
        await send(`${list}\n\nSelecciona el número del ticket que deseas *editar*:`);
        await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_EDIT' }, { merge: true });
      } else if (body === '2') {
        await send(`${list}\n\nSelecciona el número del ticket que deseas *eliminar*:`);
        await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_DELETE' }, { merge: true });
      } else if (body === '3') {
        await send(`${list}\n\nSelecciona el número del ticket que deseas *finalizar*:`);
        await sessionRef.set({ state: 'WAITING_TICKET_SELECTION_FINALIZE' }, { merge: true });
      } else {
        await send('Hasta luego 👋. Escribe cualquier mensaje para volver al menú.');
        await sessionRef.set({ state: 'IDLE', pendingTickets: null }, { merge: true });
      }

    // ─── EDITAR TICKET ───────────────────────────────────────────────────────
    } else if (state === 'WAITING_TICKET_SELECTION_EDIT') {
      const tickets: PendingTicket[] = session.pendingTickets || [];
      const idx = parseInt(body) - 1;
      if (isNaN(idx) || idx < 0 || idx >= tickets.length) {
        await send(`Por favor selecciona un número entre 1 y ${tickets.length}.`);
        return;
      }
      const selectedTicket = tickets[idx];
      await sessionRef.set(
        {
          state: 'WAITING_EDIT_FIELD_SELECTION',
          pendingTicketId: selectedTicket.id,
          pendingTicketData: selectedTicket,
        },
        { merge: true },
      );
      await send(
        `¿Qué deseas editar en el ticket *${selectedTicket.ticketNumber}*?\n\n` +
        `1. Fotos\n` +
        `2. Ciudad\n` +
        `3. Punto de venta\n` +
        `4. Canal\n` +
        `5. Descripción`,
      );

    } else if (state === 'WAITING_EDIT_FIELD_SELECTION') {
      const ticketData = session.pendingTicketData as PendingTicket;

      if (body === '1') {
        const photos = ticketData?.photos || [];
        const hasPhotos = photos.length > 0;
        const photoList = hasPhotos
          ? `Fotos actuales:\n${photos.map((_, i) => `Foto ${i + 1}`).join('\n')}\n\n`
          : 'Este ticket aún no tiene fotos de evidencia.\n\n';
        await send(
          `${photoList}¿Qué deseas hacer?\n1. Editar una foto existente${!hasPhotos ? ' (no disponible)' : ''}\n2. Agregar nuevas fotos\n0. Cancelar`,
        );
        await sessionRef.set({ state: 'WAITING_EDIT_PHOTO_ACTION' }, { merge: true });

      } else if (body === '2') {
        await send(`Ciudad actual: *${ticketData?.ciudad || 'Sin ciudad'}*\n\n¿Cuál es la nueva ciudad?`);
        await sessionRef.set({ state: 'WAITING_EDIT_CITY' }, { merge: true });

      } else if (body === '3') {
        await send(`Punto de venta actual: *${ticketData?.punto || 'Sin punto'}*\n\n¿Cuál es el nuevo punto de venta?`);
        await sessionRef.set({ state: 'WAITING_EDIT_PUNTO' }, { merge: true });

      } else if (body === '4') {
        await send(`Canal actual: *${ticketData?.canal || 'Sin canal'}*\n\n¿Cuál es el nuevo canal?`);
        await sessionRef.set({ state: 'WAITING_EDIT_CANAL' }, { merge: true });

      } else if (body === '5') {
        await send(`Descripción actual: *${ticketData?.description || 'Sin descripción'}*\n\n¿Cuál es la nueva descripción?`);
        await sessionRef.set({ state: 'WAITING_NEW_DESCRIPTION' }, { merge: true });

      } else if (body === '0') {
        await send('Operación cancelada.');
        await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null }, { merge: true });

      } else {
        await send(
          `Opción no válida. ¿Qué deseas editar en el ticket *${ticketData?.ticketNumber}*?\n\n` +
          `1. Fotos\n2. Ciudad\n3. Punto de venta\n4. Canal\n5. Descripción\n0. Cancelar`,
        );
      }

    } else if (state === 'WAITING_EDIT_PHOTO_ACTION') {
      const ticketData = session.pendingTicketData as PendingTicket;
      const photos = ticketData?.photos || [];

      if (body === '0') {
        await send('Operación cancelada.');
        await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null }, { merge: true });

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
      // ⚠️ Releer tempEditPhotos de Firestore (puede haber varias imágenes en paralelo)
      const latestDoc = await sessionRef.get();
      const ls = latestDoc.data() || {};
      let tempEditPhotos: string[] = Array.isArray(ls.tempEditPhotos) ? ls.tempEditPhotos : [];
      const ticketId = ls.pendingTicketId as string;

      if (body === '0') {
        await send('Operación cancelada.');
        await sessionRef.set(
          { state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null, tempEditPhotos: null },
          { merge: true },
        );
      } else if (incomingPhotoUrl) {
        tempEditPhotos = [...tempEditPhotos, incomingPhotoUrl];
        await sessionRef.set({ tempEditPhotos }, { merge: true });
        await send(`✅ Foto ${tempEditPhotos.length} recibida. Adjunta más fotos o escribe *listo* para guardar.`);

      } else if (body) {
        if (tempEditPhotos.length === 0) {
          await send('Aún no has adjuntado ninguna foto. Envía imágenes y luego escribe *listo*, o escribe *0* para cancelar.');
          return;
        }
        // Cualquier texto distinto de "0" confirma el guardado
        const freshDoc = await sessionRef.get();
        const freshData = freshDoc.data() || {};
        const finalPhotos: string[] = Array.isArray(freshData.tempEditPhotos)
          ? freshData.tempEditPhotos
          : tempEditPhotos;

        const ticketSnap = await db.collection('tickets').doc(ticketId).get();
        const existing: string[] = (ticketSnap.data()?.photos?.evidence as string[]) || [];

        await db.collection('tickets').doc(ticketId).update({
          'photos.evidence': [...existing, ...finalPhotos],
          'timestamps.updatedAt': Date.now(),
        });
        await send(`✅ ${finalPhotos.length} foto(s) agregada(s) al ticket correctamente.`);
        await sessionRef.set(
          { state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null, tempEditPhotos: null },
          { merge: true },
        );
      }

    } else if (state === 'WAITING_EDIT_PHOTO_SELECTION') {
      const ticketData = session.pendingTicketData as PendingTicket;
      const photos = ticketData?.photos || [];
      const photoIdx = parseInt(body) - 1;

      if (body === '0') {
        await send('Operación cancelada.');
        await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null }, { merge: true });
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

      const ticketSnap = await db.collection('tickets').doc(ticketId).get();
      const currentPhotos: string[] = [...((ticketSnap.data()?.photos?.evidence as string[]) || [])];

      if (pendingPhotoIndex >= 0 && pendingPhotoIndex < currentPhotos.length) {
        currentPhotos[pendingPhotoIndex] = incomingPhotoUrl;
      } else {
        currentPhotos.push(incomingPhotoUrl);
      }

      await db.collection('tickets').doc(ticketId).update({
        'photos.evidence': currentPhotos,
        'timestamps.updatedAt': Date.now(),
      });
      await send('✅ Foto actualizada correctamente.');
      await sessionRef.set(
        { state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingPhotoIndex: null, pendingTicketData: null },
        { merge: true },
      );

    } else if (state === 'WAITING_EDIT_CITY') {
      if (!body) {
        await send('Por favor ingresa el nombre de la ciudad:');
        return;
      }
      const ticketId = session.pendingTicketId as string;
      if (ticketId) {
        await db.collection('tickets').doc(ticketId).update({
          ciudad: normalizeText(body),
          'timestamps.updatedAt': Date.now(),
        });
        await send('✅ Ciudad actualizada correctamente.');
      }
      await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null }, { merge: true });

    } else if (state === 'WAITING_EDIT_CANAL') {
      if (!body) {
        await send('Por favor ingresa el canal:');
        return;
      }
      const ticketId = session.pendingTicketId as string;
      if (ticketId) {
        await db.collection('tickets').doc(ticketId).update({
          canal: normalizeText(body),
          'timestamps.updatedAt': Date.now(),
        });
        await send('✅ Canal actualizado correctamente.');
      }
      await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null }, { merge: true });

    } else if (state === 'WAITING_EDIT_PUNTO') {
      if (!body) {
        await send('Por favor ingresa el punto de venta:');
        return;
      }
      const ticketId = session.pendingTicketId as string;
      if (ticketId) {
        const normalized = normalizeText(body);
        await db.collection('tickets').doc(ticketId).update({
          'point.name': normalized,
          'point.id': normalized.toLowerCase().replace(/\s+/g, '_'),
          'timestamps.updatedAt': Date.now(),
        });
        await send('✅ Punto de venta actualizado correctamente.');
      }
      await sessionRef.set({ state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null }, { merge: true });

    } else if (state === 'WAITING_NEW_DESCRIPTION') {
      const ticketId: string = session.pendingTicketId;
      if (ticketId) {
        await db.collection('tickets').doc(ticketId).update({
          'novelty.description': body,
          'timestamps.updatedAt': Date.now(),
        });
        await send('✅ Ticket actualizado correctamente.');
      }
      await sessionRef.set(
        { state: 'IDLE', pendingTicketId: null, pendingTickets: null, pendingTicketData: null },
        { merge: true },
      );

    // ─── ELIMINAR TICKET ─────────────────────────────────────────────────────
    } else if (state === 'WAITING_TICKET_SELECTION_DELETE') {
      const tickets: PendingTicket[] = session.pendingTickets || [];
      const idx = parseInt(body) - 1;
      if (isNaN(idx) || idx < 0 || idx >= tickets.length) {
        await send(`Por favor selecciona un número entre 1 y ${tickets.length}.`);
        return;
      }
      await db.collection('tickets').doc(tickets[idx].id).update({
        status: 'ARCHIVADO',
        'timestamps.updatedAt': Date.now(),
      });
      await send(`✅ Ticket *${tickets[idx].ticketNumber}* eliminado correctamente.`);
      await sessionRef.set(
        { state: 'IDLE', pendingTickets: null },
        { merge: true },
      );

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
        status: 'FINALIZADO',
        'timestamps.updatedAt': Date.now(),
      });
      await send(`✅ Ticket *${ticket.ticketNumber}* marcado como FINALIZADO.`);
      await sessionRef.set(
        { state: 'IDLE', pendingTickets: null },
        { merge: true },
      );

    // ─── NOTIFICACIÓN DE ACTUALIZACIÓN SOLICITADA POR ADMIN ─────────────────
    // El admin notificó al usuario. Cuando el usuario escribe, vuelve al menú normal.
    } else if (state === 'WAITING_ADMIN_REQUESTED_UPDATE') {
      await sessionRef.set(
        { state: 'IDLE', requestedFieldKey: null, requestedFieldLabel: null, requestedTicketId: null },
        { merge: true },
      );
      const msgs = await this.botConfig.getMessages().catch(() => null);
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

    const msg = customMessage
      ? `📋 El administrador te solicita actualizar el campo *${fieldLabel}* de tu ticket *${ticketNumber}*.\n\n_${customMessage}_\n\nPara actualizar esta información, selecciona la opción *3* (Editar) en el menú.`
      : `📋 El administrador te solicita actualizar el campo *${fieldLabel}* de tu ticket *${ticketNumber}*.\n\nPara actualizar esta información, selecciona la opción *3* (Editar) en el menú.`;

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
    targetPhone: string,
    sessionRef: DocumentReference<DocumentData>,
    photos: string[],
    description: string,
    fieldValues: Record<string, string>,
    legacyData: { tempCity?: string; tempCanal?: string; tempPunto?: string },
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const db = this.firebase.db;
    this.logger.log(`[${phone}] Creando ticket con ${photos.length} foto(s). Descripción: "${description}"`);

    const ciudad = fieldValues.ciudad || legacyData.tempCity || '';
    const canal = fieldValues.canal || legacyData.tempCanal || '';
    const punto = fieldValues.punto || legacyData.tempPunto || '';

    const standardKeys = new Set(['ciudad', 'canal', 'punto', 'photos.repair', 'novelty.type', 'novelty.description']);
    const extraFields: Record<string, string> = {};
    Object.entries(fieldValues).forEach(([k, v]) => {
      if (!standardKeys.has(k)) extraFields[k] = v;
    });

    const ticketData: Record<string, unknown> = {
      ticketNumber: `TKT-${Math.floor(Math.random() * 90000) + 10000}`,
      status: 'REPORTADO',
      ciudad,
      canal,
      point: { id: punto.toLowerCase().replace(/\s+/g, '_') || 'unknown', name: punto || 'Sin punto' },
      reporter: { phone: targetPhone, name: 'Usuario WhatsApp' },
      novelty: { type: fieldValues['novelty.type'] || 'unknown', description: fieldValues['novelty.description'] || description },
      photos: { evidence: photos, repair: [], delivery: [] },
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
    };
    const docRef = await db.collection('tickets').add(ticketData);
    this.logger.log(`[${phone}] Ticket creado: ${ticketData.ticketNumber} (ID: ${docRef.id})`);

    const hostRef = db.collection('hosts').doc(targetPhone);
    const hostSnap = await hostRef.get();
    if (!hostSnap.exists) {
      await hostRef.set({ nombre: targetPhone, telefono: targetPhone, creadoEn: Date.now() });
    }

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const successMsg = interpolate(
      msgs?.ticketCreated ?? '✅ Ticket *{ticketNumber}* creado exitosamente.\n\nTe notificaremos cuando haya actualizaciones de estados.',
      { ticketNumber: String(ticketData.ticketNumber) },
    );
    await send(successMsg);
    await sessionRef.set(
      { state: 'IDLE', tempPhotos: [], targetPhone: null, tempCity: null, tempCanal: null, tempPunto: null, fieldValues: null, fieldIndex: null },
      { merge: true },
    );
  }

  // Verifica el webhook de Meta (GET)
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return challenge;
    }
    return null;
  }

  // Obtiene el historial de conversación de un usuario
  async getChatHistory(phone: string): Promise<Array<{ from: string; text?: string; photoUrl?: string; timestamp: number }>> {
    const sessionRef = this.firebase.db.collection('whatsapp_sessions').doc(phone);
    const sessionDoc = await sessionRef.get();
    const data = sessionDoc.data();
    return data?.messages || [];
  }
}
