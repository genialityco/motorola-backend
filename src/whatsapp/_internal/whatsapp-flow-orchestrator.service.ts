import { Injectable, Logger } from '@nestjs/common';
import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { FirebaseService } from '../../firebase/firebase.service';
import { BotConfigService, interpolate } from '../../bot-config/bot-config.service';
import { WhatsappSessionService } from './whatsapp-session.service';
import { WhatsappMediaService } from './whatsapp-media.service';
import { WhatsappCreateFlowService } from './flows/create-flow.service';
import { WhatsappViewFlowService } from './flows/view-flow.service';
import { WhatsappEditFlowService } from './flows/edit-flow.service';
import { WhatsappEditPhotosFlowService } from './flows/edit-photos-flow.service';
import { WhatsappDeleteFlowService } from './flows/delete-flow.service';
import { WhatsappMainFlowService } from './flows/main-flow.service';
import { normalizeText } from './flows/helpers';

const CREATE_FLOW_STATES = ['WAITING_FIELD', 'WAITING_FIELD_OTHER_RESPONSE'];
const EDIT_FLOW_STATES = [
  'WAITING_TICKET_SELECTION_EDIT',
  'WAITING_EDIT_FIELD_SELECTION',
  'WAITING_EDIT_FIELD_VALUE',
  'WAITING_EDIT_PHOTO_ACTION',
  'WAITING_EDIT_ADD_PHOTOS',
  'WAITING_EDIT_PHOTO_SELECTION',
  'WAITING_EDIT_NEW_PHOTO',
  'WAITING_ADMIN_REQUESTED_UPDATE',
];
const DEFAULT_SESSION_TIMEOUT_HOURS = 24;

interface WhatsAppMessage {
  from?: string;
  type?: string;
  text?: { body?: string };
  image?: {
    mime_type?: string;
    id?: string;
    caption?: string;
    directUrl?: string;
  };
}

interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: { messages?: WhatsAppMessage[] };
    }>;
  }>;
}

@Injectable()
export class WhatsappFlowOrchestratorService {
  private readonly logger = new Logger(WhatsappFlowOrchestratorService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly botConfig: BotConfigService,
    private readonly session: WhatsappSessionService,
    private readonly media: WhatsappMediaService,
    private readonly createFlow: WhatsappCreateFlowService,
    private readonly viewFlow: WhatsappViewFlowService,
    private readonly editFlow: WhatsappEditFlowService,
    private readonly editPhotosFlow: WhatsappEditPhotosFlowService,
    private readonly deleteFlow: WhatsappDeleteFlowService,
    private readonly mainFlow: WhatsappMainFlowService,
  ) {}

