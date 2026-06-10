import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { FieldValue, DocumentData } from 'firebase-admin/firestore';
import { TicketsStatusService } from './_internal/tickets-status.service';
import { TicketsImportService } from './_internal/tickets-import.service';
import {
  BotFieldForImport, ImportResult, TicketStatus, getNestedValue,
} from './_internal/utils';
import { recordFieldUpdate } from './_internal/activity-history';

type Actor = { uid?: string; role?: string; email?: string };

export type {
  BotFieldForImport, ImportedTicketResult, FailedTicketRow, ImportResult,
} from './_internal/utils';

@Injectable()
export class TicketsService {
  private readonly storageBucket: string;

  constructor(
    private readonly firebase: FirebaseService,
    private readonly statusService: TicketsStatusService,
    private readonly importService: TicketsImportService,
  ) {
    this.storageBucket = process.env.FIREBASE_STORAGE_BUCKET ?? '';
  }

  transitionStatus(
    ticketId: string,
    newStatus: TicketStatus,
    uid: string,
    role: string,
    comments?: string,
    scheduledDate?: string,
    email?: string,
  ): Promise<{ success: boolean; message: string; prevStatus: string; ticketData: DocumentData }> {
    return this.statusService.transitionStatus(ticketId, newStatus, uid, role, comments, scheduledDate, email);
  }

  getConfigFields(): Promise<BotFieldForImport[]> {
    return this.importService.getConfigFields();
  }

  importTickets(rows: Array<Record<string, string>>, configFields: BotFieldForImport[]): Promise<ImportResult> {
    return this.importService.importTickets(rows, configFields);
  }

  async deletePhotoFromField(
    ticketId: string,
    fieldKey: string,
    photoIndex: number,
    opts?: { actor?: Actor; fieldLabel?: string },
  ): Promise<{ ticketNumber: string; reporterPhone: string }> {
    const ticketRef = this.firebase.db.collection('tickets').doc(ticketId);
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

    await recordFieldUpdate(this.firebase.db, ticketId, {
      fieldKey,
      fieldLabel: opts?.fieldLabel || fieldKey,
      previousValue: photos,
      newValue: newPhotos,
      changedBy: opts?.actor ?? { role: 'admin' },
      comments: `Eliminó la foto ${photoIndex + 1}.`,
    }).catch(() => null);

    return {
      ticketNumber: data.ticketNumber as string,
      reporterPhone: data.reporter?.phone as string,
    };
  }

  async addPhotoToField(
    ticketId: string,
    fieldKey: string,
    photoUrl: string,
    opts?: { actor?: Actor; fieldLabel?: string },
  ): Promise<void> {
    const ticketRef = this.firebase.db.collection('tickets').doc(ticketId);
    const snap = await ticketRef.get();
    if (!snap.exists) throw new NotFoundException('El ticket no existe.');
    const previous = (getNestedValue(snap.data()?.extraFields || {}, fieldKey) as string[]) || [];
    await ticketRef.update({
      [`extraFields.${fieldKey}`]: FieldValue.arrayUnion(photoUrl),
      'timestamps.updatedAt': Date.now(),
    });

    await recordFieldUpdate(this.firebase.db, ticketId, {
      fieldKey,
      fieldLabel: opts?.fieldLabel || fieldKey,
      previousValue: previous,
      newValue: [...previous, photoUrl],
      changedBy: opts?.actor ?? { role: 'admin' },
      comments: 'Agregó una foto.',
    }).catch(() => null);
  }

  async updateExtraField(
    ticketId: string,
    fieldKey: string,
    value: string,
    opts?: { actor?: Actor; fieldLabel?: string },
  ): Promise<void> {
    const ref = this.firebase.db.collection('tickets').doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException(`Ticket ${ticketId} no encontrado`);
    const previousValue = getNestedValue(snap.data()?.extraFields || {}, fieldKey);
    await ref.update({
      [`extraFields.${fieldKey}`]: value,
      'timestamps.updatedAt': Date.now(),
    });

    await recordFieldUpdate(this.firebase.db, ticketId, {
      fieldKey,
      fieldLabel: opts?.fieldLabel || fieldKey,
      previousValue,
      newValue: value,
      changedBy: opts?.actor ?? { role: 'admin' },
    }).catch(() => null);
  }

  /** Define los administradores (correos) que reciben copia de los correos de este ticket. */
  async updateNotifyAdmins(ticketId: string, emails: string[]): Promise<void> {
    const ref = this.firebase.db.collection('tickets').doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException(`Ticket ${ticketId} no encontrado.`);
    const clean = [...new Set(emails.filter((e) => typeof e === 'string' && e.trim()))];
    await ref.update({
      notifyAdminEmails: clean,
      'timestamps.updatedAt': Date.now(),
    });
  }

  async addObservation(ticketId: string, uid: string, role: string, text: string): Promise<void> {
    if (!text?.trim()) throw new BadRequestException('La observación no puede estar vacía.');
    const ref = this.firebase.db.collection('tickets').doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException(`Ticket ${ticketId} no encontrado.`);
    await ref.update({
      observations: FieldValue.arrayUnion({ uid, role, text: text.trim(), timestamp: Date.now() }),
      'timestamps.updatedAt': Date.now(),
    });
  }

  async uploadToStorage(buffer: Buffer, mimeType: string, folder: string): Promise<string> {
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
