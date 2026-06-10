import { Injectable } from '@nestjs/common';
import { FirebaseService } from '../../firebase/firebase.service';

interface PendingTicket {
  id: string;
  ticketNumber: string;
  status: string;
  extraFields?: Record<string, string | string[]>;
  createdAt?: number;
  updatedAt?: number;
  scheduledDate?: string;
}

@Injectable()
export class WhatsappTicketsUtilService {
  constructor(private readonly firebase: FirebaseService) {}

  async getTicketsByPhone(phone: string): Promise<PendingTicket[]> {
    const snap = await this.firebase.db
      .collection('tickets')
      .where('reporter.phone', '==', phone)
      .get();
    return snap.docs
      .map((d) => {
        const data = d.data();
        // Estos objetos se persisten luego en la sesión (`pendingTickets`), y
        // Firestore rechaza valores `undefined`. Por eso solo incluimos los
        // campos opcionales cuando realmente tienen valor.
        const ticket: PendingTicket = {
          id: d.id,
          ticketNumber: data.ticketNumber as string,
          status: data.status as string,
          extraFields: (data.extraFields as Record<string, string | string[]>) || {},
        };
        const createdAt = data.timestamps?.createdAt as number | undefined;
        const updatedAt = data.timestamps?.updatedAt as number | undefined;
        const scheduledDate = data.scheduledDate as string | undefined;
        if (createdAt !== undefined) ticket.createdAt = createdAt;
        if (updatedAt !== undefined) ticket.updatedAt = updatedAt;
        if (scheduledDate !== undefined) ticket.scheduledDate = scheduledDate;
        return ticket;
      })
      .filter((t) => {
        if (t.status === 'ARCHIVADO') return false;
        if (t.status === 'FINALIZADO') return false;
        return true;
      });
  }
}
