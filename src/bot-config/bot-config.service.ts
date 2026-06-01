import { Injectable, BadRequestException } from '@nestjs/common';
import { COLLECTIONS, FirebaseService } from '../firebase/firebase.service';

export interface BotMessages {
  menu: string;
  ticketCreated: string;
  ticketDeleted: string;
  statusChanged: string;
  aprobacionPiezasMessage: string;
  noTickets: string;
  invalidField: string;
  cancelled: string;
  goodbye: string;
  viewTicketOptions: string;
  backToMenuKeyword: string;
  adminRequestUpdate: string;
  deletePhotoRequest: string;
  editFieldPrompt: string;
  ticketSelectPrompt: string;
  ticketListItemTemplate: string;
  sessionExpiredCreate: string;
  sessionExpiredEdit: string;
  sessionExpiredGeneric: string;
}

export interface ComplianceLimits {
  aTiempoMaxDias: number;
  atencionPrioritariaMaxDias: number;
}

export interface BotSettings {
  sessionTimeoutHours: number;
  compliance?: ComplianceLimits;
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
  allowOther?: boolean;
  otherLabel?: string;
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
    '4. Para eliminar un ticket presiona 4\n',
  ticketCreated:
    '✅ Ticket *{ticketNumber}* {action} exitosamente.\n\nTe notificaremos cuando haya actualizaciones de estados.',
  ticketDeleted: '✅ Ticket *{ticketNumber}* eliminado correctamente.',
  statusChanged:
    'El estado de su solicitud *{ticketNumber}* ha cambiado de "{prevStatus}" a "{newStatus}".',
  aprobacionPiezasMessage:
    'Estas son las piezas propuestas para la aprobación de tu solicitud *{ticketNumber}*:',
  noTickets: 'No tienes tickets registrados aún. ¿Puedo ayudarte en algo más?',
  invalidField: 'Por favor ingresa una respuesta válida.',
  cancelled: 'Operación cancelada.',
  goodbye: 'Hasta luego 👋. Escribe cualquier mensaje para volver al menú.',
  viewTicketOptions: '¿Qué deseas ver?\n1. Info del ticket\n2. Ver fotos',
  backToMenuKeyword: 'INICIO',
  adminRequestUpdate:
    '📋 El administrador te solicita actualizar el campo *{fieldLabel}* de tu ticket *{ticketNumber}*.\n\nPara actualizar esta información, selecciona la opción *3* (Editar) en el menú.',
  deletePhotoRequest:
    'Para el ticket número *{ticketNumber}* vuelva adjuntar las evidencias del campo {fieldLabel}.',
  editFieldPrompt: '¿Qué deseas editar en el ticket *{ticketNumber}*?\n\n{fieldList}\n0. Cancelar',
  ticketSelectPrompt: 'Selecciona el número del ticket que deseas *{action}*:',
  ticketListItemTemplate: '{index}. 📋 *{ticketNumber}*\n   Estado: {estado}\n   Fecha: {fecha}',
  sessionExpiredCreate: 'Tu sesión para crear el ticket expiró por inactividad ({hours} horas). Por favor, selecciona la opción *1* para comenzar nuevamente.',
  sessionExpiredEdit: 'Tu sesión para editar el ticket expiró por inactividad ({hours} horas). Por favor, selecciona la opción *3* para editar nuevamente.',
  sessionExpiredGeneric: 'Tu sesión expiró por inactividad ({hours} horas). Por favor, selecciona una opción del menú.',
};

export const DEFAULT_SETTINGS: BotSettings = {
  sessionTimeoutHours: 24,
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

    const snap = await this.firebase.db.collection(COLLECTIONS.BOT_CONFIG).doc('messages').get();
    const data = snap.exists ? (snap.data() as Partial<BotMessages>) : {};
    this.messagesCache = { ...DEFAULT_MESSAGES, ...data };
    this.cacheExpiry = Date.now() + 60_000;
    return this.messagesCache;
  }

  async getFields(): Promise<TicketField[]> {
    if (this.fieldsCache && this.isCacheValid()) return this.fieldsCache;

    const snap = await this.firebase.db.collection(COLLECTIONS.BOT_CONFIG).doc('ticket_fields').get();
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
      .collection(COLLECTIONS.BOT_CONFIG)
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
      .collection(COLLECTIONS.BOT_CONFIG)
      .doc('ticket_fields')
      .set(data);
    this.invalidateCache();
  }

  async getSettings(): Promise<BotSettings> {
    const snap = await this.firebase.db.collection(COLLECTIONS.BOT_CONFIG).doc('settings').get();
    const data = snap.exists ? (snap.data() as Partial<BotSettings>) : {};
    return { ...DEFAULT_SETTINGS, ...data };
  }

  async updateSettings(settings: Partial<BotSettings>): Promise<BotSettings> {
    if (settings.compliance) {
      const { aTiempoMaxDias, atencionPrioritariaMaxDias } = settings.compliance;
      if (aTiempoMaxDias >= atencionPrioritariaMaxDias) {
        throw new BadRequestException(
          'El límite "A tiempo" debe ser menor al límite "Atención prioritaria".',
        );
      }
    }
    await this.firebase.db.collection(COLLECTIONS.BOT_CONFIG).doc('settings').set(settings, { merge: true });
    return this.getSettings();
  }

  async getAll(): Promise<{ messages: BotMessages; fields: TicketField[] }> {
    const [messages, fields] = await Promise.all([this.getMessages(), this.getFields()]);
    return { messages, fields };
  }
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}
