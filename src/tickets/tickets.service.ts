import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { BotConfigService } from '../bot-config/bot-config.service';
import { FieldValue, DocumentData } from 'firebase-admin/firestore';

type TicketStatus =
  | 'REPORTADO'
  | 'EN_PROGRAMACION'
  | 'PROGRAMADO'
  | 'REPROGRAMADO'
  | 'REPARADO'
  | 'FINALIZADO'
  | 'ARCHIVADO';

const VALID_STATUSES: TicketStatus[] = [
  'REPORTADO',
  'EN_PROGRAMACION',
  'PROGRAMADO',
  'REPROGRAMADO',
  'REPARADO',
  'FINALIZADO',
];

const ALL_VALID_STATUSES: TicketStatus[] = [
  'REPORTADO',
  'EN_PROGRAMACION',
  'PROGRAMADO',
  'REPROGRAMADO',
  'REPARADO',
  'FINALIZADO',
  'ARCHIVADO',
];

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

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
  return digits;
}

function isValidPhone(normalized: string): boolean {
  return normalized.length >= 7 && /^\d+$/.test(normalized);
}

function setNestedField(
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

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, obj);
}

@Injectable()
export class TicketsService {
  private readonly storageBucket: string;

  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
  ) {
    this.storageBucket = process.env.FIREBASE_STORAGE_BUCKET ?? '';
  }

  async transitionStatus(
    ticketId: string,
    newStatus: TicketStatus,
    uid: string,
    role: string,
    comments?: string,
    scheduledDate?: string,
  ): Promise<{ success: boolean; message: string; prevStatus: string; ticketData: DocumentData }> {
    if (!VALID_STATUSES.includes(newStatus)) {
      throw new BadRequestException(`Estado inválido: ${newStatus}`);
    }

    if ((newStatus === 'PROGRAMADO' || newStatus === 'REPROGRAMADO') && !scheduledDate) {
      throw new BadRequestException(
        `Se requiere una fecha programada para cambiar al estado ${newStatus}.`,
      );
    }

    if (scheduledDate && isNaN(new Date(scheduledDate).getTime())) {
      throw new BadRequestException('La fecha programada no tiene un formato válido.');
    }

    let adminPhotoFieldKeys: string[] = [];
    if (newStatus === 'REPARADO') {
      const allFields = await this.botConfig.getFields();
      adminPhotoFieldKeys = allFields
        .filter((f) => f.type === 'photo' && f.source === 'admin')
        .map((f) => f.key);
    }

    const db = this.firebase.db;
    const ticketRef = db.collection('tickets').doc(ticketId);
    let prevStatus = '';
    let ticketData: DocumentData = {};

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ticketRef);
      if (!snap.exists) throw new NotFoundException('El ticket no existe.');

      prevStatus = snap.data()?.status ?? '';
      ticketData = snap.data()!;

      if (newStatus === 'REPARADO' && adminPhotoFieldKeys.length > 0) {
        const extraFields = (ticketData.extraFields as Record<string, unknown>) || {};
        const hasRepairPhoto = adminPhotoFieldKeys.some((key) => {
          const val = getNestedValue(extraFields, key);
          return Array.isArray(val) && (val as string[]).length > 0;
        });
        if (!hasRepairPhoto) {
          throw new BadRequestException(
            'Se requiere al menos una foto de reparación para cambiar al estado REPARADO.',
          );
        }
      }

      const updateData: Record<string, unknown> = {
        status: newStatus,
        'timestamps.updatedAt': Date.now(),
      };

      if (scheduledDate && (newStatus === 'PROGRAMADO' || newStatus === 'REPROGRAMADO')) {
        updateData.scheduledDate = scheduledDate;
      }

      tx.update(ticketRef, updateData);

      const historyEntry: Record<string, unknown> = {
        previousStatus: prevStatus,
        newStatus,
        changedBy: { uid, role },
        comments: comments || '',
        timestamp: Date.now(),
      };

      if (scheduledDate && (newStatus === 'PROGRAMADO' || newStatus === 'REPROGRAMADO')) {
        historyEntry.scheduledDate = scheduledDate;
      }

      tx.set(ticketRef.collection('statusHistory').doc(), historyEntry);
    });

    return { success: true, message: 'Ticket actualizado correctamente.', prevStatus, ticketData };
  }

  async deletePhotoFromField(
    ticketId: string,
    fieldKey: string,
    photoIndex: number,
  ): Promise<{ ticketNumber: string; reporterPhone: string }> {
    const db = this.firebase.db;
    const ticketRef = db.collection('tickets').doc(ticketId);

    const snap = await ticketRef.get();
    if (!snap.exists) throw new NotFoundException('El ticket no existe.');

    const data = snap.data()!;
    const photos = (getNestedValue(data.extraFields || {}, fieldKey) as string[]) || [];

    if (photoIndex < 0 || photoIndex >= photos.length) {
      throw new BadRequestException('Índice de foto inválido.');
    }

    const newPhotos = photos.filter((_, i) => i !== photoIndex);
    await ticketRef.update({
      [`extraFields.${fieldKey}`]: newPhotos,
      'timestamps.updatedAt': Date.now(),
    });

    return {
      ticketNumber: data.ticketNumber as string,
      reporterPhone: data.reporter?.phone as string,
    };
  }

  async addPhotoToField(
    ticketId: string,
    fieldKey: string,
    photoUrl: string,
  ): Promise<void> {
    const db = this.firebase.db;
    const ticketRef = db.collection('tickets').doc(ticketId);

    const snap = await ticketRef.get();
    if (!snap.exists) throw new NotFoundException('El ticket no existe.');

    await ticketRef.update({
      [`extraFields.${fieldKey}`]: FieldValue.arrayUnion(photoUrl),
      'timestamps.updatedAt': Date.now(),
    });
  }

  async updateExtraField(
    ticketId: string,
    fieldKey: string,
    value: string,
  ): Promise<void> {
    const ref = this.firebase.db.collection('tickets').doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException(`Ticket ${ticketId} no encontrado`);
    await ref.update({
      [`extraFields.${fieldKey}`]: value,
      'timestamps.updatedAt': Date.now(),
    });
  }

  async getConfigFields(): Promise<BotFieldForImport[]> {
    const snap = await this.firebase.db
      .collection('bot_config')
      .doc('ticket_fields')
      .get();
    if (!snap.exists) return [];
    const data = snap.data();
    return ((data?.fields ?? []) as BotFieldForImport[]).filter(
      (f) => f.type !== 'photo' && f.type !== 'video',
    );
  }

  async importTickets(
    rows: Array<Record<string, string>>,
    configFields: BotFieldForImport[],
  ): Promise<ImportResult> {
    const created: ImportedTicketResult[] = [];
    const failed: FailedTicketRow[] = [];
    const db = this.firebase.db;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const fila = i + 2; // row 1 is headers in Excel

      try {
        // ── Validate phone ─────────────────────────────────────────────
        const rawPhone = String(row['Teléfono Reportante'] ?? '').trim();
        if (!rawPhone) {
          failed.push({ fila, razon: 'Teléfono Reportante es requerido' });
          continue;
        }
        const phone = normalizePhone(rawPhone);
        if (!isValidPhone(phone)) {
          failed.push({
            fila,
            razon: `Teléfono inválido: "${rawPhone}". Debe contener al menos 7 dígitos.`,
          });
          continue;
        }

        // ── Validate status ────────────────────────────────────────────
        const rawStatus = String(row['Estado'] ?? '').trim().toUpperCase();
        const status: TicketStatus = (ALL_VALID_STATUSES as string[]).includes(
          rawStatus,
        )
          ? (rawStatus as TicketStatus)
          : 'REPORTADO';

        // ── Build extraFields ──────────────────────────────────────────
        const extraFields: Record<string, unknown> = {};
        const fieldErrors: string[] = [];

        for (const field of configFields) {
          const colLabel = field.label || field.key;
          const rawValue = String(row[colLabel] ?? '').trim();

          if (!rawValue) {
            if (field.required) {
              fieldErrors.push(`Campo requerido vacío: "${colLabel}"`);
            }
            continue;
          }

          if (field.type === 'numeric' && isNaN(Number(rawValue))) {
            fieldErrors.push(`"${colLabel}" debe ser numérico, se recibió: "${rawValue}"`);
            continue;
          }

          if (
            field.type === 'list' &&
            field.options &&
            field.options.length > 0 &&
            !field.options.includes(rawValue)
          ) {
            fieldErrors.push(
              `"${colLabel}" debe ser una de: ${field.options.join(', ')}. Se recibió: "${rawValue}"`,
            );
            continue;
          }

          const finalValue = field.normalize ? rawValue.toUpperCase() : rawValue;
          setNestedField(extraFields, field.key, finalValue);
        }

        if (fieldErrors.length > 0) {
          failed.push({ fila, razon: fieldErrors.join(' | ') });
          continue;
        }

        // ── Generate unique ticket number ──────────────────────────────
        const ticketNumber = `TKT-${Math.floor(Math.random() * 90000) + 10000}`;

        // ── Reporter name ──────────────────────────────────────────────
        const reporterName =
          String(row['Reportado Por'] ?? '').trim() || 'Usuario WhatsApp';

        // ── Create ticket ──────────────────────────────────────────────
        await db.collection('tickets').add({
          ticketNumber,
          status,
          reporter: { phone, name: reporterName },
          timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
          extraFields,
        });

        // ── Upsert host ────────────────────────────────────────────────
        const hostRef = db.collection('hosts').doc(phone);
        const hostSnap = await hostRef.get();
        if (!hostSnap.exists) {
          const hostName =
            reporterName !== 'Usuario WhatsApp' ? reporterName : phone;
          await hostRef.set({
            nombre: hostName,
            telefono: phone,
            creadoEn: Date.now(),
          });
        }

        created.push({ fila, ticketNumber, telefono: phone });
      } catch (err) {
        failed.push({
          fila,
          razon: `Error interno: ${(err as Error).message}`,
        });
      }
    }

    return { created, failed };
  }

  async uploadToStorage(
    buffer: Buffer,
    mimeType: string,
    folder: string,
  ): Promise<string> {
    if (!this.storageBucket) {
      throw new Error('FIREBASE_STORAGE_BUCKET no está configurado');
    }

    const bucket = this.firebase.storage.bucket(this.storageBucket);
    const ext = (mimeType.split('/')[1] || 'jpeg').toLowerCase();
    const filePath = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const file = bucket.file(filePath);

    await file.save(buffer, { metadata: { contentType: mimeType } });
    await file.makePublic();

    return file.publicUrl();
  }
}
