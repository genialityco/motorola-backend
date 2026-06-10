import { DocumentReference, DocumentData } from 'firebase-admin/firestore';
import { FirebaseService } from '../../../firebase/firebase.service';
import { BotConfigService, BotMessages } from '../../../bot-config/bot-config.service';
import { UsersService } from '../../../users/users.service';
import { WhatsappSessionService } from '../whatsapp-session.service';
import { WhatsappFormattingService } from '../whatsapp-formatting.service';
import { WhatsappMediaService } from '../whatsapp-media.service';
import { WhatsappTicketsUtilService } from '../whatsapp-tickets-util.service';

export interface FlowContext {
  phone: string;
  body: string;
  state: string;
  session: Record<string, unknown>;
  sessionRef: DocumentReference<DocumentData>;
  incomingPhotoUrl?: string;
  msgs: BotMessages | null;
  send: (text: string) => Promise<void>;
  sendPhoto: (url: string) => Promise<void>;
  deps: {
    firebase: FirebaseService;
    botConfig: BotConfigService;
    usersService: UsersService;
    session: WhatsappSessionService;
    formatting: WhatsappFormattingService;
    media: WhatsappMediaService;
    ticketsUtil: WhatsappTicketsUtilService;
  };
}
