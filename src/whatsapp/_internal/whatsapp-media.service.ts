import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../../firebase/firebase.service';

@Injectable()
export class WhatsappMediaService {
  private readonly logger = new Logger(WhatsappMediaService.name);

  constructor(private readonly firebase: FirebaseService) {}

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

  async uploadMediaFromMeta(mediaId: string, mimeType: string, phone: string): Promise<string> {
    const token = process.env.WHATSAPP_TOKEN;
    if (!token) return '';

    try {
      const meta = await fetch(
        `https://graph.facebook.com/v17.0/${mediaId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ).then((r) => r.json());

      if (!meta.url) return '';

      const buffer = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.arrayBuffer());

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

  normalizePhoneForWhatsApp(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
    return digits;
  }
}
