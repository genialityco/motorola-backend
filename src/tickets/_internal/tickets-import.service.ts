import { Injectable } from '@nestjs/common';
import { FirebaseService } from '../../firebase/firebase.service';
import { UsersService } from '../../users/users.service';
import { EmailService } from '../../email/email.service';
import {
  ALL_VALID_STATUSES, BotFieldForImport, FailedTicketRow,
  ImportedTicketResult, ImportResult, TicketStatus,
  isValidPhone, normalizePhone, setNestedField,
} from './utils';

@Injectable()
export class TicketsImportService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly usersService: UsersService,
    private readonly email: EmailService,
  ) {}

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

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const fila = i + 2;
      try {
        await this.processRow(row, fila, configFields, created, failed);
      } catch (err) {
        failed.push({ fila, razon: `Error interno: ${(err as Error).message}` });
      }
    }
    return { created, failed };
  }

  private async processRow(
    row: Record<string, string>,
    fila: number,
    configFields: BotFieldForImport[],
    created: ImportedTicketResult[],
    failed: FailedTicketRow[],
  ): Promise<void> {
    const rawPhone = String(row['Teléfono Reportante'] ?? '').trim();
    if (!rawPhone) {
      failed.push({ fila, razon: 'Teléfono Reportante es requerido' });
      return;
    }
    const phone = normalizePhone(rawPhone);
    if (!isValidPhone(phone)) {
      failed.push({ fila, razon: `Teléfono inválido: "${rawPhone}". Debe contener al menos 7 dígitos.` });
      return;
    }

    const rawStatus = String(row['Estado'] ?? '').trim().toUpperCase();
    const status: TicketStatus = (ALL_VALID_STATUSES as string[]).includes(rawStatus)
      ? (rawStatus as TicketStatus) : 'REPORTADO';

    const extraFields: Record<string, unknown> = {};
    const fieldErrors = this.buildExtraFields(row, configFields, extraFields);
    if (fieldErrors.length > 0) {
      failed.push({ fila, razon: fieldErrors.join(' | ') });
      return;
    }

    const ticketNumber = `TKT-${Math.floor(Math.random() * 90000) + 10000}`;
    const reporterName = String(row['Reportado Por'] ?? '').trim() || 'Usuario WhatsApp';

    const assignedGestorIds = await this.usersService
      .computeAssignedGestorIds(extraFields)
      .catch(() => []);

    const db = this.firebase.db;
    const ticketDoc = {
      ticketNumber,
      status,
      reporter: { phone, name: reporterName },
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      extraFields,
      assignedGestorIds,
    };
    await db.collection('tickets').add(ticketDoc);

    this.email
      .notifyTicketCreated(ticketDoc, assignedGestorIds)
      .catch((err) => console.error('Error enviando email de ticket importado:', err));

    await this.upsertHost(phone, reporterName);
    created.push({ fila, ticketNumber, telefono: phone });
  }

  private buildExtraFields(
    row: Record<string, string>,
    configFields: BotFieldForImport[],
    extraFields: Record<string, unknown>,
  ): string[] {
    const errors: string[] = [];
    for (const field of configFields) {
      const colLabel = field.label || field.key;
      const rawValue = String(row[colLabel] ?? '').trim();

      if (!rawValue) {
        if (field.required) errors.push(`Campo requerido vacío: "${colLabel}"`);
        continue;
      }
      if (field.type === 'numeric' && isNaN(Number(rawValue))) {
        errors.push(`"${colLabel}" debe ser numérico, se recibió: "${rawValue}"`);
        continue;
      }
      if (
        field.type === 'list' && field.options && field.options.length > 0 &&
        !field.options.includes(rawValue)
      ) {
        errors.push(`"${colLabel}" debe ser una de: ${field.options.join(', ')}. Se recibió: "${rawValue}"`);
        continue;
      }
      const finalValue = field.normalize ? rawValue.toUpperCase() : rawValue;
      setNestedField(extraFields, field.key, finalValue);
    }
    return errors;
  }

  private async upsertHost(phone: string, reporterName: string): Promise<void> {
    const hostRef = this.firebase.db.collection('hosts').doc(phone);
    const hostSnap = await hostRef.get();
    if (!hostSnap.exists) {
      const hostName = reporterName !== 'Usuario WhatsApp' ? reporterName : phone;
      await hostRef.set({ nombre: hostName, telefono: phone, creadoEn: Date.now() });
    }
  }
}
