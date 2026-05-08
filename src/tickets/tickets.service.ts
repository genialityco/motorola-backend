import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { FieldValue, DocumentData } from 'firebase-admin/firestore';

type TicketStatus =
  | 'REPORTADO'
  | 'REVISION'
  | 'EN_REPARACION'
  | 'REPARADO'
  | 'ENTREGADO'
  | 'FINALIZADO';

const VALID_STATUSES: TicketStatus[] = [
  'REPORTADO',
  'REVISION',
  'EN_REPARACION',
  'REPARADO',
  'ENTREGADO',
  'FINALIZADO',
];

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, obj);
}

@Injectable()
export class TicketsService {
  private readonly storageBucket: string;

  constructor(private readonly firebase: FirebaseService) {
    this.storageBucket = process.env.FIREBASE_STORAGE_BUCKET ?? '';
  }

  async transitionStatus(
    ticketId: string,
    newStatus: TicketStatus,
    uid: string,
    role: string,
    comments?: string,
  ): Promise<{ success: boolean; message: string; prevStatus: string; ticketData: DocumentData }> {
    if (!VALID_STATUSES.includes(newStatus)) {
      throw new BadRequestException(`Estado inválido: ${newStatus}`);
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

      tx.update(ticketRef, {
        status: newStatus,
        'timestamps.updatedAt': Date.now(),
      });

      tx.set(ticketRef.collection('statusHistory').doc(), {
        previousStatus: prevStatus,
        newStatus,
        changedBy: { uid, role },
        comments: comments || '',
        timestamp: Date.now(),
      });
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
