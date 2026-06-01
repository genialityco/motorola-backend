import { Injectable, Logger } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { COLLECTIONS, FirebaseService } from '../../firebase/firebase.service';

@Injectable()
export class WhatsappApiClient {
  private readonly logger = new Logger(WhatsappApiClient.name);

  constructor(private readonly firebase: FirebaseService) {}

  async sendMessage(to: string, text: string) {
    await this.call(
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      'enviando WhatsApp',
    );
  }

  async sendImageMessage(to: string, imageUrl: string, caption?: string) {
    await this.call(
      {
        messaging_product: 'whatsapp', to, type: 'image',
        image: { link: imageUrl, ...(caption ? { caption } : {}) },
      },
      'enviando imagen WhatsApp',
    );
  }

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

  async getChatHistory(phone: string) {
    const ref = this.firebase.db.collection(COLLECTIONS.SESSIONS).doc(phone);
    const snap = await ref.get();
    return snap.data()?.messages || [];
  }

  async toggleBotForSession(phone: string, botEnabled: boolean) {
    const ref = this.firebase.db.collection(COLLECTIONS.SESSIONS).doc(phone);
    await ref.set({ botEnabled }, { merge: true });
    this.logger.log(`[${phone}] Bot ${botEnabled ? 'habilitado' : 'deshabilitado'}`);
  }

  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return challenge;
    }
    return null;
  }

  async uploadBufferToStorage(buffer: Buffer, mimeType: string, phone: string): Promise<string> {
    try {
      const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
      if (!storageBucket) {
        this.logger.error('FIREBASE_STORAGE_BUCKET no está configurado');
        return '';
      }
      const bucket = this.firebase.storage.bucket(storageBucket);
      const ext = (mimeType.split('/')[1] || 'jpeg').toLowerCase();
      const filePath = `whatsapp_media/${phone}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const file = bucket.file(filePath);
      await file.save(buffer, { metadata: { contentType: mimeType } });
      await file.makePublic();
      return file.publicUrl();
    } catch (err) {
      this.logger.error('Error subiendo buffer a Storage:', err);
      return '';
    }
  }

  async uploadMedia(mediaId: string, mimeType: string, phone: string): Promise<string> {
    const token = process.env.WHATSAPP_TOKEN;
    if (!token) return '';
    try {
      const meta = await fetch(
        `https://graph.facebook.com/v17.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ).then((r) => r.json());
      if (!meta.url) return '';

      const buffer = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.arrayBuffer());

      const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
      if (!storageBucket) return '';

      const bucket = this.firebase.storage.bucket(storageBucket);
      const ext = mimeType.split('/')[1] || 'jpeg';
      const filePath = `whatsapp_media/${phone}/${Date.now()}_${mediaId}.${ext}`;
      const file = bucket.file(filePath);
      await file.save(Buffer.from(buffer), { metadata: { contentType: mimeType } });
      await file.makePublic();
      return file.publicUrl();
    } catch (err) {
      this.logger.error('Error subiendo media a Storage:', err);
      return '';
    }
  }

  private async call(payload: Record<string, unknown>, logLabel: string) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
      this.logger.warn('Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_ID');
      return;
    }
    const res = await fetch(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      this.logger.error(`Error ${logLabel}: ${res.status} ${await res.text()}`);
    }
  }
}
