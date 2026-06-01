import { Injectable } from '@nestjs/common';
import { COLLECTIONS, FirebaseService } from '../../firebase/firebase.service';

interface PendingTicket {
  id: string;
  ticketNumber: string;
  status: string;
  extraFields?: Record<string, string | string[]>;
  createdAt?: number;
  updatedAt?: number;
}

@Injectable()
export class WhatsappTicketsUtilService {
  constructor(private readonly firebase: FirebaseService) {}

  async getTicketsByPhone(phone: string): Promise<PendingTicket[]> {
    const snap = await this.firebase.db
      .collection(COLLECTIONS.TICKETS)
      .where('reporter.phone', '==', phone)
      .get();
    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ticketNumber: data.ticketNumber as string,
          status: data.status as string,
          extraFields: (data.extraFields as Record<string, string | string[]>) || {},
          createdAt: data.timestamps?.createdAt as number | undefined,
          updatedAt: data.timestamps?.updatedAt as number | undefined,
        };
      })
      .filter((t) => {
        if (t.status === 'ARCHIVADO') return false;
        if (t.status === 'FINALIZADO') return false;
        return true;
      });
  }
}
