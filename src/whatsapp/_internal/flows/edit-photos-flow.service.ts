import { Injectable } from '@nestjs/common';
import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { FirebaseService } from '../../../firebase/firebase.service';
import { getNestedValue } from './helpers';

interface PendingTicket {
  id: string;
  ticketNumber: string;
  status: string;
  extraFields?: Record<string, string | string[]>;
}

@Injectable()
export class WhatsappEditPhotosFlowService {
  constructor(private readonly firebase: FirebaseService) {}

  async handlePhotoAction(
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const ticketData = session.pendingTicketData as PendingTicket;
    const editFieldKey = session.editFieldKey as string;
    const photos = ((getNestedValue(ticketData?.extraFields || {}, editFieldKey) as string[]) || []);

    if (body === '0') {
      await send('Operación cancelada.');
      await this.resetSession(sessionRef);
    } else if (body === '1') {
      if (photos.length === 0) {
        await send('No hay fotos para editar. Selecciona *2* para agregar fotos nuevas, o *0* para cancelar.');
        return;
      }
      const photoList = photos.map((_, i) => `Foto ${i + 1}`).join('\n');
      await send(
        `${photoList}\n\n¿Cuál deseas reemplazar? (responde el número o 0 para cancelar)`,
      );
      await sessionRef.set({ state: 'WAITING_EDIT_PHOTO_SELECTION' }, { merge: true });
    } else if (body === '2') {
      await send('Adjunta las fotos que deseas agregar. Cuando termines, escribe *listo*.');
      await sessionRef.set({ state: 'WAITING_EDIT_ADD_PHOTOS', tempEditPhotos: [] }, { merge: true });
    } else {
      await send('Opción no válida. Responde *1* para editar, *2* para agregar, o *0* para cancelar.');
    }
  }

  async handleAddPhotos(
    body: string,
    incomingPhotoUrl: string | undefined,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const latestDoc = await sessionRef.get();
    const ls = latestDoc.data() || {};
    let tempEditPhotos: string[] = Array.isArray(ls.tempEditPhotos) ? ls.tempEditPhotos : [];
    const ticketId = ls.pendingTicketId as string;
    const editFieldKey = ls.editFieldKey as string;

    if (body === '0') {
      await send('Operación cancelada.');
      await this.resetSession(sessionRef);
    } else if (incomingPhotoUrl) {
      tempEditPhotos = [...tempEditPhotos, incomingPhotoUrl];
      await sessionRef.set({ tempEditPhotos }, { merge: true });
      await send(
        `✅ Foto ${tempEditPhotos.length} recibida. Adjunta más fotos o escribe *listo* para guardar.`,
      );
    } else if (body) {
      if (tempEditPhotos.length === 0) {
        await send(
          'Aún no has adjuntado ninguna foto. Envía imágenes y luego escribe *listo*, o escribe *0* para cancelar.',
        );
        return;
      }

      const freshDoc = await sessionRef.get();
      const freshData = freshDoc.data() || {};
      const finalPhotos: string[] = Array.isArray(freshData.tempEditPhotos)
        ? freshData.tempEditPhotos
        : tempEditPhotos;

      const db = this.firebase.db;
      const ticketSnap = await db.collection('tickets').doc(ticketId).get();
      const existing: string[] =
        ((getNestedValue(
          ticketSnap.data()?.extraFields || {},
          editFieldKey,
        ) as string[]) || []);

      await db.collection('tickets').doc(ticketId).update({
        [`extraFields.${editFieldKey}`]: [...existing, ...finalPhotos],
        'timestamps.updatedAt': Date.now(),
      });

      await send(`✅ ${finalPhotos.length} foto(s) agregada(s) correctamente.`);
      await this.resetSession(sessionRef);
    }
  }

  async handleSelectPhotoToReplace(
    body: string,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const ticketData = session.pendingTicketData as PendingTicket;
    const editFieldKey = session.editFieldKey as string;
    const photos = ((getNestedValue(ticketData?.extraFields || {}, editFieldKey) as string[]) || []);
    const photoIdx = parseInt(body) - 1;

    if (body === '0') {
      await send('Operación cancelada.');
      await this.resetSession(sessionRef);
      return;
    }

    if (isNaN(photoIdx) || photoIdx < 0 || photoIdx >= photos.length) {
      await send(
        `Por favor selecciona un número entre 1 y ${photos.length}, o 0 para cancelar.`,
      );
      return;
    }

    await sessionRef.set({ state: 'WAITING_EDIT_NEW_PHOTO', pendingPhotoIndex: photoIdx }, { merge: true });
    await send(`Adjunta la nueva foto para reemplazar la *Foto ${photoIdx + 1}*:`);
  }

  async handleNewPhoto(
    incomingPhotoUrl: string | undefined,
    sessionRef: DocumentReference<DocumentData>,
    session: Record<string, unknown>,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    if (!incomingPhotoUrl) {
      await send('Por favor adjunta una imagen para continuar.');
      return;
    }

    const latestSessionDoc = await sessionRef.get();
    const ls = latestSessionDoc.data() || {};
    const pendingPhotoIndex = ls.pendingPhotoIndex as number;
    const ticketId = ls.pendingTicketId as string;
    const editFieldKey = ls.editFieldKey as string;

    const db = this.firebase.db;
    const ticketSnap = await db.collection('tickets').doc(ticketId).get();
    const currentPhotos: string[] = [
      ...((getNestedValue(
        ticketSnap.data()?.extraFields || {},
        editFieldKey,
      ) as string[]) || []),
    ];

    if (pendingPhotoIndex >= 0 && pendingPhotoIndex < currentPhotos.length) {
      currentPhotos[pendingPhotoIndex] = incomingPhotoUrl;
    } else {
      currentPhotos.push(incomingPhotoUrl);
    }

    await db.collection('tickets').doc(ticketId).update({
      [`extraFields.${editFieldKey}`]: currentPhotos,
      'timestamps.updatedAt': Date.now(),
    });

    await send('✅ Foto actualizada correctamente.');
    await this.resetSession(sessionRef);
  }

  private async resetSession(sessionRef: DocumentReference<DocumentData>): Promise<void> {
    await sessionRef.set(
      {
        state: 'IDLE',
        pendingTicketId: null,
        pendingTickets: null,
        pendingTicketData: null,
        editableFields: null,
        tempEditPhotos: null,
      },
      { merge: true },
    );
  }
}
