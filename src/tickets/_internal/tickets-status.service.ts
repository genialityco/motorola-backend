import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DocumentData } from 'firebase-admin/firestore';
import { COLLECTIONS, FirebaseService } from '../../firebase/firebase.service';
import { TicketStatus, VALID_STATUSES } from './utils';

@Injectable()
export class TicketsStatusService {
  constructor(private readonly firebase: FirebaseService) {}

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
    if (role === 'gestor' && newStatus === 'FINALIZADO') {
      throw new ForbiddenException('Los gestores no pueden cambiar el estado a FINALIZADO.');
    }

    const db = this.firebase.db;
    const ticketRef = db.collection(COLLECTIONS.TICKETS).doc(ticketId);
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
}
