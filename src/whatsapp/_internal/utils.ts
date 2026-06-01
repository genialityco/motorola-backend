export type WhatsAppMessage = {
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

export type WhatsAppWebhookPayload = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: { messages?: WhatsAppMessage[] };
    }>;
  }>;
};

export interface PendingTicket {
  id: string;
  ticketNumber: string;
  status: string;
  extraFields?: Record<string, string | string[]>;
  createdAt?: number;
  updatedAt?: number;
}

export const MENU_FALLBACK =
  `Hola, a continuación te mostraré las diferentes funcionalidades que poseo:\n` +
  `1. Para crear un ticket presiona 1\n` +
  `2. Para ver el estado de tus tickets presiona 2\n` +
  `3. Para editar un ticket presiona 3\n` +
  `4. Para eliminar un ticket presiona 4\n`;

export const DEFAULT_SESSION_TIMEOUT_HOURS = 24;

export const CREATE_FLOW_STATES = ['WAITING_FIELD'];

export const EDIT_FLOW_STATES = [
  'WAITING_TICKET_SELECTION_EDIT',
  'WAITING_EDIT_FIELD_SELECTION',
  'WAITING_EDIT_FIELD_VALUE',
  'WAITING_EDIT_PHOTO_ACTION',
  'WAITING_EDIT_ADD_PHOTOS',
  'WAITING_EDIT_PHOTO_SELECTION',
  'WAITING_EDIT_NEW_PHOTO',
  'WAITING_ADMIN_REQUESTED_UPDATE',
];

export const IDLE_RESET_FIELDS = {
  fieldIndex: null, fieldValues: null, tempFieldPhotos: null,
  pendingTickets: null, pendingTicketId: null, pendingTicketData: null,
  editableFields: null, editFieldKey: null, editFieldType: null, editFieldOptions: null,
  requestedFieldKey: null, requestedFieldLabel: null, requestedTicketId: null,
  tempEditPhotos: null, pendingPhotoIndex: null,
};

export function normalizeText(text: string): string {
  return text
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, obj);
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
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

export function normalizePhoneForWhatsApp(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
  return digits;
}

export function flattenExtraFieldsForInterpolation(extraFields: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (obj: Record<string, unknown>, prefix: string) => {
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
        walk(val as Record<string, unknown>, fullKey);
      }
    }
  };
  walk(extraFields, '');
  return result;
}
