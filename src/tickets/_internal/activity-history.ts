import type { Firestore } from 'firebase-admin/firestore';

/**
 * Representa un valor de campo de forma legible para el historial de actividad.
 * Las listas de archivos (fotos/videos) se resumen como un conteo.
 */
export function describeFieldValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    return `${value.length} archivo${value.length === 1 ? '' : 's'}`;
  }
  if (value === 'true') return 'Sí';
  if (value === 'false') return 'No';
  return String(value);
}

/**
 * Registra una actualización de campo en la subcolección `statusHistory` del
 * ticket, usando el mismo lugar que los cambios de estado pero con
 * `type: 'FIELD_UPDATE'` para diferenciarlos en el historial de actividad.
 */
export async function recordFieldUpdate(
  db: Firestore,
  ticketId: string,
  params: {
    fieldKey: string;
    fieldLabel: string;
    previousValue?: unknown;
    newValue?: unknown;
    changedBy?: { uid?: string; role?: string; email?: string };
    comments?: string;
  },
): Promise<void> {
  if (!ticketId) return;

  // Firestore Admin rechaza propiedades `undefined`; construimos changedBy limpio.
  const src = params.changedBy ?? { role: 'host' };
  const changedBy: Record<string, string> = {};
  if (src.uid) changedBy.uid = src.uid;
  if (src.role) changedBy.role = src.role;
  if (src.email) changedBy.email = src.email;

  await db
    .collection('tickets')
    .doc(ticketId)
    .collection('statusHistory')
    .doc()
    .set({
      type: 'FIELD_UPDATE',
      fieldKey: params.fieldKey,
      fieldLabel: params.fieldLabel || params.fieldKey,
      previousValue: describeFieldValue(params.previousValue),
      newValue: describeFieldValue(params.newValue),
      changedBy,
      comments: params.comments ?? '',
      timestamp: Date.now(),
    });
}
