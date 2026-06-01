import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { COLLECTIONS, FirebaseService } from '../firebase/firebase.service';
import { FieldValue, DocumentData } from 'firebase-admin/firestore';
import { TicketsStatusService } from './_internal/tickets-status.service';
import { TicketsImportService } from './_internal/tickets-import.service';
import {
  BotFieldForImport, ImportResult, TicketStatus, getNestedValue,
  INITIAL_STATUS, PHOTO_TRIGGERED_STATUS,
} from './_internal/utils';

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
  ): Promise<{ success: boolean; message: string; prevStatus: string; ticketData: DocumentData }> {
    return this.statusService.transitionStatus(ticketId, newStatus, uid, role, comments);
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
  ): Promise<{ ticketNumber: string; reporterPhone: string }> {
    const ticketRef = this.firebase.db.collection(COLLECTIONS.TICKETS).doc(ticketId);
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
    uid: string,
    role: string,
  ): Promise<{ autoTransitioned: boolean; prevStatus?: string; ticketData?: DocumentData }> {
    const ticketRef = this.firebase.db.collection(COLLECTIONS.TICKETS).doc(ticketId);
    const snap = await ticketRef.get();
    if (!snap.exists) throw new NotFoundException('El ticket no existe.');

    await ticketRef.update({
      [`extraFields.${fieldKey}`]: FieldValue.arrayUnion(photoUrl),
      'timestamps.updatedAt': Date.now(),
    });

    const currentStatus = snap.data()?.status as TicketStatus | undefined;
    if (currentStatus === INITIAL_STATUS) {
      const result = await this.statusService.transitionStatus(
        ticketId,
        PHOTO_TRIGGERED_STATUS,
        uid,
        role,
        'Auto: foto adjuntada por administración',
      );
      return { autoTransitioned: true, prevStatus: result.prevStatus, ticketData: result.ticketData };
    }
    return { autoTransitioned: false };
  }

  async updateExtraField(ticketId: string, fieldKey: string, value: string): Promise<void> {
    const ref = this.firebase.db.collection(COLLECTIONS.TICKETS).doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException(`Ticket ${ticketId} no encontrado`);
    await ref.update({
      [`extraFields.${fieldKey}`]: value,
      'timestamps.updatedAt': Date.now(),
    });
  }

  async addObservation(ticketId: string, uid: string, role: string, text: string): Promise<void> {
    if (!text?.trim()) throw new BadRequestException('La observación no puede estar vacía.');
    const ref = this.firebase.db.collection(COLLECTIONS.TICKETS).doc(ticketId);
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
