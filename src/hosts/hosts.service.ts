import { Injectable, NotFoundException } from '@nestjs/common';
import { COLLECTIONS, FirebaseService } from '../firebase/firebase.service';

@Injectable()
export class HostsService {
  constructor(private readonly firebase: FirebaseService) {}

  async upsertHost(telefono: string): Promise<void> {
    const ref = this.firebase.db.collection(COLLECTIONS.HOSTS).doc(telefono);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({ nombre: telefono, telefono, creadoEn: Date.now() });
    }
  }

  async getAll(): Promise<any[]> {
    const snap = await this.firebase.db.collection(COLLECTIONS.HOSTS).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async update(telefono: string, nombre: string): Promise<void> {
    const ref = this.firebase.db.collection(COLLECTIONS.HOSTS).doc(telefono);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException('Host no encontrado');
    await ref.update({ nombre });
  }
}
