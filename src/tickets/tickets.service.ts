import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { FieldValue } from 'firebase-admin/firestore';

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

@Injectable()
export class TicketsService {
  constructor(private readonly firebase: FirebaseService) {}

  async transitionStatus(
    ticketId: string,
    newStatus: TicketStatus,
    uid: string,
    role: string,
    comments?: string,
  ) {
    if (!VALID_STATUSES.includes(newStatus)) {
      throw new BadRequestException(`Estado inválido: ${newStatus}`);
    }

    const db = this.firebase.db;
    const ticketRef = db.collection('tickets').doc(ticketId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ticketRef);
      if (!snap.exists) throw new NotFoundException('El ticket no existe.');

      const prevStatus = snap.data()?.status;

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

    return { success: true, message: 'Ticket actualizado correctamente.' };
  }

  async deleteEvidencePhoto(
    ticketId: string,
    photoIndex: number,
  ): Promise<{ ticketNumber: string; reporterPhone: string }> {
    const db = this.firebase.db;
    const ticketRef = db.collection('tickets').doc(ticketId);

    const snap = await ticketRef.get();
    if (!snap.exists) throw new NotFoundException('El ticket no existe.');

    const data = snap.data()!;
    const evidencePhotos: string[] = data.photos?.evidence || [];

    if (photoIndex < 0 || photoIndex >= evidencePhotos.length) {
      throw new BadRequestException('Índice de foto inválido.');
    }

    const newPhotos = evidencePhotos.filter((_, i) => i !== photoIndex);

    await ticketRef.update({
      'photos.evidence': newPhotos,
      'timestamps.updatedAt': Date.now(),
    });

    return {
      ticketNumber: data.ticketNumber as string,
      reporterPhone: data.reporter?.phone as string,
    };
  }

  async deleteRepairPhoto(
    ticketId: string,
    photoIndex: number,
  ): Promise<void> {
    const db = this.firebase.db;
    const ticketRef = db.collection('tickets').doc(ticketId);

    const snap = await ticketRef.get();
    if (!snap.exists) throw new NotFoundException('El ticket no existe.');

    const data = snap.data()!;
    const repairPhotos: string[] = data.photos?.repair || [];

    if (photoIndex < 0 || photoIndex >= repairPhotos.length) {
      throw new BadRequestException('Índice de foto inválido.');
    }

    const newPhotos = repairPhotos.filter((_, i) => i !== photoIndex);

    await ticketRef.update({
      'photos.repair': newPhotos,
      'timestamps.updatedAt': Date.now(),
    });
  }

  async addRepairPhoto(ticketId: string, photoUrl: string): Promise<void> {
    const db = this.firebase.db;
    const ticketRef = db.collection('tickets').doc(ticketId);

    const snap = await ticketRef.get();
    if (!snap.exists) throw new NotFoundException('El ticket no existe.');

    await ticketRef.update({
      'photos.repair': FieldValue.arrayUnion(photoUrl),
      'timestamps.updatedAt': Date.now(),
    });
  }

  async uploadToStorage(
    buffer: Buffer,
    mimeType: string,
    folder: string,
  ): Promise<string> {
    const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
    if (!storageBucket) {
      throw new Error('FIREBASE_STORAGE_BUCKET no está configurado');
    }

    const bucket = this.firebase.storage.bucket(storageBucket);
    const ext = (mimeType.split('/')[1] || 'jpeg').toLowerCase();
    const filePath = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const file = bucket.file(filePath);

    await file.save(buffer, { metadata: { contentType: mimeType } });
    await file.makePublic();

    return file.publicUrl();
  }

  async updateObservation(ticketId: string, observations: string): Promise<void> {
    const ref = this.firebase.db.collection('tickets').doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException(`Ticket ${ticketId} no encontrado`);
    await ref.update({ observations, 'timestamps.updatedAt': Date.now() });
  }
}
