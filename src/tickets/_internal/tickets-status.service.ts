import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DocumentData } from 'firebase-admin/firestore';
import { FirebaseService } from '../../firebase/firebase.service';
import { BotConfigService } from '../../bot-config/bot-config.service';
import { TicketStatus, VALID_STATUSES, getNestedValue } from './utils';

@Injectable()
export class TicketsStatusService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
  ) {}

  async transitionStatus(
    ticketId: string,
    newStatus: TicketStatus,
    uid: string,
    role: string,
    comments?: string,
    scheduledDate?: string,
  ): Promise<{ success: boolean; message: string; prevStatus: string; ticketData: DocumentData }> {
    if (!VALID_STATUSES.includes(newStatus)) {
      throw new BadRequestException(`Estado inválido: ${newStatus}`);
    }
    if (role === 'gestor' && newStatus === 'FINALIZADO') {
      throw new ForbiddenException('Los gestores no pueden cambiar el estado a FINALIZADO.');
    }
    if ((newStatus === 'PROGRAMADO' || newStatus === 'REPROGRAMADO') && !scheduledDate) {
      throw new BadRequestException(`Se requiere una fecha programada para cambiar al estado ${newStatus}.`);
    }
    if (scheduledDate && isNaN(new Date(scheduledDate).getTime())) {
      throw new BadRequestException('La fecha programada no tiene un formato válido.');
    }

    const adminPhotoFieldKeys = newStatus === 'REPARADO' ? await this.getAdminPhotoKeys() : [];

    const db = this.firebase.db;
    const ticketRef = db.collection('tickets').doc(ticketId);
    let prevStatus = '';
    let ticketData: DocumentData = {};

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ticketRef);
      if (!snap.exists) throw new NotFoundException('El ticket no existe.');

      prevStatus = snap.data()?.status ?? '';
      ticketData = snap.data()!;

      if (newStatus === 'REPARADO' && adminPhotoFieldKeys.length > 0) {
        this.assertHasRepairPhoto(ticketData, adminPhotoFieldKeys);
      }

      const updateData: Record<string, unknown> = {
        status: newStatus,
        'timestamps.updatedAt': Date.now(),
      };
      if (scheduledDate && (newStatus === 'PROGRAMADO' || newStatus === 'REPROGRAMADO')) {
        updateData.scheduledDate = scheduledDate;
      }
      tx.update(ticketRef, updateData);

      const historyEntry: Record<string, unknown> = {
        previousStatus: prevStatus,
        newStatus,
        changedBy: { uid, role },
        comments: comments || '',
        timestamp: Date.now(),
      };
      if (scheduledDate && (newStatus === 'PROGRAMADO' || newStatus === 'REPROGRAMADO')) {
        historyEntry.scheduledDate = scheduledDate;
      }
      tx.set(ticketRef.collection('statusHistory').doc(), historyEntry);
    });

    return { success: true, message: 'Ticket actualizado correctamente.', prevStatus, ticketData };
  }

  private async getAdminPhotoKeys(): Promise<string[]> {
    const allFields = await this.botConfig.getFields();
    return allFields
      .filter((f) => f.type === 'photo' && f.source === 'admin')
      .map((f) => f.key);
  }

  private assertHasRepairPhoto(ticketData: DocumentData, keys: string[]): void {
    const extraFields = (ticketData.extraFields as Record<string, unknown>) || {};
    const hasRepairPhoto = keys.some((key) => {
      const val = getNestedValue(extraFields, key);
      return Array.isArray(val) && (val as string[]).length > 0;
    });
    if (!hasRepairPhoto) {
      throw new BadRequestException('Se requiere al menos una foto de reparación para cambiar al estado REPARADO.');
    }
  }
}
