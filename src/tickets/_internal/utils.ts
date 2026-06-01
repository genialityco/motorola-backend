export type TicketStatus =
  | 'SOLICITUD_RECIBIDA'
  | 'APROBACION_PIEZAS'
  | 'EN_MONTAJE'
  | 'ENLACE_PUBLICADO'
  | 'PRODUCCION_PREVIA'
  | 'PRODUCCION_POSTERIOR'
  | 'FINALIZADO'
  | 'ARCHIVADO';

export const VALID_STATUSES: TicketStatus[] = [
  'SOLICITUD_RECIBIDA',
  'APROBACION_PIEZAS',
  'EN_MONTAJE',
  'ENLACE_PUBLICADO',
  'PRODUCCION_PREVIA',
  'PRODUCCION_POSTERIOR',
  'FINALIZADO',
];

export const ALL_VALID_STATUSES: TicketStatus[] = [
  'SOLICITUD_RECIBIDA',
  'APROBACION_PIEZAS',
  'EN_MONTAJE',
  'ENLACE_PUBLICADO',
  'PRODUCCION_PREVIA',
  'PRODUCCION_POSTERIOR',
  'FINALIZADO',
  'ARCHIVADO',
];

export const INITIAL_STATUS: TicketStatus = 'SOLICITUD_RECIBIDA';
export const PHOTO_TRIGGERED_STATUS: TicketStatus = 'APROBACION_PIEZAS';

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
  return digits;
}

export function isValidPhone(normalized: string): boolean {
  return normalized.length >= 7 && /^\d+$/.test(normalized);
}

export const FECHA_FORMAT_LABEL = 'DD/MM/AAAA, HH:mm';
const FECHA_REGEX = /^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2})$/;

export function isValidFecha(raw: string): boolean {
  const m = raw.match(FECHA_REGEX);
  if (!m) return false;
  const [, dd, mm, yyyy, hh, mi] = m;
  const d = Number(dd), mo = Number(mm), y = Number(yyyy);
  const h = Number(hh), min = Number(mi);
  if (mo < 1 || mo > 12) return false;
  if (h > 23 || min > 59) return false;
  const dt = new Date(y, mo - 1, d, h, min);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}

export function formatFecha(input: string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function setNestedField(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, obj);
}

export interface BotFieldForImport {
  key: string;
  label: string;
  type: string;
  required: boolean;
  normalize: boolean;
  options?: string[];
}

export interface ImportedTicketResult {
  fila: number;
  ticketNumber: string;
  telefono: string;
}

export interface FailedTicketRow {
  fila: number;
  razon: string;
}

export interface ImportResult {
  created: ImportedTicketResult[];
  failed: FailedTicketRow[];
}
