import { Injectable } from '@nestjs/common';
import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { BotConfigService, interpolate } from '../../bot-config/bot-config.service';
import { UsersService } from '../../users/users.service';
import { FirebaseService } from '../../firebase/firebase.service';
import { WhatsappSessionService } from './whatsapp-session.service';
import { WhatsappFormattingService } from './whatsapp-formatting.service';
import { EmailService } from '../../email/email.service';

interface FieldValues {
  [key: string]: unknown;
}

@Injectable()
export class WhatsappTicketCreationService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
    private readonly usersService: UsersService,
    private readonly session: WhatsappSessionService,
    private readonly formatting: WhatsappFormattingService,
    private readonly email: EmailService,
  ) {}

  async createTicket(
    phone: string,
    sessionRef: DocumentReference<DocumentData>,
    fieldValues: FieldValues,
    send: (msg: string) => Promise<void>,
  ): Promise<void> {
    const db = this.firebase.db;

    const ticketData: Record<string, unknown> = {
      ticketNumber: `TKT-${Math.floor(Math.random() * 90000) + 10000}`,
      status: 'REPORTADO',
      reporter: { phone, name: 'Usuario WhatsApp' },
      timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      extraFields: fieldValues,
    };

    const assignedGestorIds = await this.usersService
      .computeAssignedGestorIds(fieldValues as Record<string, unknown>)
      .catch(() => []);

    const docRef = await db.collection('tickets').add({
      ...ticketData,
      assignedGestorIds,
    });

    this.email
      .notifyTicketCreated({ ...ticketData, assignedGestorIds }, assignedGestorIds)
      .catch((err) => console.error('Error enviando email de ticket creado:', err));

    const hostRef = db.collection('hosts').doc(phone);
    const hostSnap = await hostRef.get();
    if (!hostSnap.exists) {
      await hostRef.set({ nombre: phone, telefono: phone, creadoEn: Date.now() });
    }

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const extraVarsCreate = this.formatting.flattenExtraFieldsForInterpolation(
      fieldValues as Record<string, unknown>,
    );
    const successMsg = interpolate(
      msgs?.ticketCreated ?? '✅ Ticket *{ticketNumber}* {action} exitosamente.\n\nTe notificaremos cuando haya actualizaciones de estados.',
      { ticketNumber: String(ticketData.ticketNumber), action: 'creado', ...extraVarsCreate },
    );
    await send(successMsg);
    await sessionRef.set(
      { state: 'IDLE', fieldValues: null, fieldIndex: null, tempFieldPhotos: null },
      { merge: true },
    );
  }
}
