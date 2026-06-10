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
        return {
          id: d.id,
          ticketNumber: data.ticketNumber as string,
          status: data.status as string,
          extraFields: (data.extraFields as Record<string, string | string[]>) || {},
          createdAt: data.timestamps?.createdAt as number | undefined,
          updatedAt: data.timestamps?.updatedAt as number | undefined,
          scheduledDate: data.scheduledDate as string | undefined,
        };
      })
      .filter((t) => {
        if (t.status === 'ARCHIVADO') return false;
        if (t.status === 'FINALIZADO') return false;
        return true;
      });
  }
}