  async processMessage(
    payload: WhatsAppWebhookPayload,
    onResponse?: (msg: string) => void,
  ): Promise<void> {
    const message = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const phone = message.from || '';
    const body = message.text?.body?.trim() || '';
    const db = this.firebase.db;
    const sessionRef = db.collection('whatsapp_sessions').doc(phone);
    const sessionDoc = await sessionRef.get();
    const session = sessionDoc.data() || {};
    const state: string = session.state || 'IDLE';
    const botEnabled = session.botEnabled !== false;

    let incomingPhotoUrl: string | undefined;
    if (message.type === 'image' && (message.image?.directUrl || message.image?.id)) {
      incomingPhotoUrl = message.image.directUrl;
      if (!incomingPhotoUrl && message.image?.id) {
        incomingPhotoUrl = await this.media.uploadMediaFromMeta(
          message.image.id,
          message.image.mime_type || 'image/jpeg',
          phone,
        );
      }
      if (incomingPhotoUrl) {
        await this.session.saveMessage(phone, 'user', message.image.caption || '[imagen]', incomingPhotoUrl);
      }
    } else {
      await this.session.saveMessage(phone, 'user', body || '[imagen]');
    }

    if (!botEnabled) {
      this.logger.log(`[${phone}] Bot deshabilitado. Mensaje guardado sin respuesta automática.`);
      return;
    }

    const send = (text: string) => this.session.reply(phone, text, onResponse);
    const sendPhoto = (url: string) => this.session.reply(phone, '[imagen]', onResponse, url);

    const msgs = await this.botConfig.getMessages().catch(() => null);
    const backKeyword = normalizeText(msgs?.backToMenuKeyword || 'INICIO');

    // ─── VERIFICAR RESET CON KEYWORD ──────────────────────────────────────────
    if (state !== 'IDLE' && body && normalizeText(body) === backKeyword) {
      await this.resetSession(sessionRef);
      await send(msgs?.menu ?? 'Hola, ¿en qué puedo ayudarte?');
      return;
    }

    // ─── VERIFICAR EXPIRACIÓN DE SESIÓN ───────────────────────────────────────
    if (state !== 'IDLE' && session.lastActivity) {
      const settings = await this.botConfig.getSettings().catch(() => null);
      const timeoutHours = settings?.sessionTimeoutHours ?? DEFAULT_SESSION_TIMEOUT_HOURS;
      const elapsed = Date.now() - (session.lastActivity as number);

      if (elapsed > timeoutHours * 60 * 60 * 1000) {
        await this.resetSession(sessionRef);
        const hours = String(timeoutHours);

        if (CREATE_FLOW_STATES.includes(state)) {
          await send(
            interpolate(
              msgs?.sessionExpiredCreate ??
                'Tu sesión para crear el ticket expiró por inactividad ({hours} horas). Por favor, selecciona la opción *1* para comenzar nuevamente.',
              { hours },
            ),
          );
        } else if (EDIT_FLOW_STATES.includes(state)) {
          await send(
            interpolate(
              msgs?.sessionExpiredEdit ??
                'Tu sesión para editar el ticket expiró por inactividad ({hours} horas). Por favor, selecciona la opción *3* para editar nuevamente.',
              { hours },
            ),
          );
        } else {
          await send(
            interpolate(
              msgs?.sessionExpiredGeneric ??
                'Tu sesión expiró por inactividad ({hours} horas). Por favor, selecciona una opción del menú.',
              { hours },
            ),
          );
        }
        return;
      }
    }

    await sessionRef.set({ lastActivity: Date.now() }, { merge: true });

    // ─── ROUTING SEGÚN STATE ─────────────────────────────────────────────────
    if (state === 'IDLE') {
      const action = await this.mainFlow.handleIdleMenu(phone, body, sessionRef, send);

      if (action === 'VIEW') {
        await this.viewFlow.handleViewSelection(phone, body, sessionRef, send, sendPhoto);
      } else if (action === 'EDIT') {
        await this.editFlow.handleEditSelection(phone, body, sessionRef, send);
      } else if (action === 'DELETE') {
        await this.deleteFlow.handleDeleteSelection(phone, body, sessionRef, send);
      }
    } else if (CREATE_FLOW_STATES.includes(state)) {
      if (state === 'WAITING_FIELD') {
        await this.createFlow.handleFieldCollection(
          phone,
          sessionRef,
          body,
          incomingPhotoUrl,
          session,
          send,
        );
      } else if (state === 'WAITING_FIELD_OTHER_RESPONSE') {
        await this.createFlow.handleOtherResponse(phone, sessionRef, body, session, send);
      }
    } else if (state === 'WAITING_TICKET_SELECTION_VIEW') {
      await this.viewFlow.handleSelectTicket(body, sessionRef, session, send);
    } else if (state === 'WAITING_VIEW_OPTION') {
      await this.viewFlow.handleViewOption(body, sessionRef, session, send, sendPhoto);
    } else if (state === 'WAITING_TICKET_SELECTION_EDIT') {
      await this.editFlow.handleSelectTicket(body, sessionRef, session, send);
    } else if (state === 'WAITING_EDIT_FIELD_SELECTION') {
      await this.editFlow.handleFieldSelection(body, sessionRef, session, send);
    } else if (state === 'WAITING_EDIT_FIELD_VALUE') {
      await this.editFlow.handleFieldValue(body, sessionRef, session, send);
    } else if (state === 'WAITING_EDIT_OTHER_RESPONSE') {
      await this.editFlow.handleOtherResponse(body, sessionRef, session, send);
    } else if (state === 'WAITING_EDIT_PHOTO_ACTION') {
      await this.editPhotosFlow.handlePhotoAction(body, sessionRef, session, send);
    } else if (state === 'WAITING_EDIT_ADD_PHOTOS') {
      await this.editPhotosFlow.handleAddPhotos(body, incomingPhotoUrl, sessionRef, session, send);
    } else if (state === 'WAITING_EDIT_PHOTO_SELECTION') {
      await this.editPhotosFlow.handleSelectPhotoToReplace(body, sessionRef, session, send);
    } else if (state === 'WAITING_EDIT_NEW_PHOTO') {
      await this.editPhotosFlow.handleNewPhoto(incomingPhotoUrl, sessionRef, session, send);
    } else if (state === 'WAITING_TICKET_SELECTION_DELETE') {
      await this.deleteFlow.handleSelectTicket(body, sessionRef, session, send);
    } else if (state === 'WAITING_TICKET_SELECTION_FINALIZE') {
      await this.mainFlow.handleFinalizeSelection(body, sessionRef, session, send);
    } else if (state === 'WAITING_ADMIN_REQUESTED_UPDATE') {
      await this.mainFlow.handleAdminRequestedUpdate(sessionRef, send);
    } else {
      await this.resetSession(sessionRef);
      await send('Operación cancelada. Escribe cualquier mensaje para volver al menú.');
    }
  }

  private async resetSession(sessionRef: DocumentReference<DocumentData>): Promise<void> {
    await sessionRef.set(
      {
        state: 'IDLE',
        lastActivity: Date.now(),
        fieldIndex: null,
        fieldValues: null,
        tempFieldPhotos: null,
        pendingTickets: null,
        pendingTicketId: null,
        pendingTicketData: null,
        editableFields: null,
        editFieldKey: null,
        editFieldType: null,
        editFieldOptions: null,
        requestedFieldKey: null,
        requestedFieldLabel: null,
        requestedTicketId: null,
        tempEditPhotos: null,
        pendingPhotoIndex: null,
      },
      { merge: true },
    );
  }
}
