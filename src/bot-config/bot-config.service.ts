import { Injectable } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

export interface BotMessages {
  menu: string;
  ticketCreated: string;
  statusChanged: string;
  reparadoMessage: string;
  noTickets: string;
  invalidField: string;
  cancelled: string;
  goodbye: string;
  viewTicketOptions: string;
  backToMenuKeyword: string;
  adminRequestUpdate: string;
  ticketSelectPrompt: string;
  ticketListItemTemplate: string;
}

export interface TicketField {
  key: string;
  label: string;
  question?: string;
  placeholder?: string;
  order: number;
  normalize: boolean;
  visible?: boolean;
  type?: 'string' | 'numeric' | 'date' | 'photo' | 'video' | 'boolean' | 'list';
  source?: 'bot' | 'admin' | 'auto';
  required?: boolean;
  options?: string[];
}

export interface SystemFieldConfig {
  key: string;
  label: string;
  visible: boolean;
}

export const DEFAULT_MESSAGES: BotMessages = {
  menu:
    'Hola, a continuación te mostraré las diferentes funcionalidades que poseo:\n' +
    '1. Para crear un ticket presiona 1\n' +
    '2. Para ver el estado de tus tickets presiona 2\n' +
    '3. Para editar un ticket presiona 3\n' +
    '4. Para eliminar un ticket presiona 4\n' +
    '5. Para finalizar un ticket presiona 5',
  ticketCreated:
    '✅ Ticket *{ticketNumber}* creado exitosamente.\n\nTe notificaremos cuando haya actualizaciones de estados.',
  statusChanged:
    'El estado de su solicitud *{ticketNumber}* ha cambiado de "{prevStatus}" a "{newStatus}".',
  reparadoMessage:
    'Estas son las evidencias de que su ticket *{ticketNumber}* con descripción "{description}" ha sido reparado:',
  noTickets: 'No tienes tickets registrados aún. ¿Puedo ayudarte en algo más?',
  invalidField: 'Por favor ingresa una respuesta válida.',
  cancelled: 'Operación cancelada.',
  goodbye: 'Hasta luego 👋. Escribe cualquier mensaje para volver al menú.',
  viewTicketOptions: '¿Qué deseas ver?\n1. Info del ticket\n2. Ver fotos',
  backToMenuKeyword: 'INICIO',
  adminRequestUpdate:
    '📋 El administrador te solicita actualizar el campo *{fieldLabel}* de tu ticket *{ticketNumber}*.\n\nPara actualizar esta información, selecciona la opción *3* (Editar) en el menú.',
  ticketSelectPrompt: 'Selecciona el número del ticket que deseas *{action}*:',
  ticketListItemTemplate: '{index}. 📋 *{ticketNumber}*\n   Estado: {estado}\n   Fecha: {fecha}',
};

export const DEFAULT_FIELDS: TicketField[] = [
  { key: 'ciudad', label: 'Ciudad', question: '¿En qué ciudad se encuentra el punto de venta?', order: 0, normalize: true, visible: true },
  { key: 'canal', label: 'Canal', question: '¿Cuál es el canal de venta? (ejemplo: Retail, Operador, Online):', order: 1, normalize: true, visible: true },
  { key: 'punto', label: 'Punto de Venta', question: '¿Cuál es el nombre del punto de venta?', order: 2, normalize: true, visible: true },
  { key: 'novelty.type', label: 'Tipo de Novedad', question: 'Tipo de Novedad', order: 3, normalize: false, visible: true },
  { key: 'novelty.description', label: 'Descripción / Novedad', question: 'Descripción / Novedad', order: 4, normalize: false, visible: true },
  { key: 'photos.evidence', label: 'Fotos de Evidencia', question: 'Fotos de Evidencia', order: 5, normalize: false, visible: false },
  { key: 'photos.repair', label: 'Fotos de Reparación', question: 'Fotos de Reparación', placeholder: 'Sube aquí las fotos de reparación', order: 6, normalize: false, visible: false },
];

@Injectable()
export class BotConfigService {
  private messagesCache: BotMessages | null = null;
  private fieldsCache: TicketField[] | null = null;
  private cacheExpiry = 0;

  constructor(private readonly firebase: FirebaseService) {}

  private isCacheValid(): boolean {
    return Date.now() < this.cacheExpiry;
  }

  private invalidateCache(): void {
    this.messagesCache = null;
    this.fieldsCache = null;
    this.cacheExpiry = 0;
  }

  async getMessages(): Promise<BotMessages> {
    if (this.messagesCache && this.isCacheValid()) return this.messagesCache;

    const snap = await this.firebase.db.collection('bot_config').doc('messages').get();
    const data = snap.exists ? (snap.data() as Partial<BotMessages>) : {};
    this.messagesCache = { ...DEFAULT_MESSAGES, ...data };
    this.cacheExpiry = Date.now() + 60_000;
    return this.messagesCache;
  }

  async getFields(): Promise<TicketField[]> {
    if (this.fieldsCache && this.isCacheValid()) return this.fieldsCache;

    const snap = await this.firebase.db.collection('bot_config').doc('ticket_fields').get();
    const fields = snap.exists ? (snap.data()?.fields as TicketField[] | undefined) : undefined;
    
    if (fields && fields.length > 0) {
      // Merge con defaults para asegurar que nuevos campos se incluyan
      const savedKeys = new Set(fields.map(f => f.key));
      const newDefaults = DEFAULT_FIELDS.filter(df => !savedKeys.has(df.key));
      this.fieldsCache = [...fields, ...newDefaults].sort((a, b) => a.order - b.order);
    } else {
      this.fieldsCache = DEFAULT_FIELDS;
    }
    
    this.cacheExpiry = Date.now() + 60_000;
    return this.fieldsCache;
  }

  async updateMessages(messages: Partial<BotMessages>): Promise<BotMessages> {
    await this.firebase.db
      .collection('bot_config')
      .doc('messages')
      .set(messages, { merge: true });
    this.invalidateCache();
    return this.getMessages();
  }

  async updateFields(fields: TicketField[], systemFields?: SystemFieldConfig[]): Promise<void> {
    const normalized = fields.map((f, i) => ({ ...f, order: i }));
    const data: { fields: TicketField[]; systemFields?: SystemFieldConfig[] } = { fields: normalized };
    if (systemFields) data.systemFields = systemFields;
    await this.firebase.db
      .collection('bot_config')
      .doc('ticket_fields')
      .set(data);
    this.invalidateCache();
  }

  async getAll(): Promise<{ messages: BotMessages; fields: TicketField[] }> {
    const [messages, fields] = await Promise.all([this.getMessages(), this.getFields()]);
    return { messages, fields };
  }
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}
