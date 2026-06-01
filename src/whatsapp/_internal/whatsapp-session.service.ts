import { Injectable } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { COLLECTIONS, FirebaseService } from '../../firebase/firebase.service';
import { WhatsappMessagesService } from './whatsapp-messages.service';

@Injectable()
export class WhatsappSessionService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly messages: WhatsappMessagesService,
  ) {}

  async saveMessage(
    phone: string,
    from: 'user' | 'bot' | 'admin',
    text: string,
    photoUrl?: string,
  ) {
    const ref = this.firebase.db.collection(COLLECTIONS.SESSIONS).doc(phone);
    const entry: Record<string, unknown> = { from, text, timestamp: Date.now() };
    if (photoUrl) entry.photoUrl = photoUrl;
    await ref.set({ messages: FieldValue.arrayUnion(entry) }, { merge: true });
  }

  async reply(
    phone: string,
    text: string,
    onResponse?: (msg: string) => void,
    photoUrl?: string,
  ) {
    await this.saveMessage(phone, 'bot', text, photoUrl);
    if (onResponse) {
      onResponse(photoUrl ? `[IMG]${photoUrl}` : text);
    } else if (photoUrl) {
      await this.messages.sendImageMessage(phone, photoUrl, text !== '[imagen]' ? text : undefined);
    } else {
      await this.messages.sendMessage(phone, text);
    }
  }

  async sendAdminMessage(to: string, text: string) {
    await this.saveMessage(to, 'admin', text);
    await this.messages.sendMessage(to, text);
  }

  async toggleBotForSession(phone: string, botEnabled: boolean) {
    const ref = this.firebase.db.collection(COLLECTIONS.SESSIONS).doc(phone);
    await ref.set({ botEnabled }, { merge: true });
  }

  async getChatHistory(phone: string): Promise<Array<{ from: string; text?: string; photoUrl?: string; timestamp: number }>> {
    const sessionRef = this.firebase.db.collection(COLLECTIONS.SESSIONS).doc(phone);
    const sessionDoc = await sessionRef.get();
    const data = sessionDoc.data();
    return data?.messages || [];
  }
}
