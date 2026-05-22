export type TicketStatus =
  | 'REPORTADO'
  | 'EN_PROGRAMACION'
  | 'PROGRAMADO'
  | 'REPROGRAMADO'
  | 'REPARADO'
  | 'FINALIZADO'
  | 'ARCHIVADO';

export const VALID_STATUSES: TicketStatus[] = [
  'REPORTADO',
  'EN_PROGRAMACION',
  'PROGRAMADO',
  'REPROGRAMADO',
  'REPARADO',
  'FINALIZADO',
];

export const ALL_VALID_STATUSES: TicketStatus[] = [
  'REPORTADO',
  'EN_PROGRAMACION',
  'PROGRAMADO',
  'REPROGRAMADO',
  'REPARADO',
  'FINALIZADO',
  'ARCHIVADO',
];

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
  return digits;
}

export function isValidPhone(normalized: string): boolean {
  return normalized.length >= 7 && /^\d+$/.test(normalized);
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
