import { Injectable } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { COLLECTIONS, FirebaseService } from '../../firebase/firebase.service';
import { AssignmentRule, rulesMatch } from './utils';

interface GestorLite {
  uid: string;
  assignmentRules: AssignmentRule[];
}

@Injectable()
export class GestorAssignmentsService {
  constructor(private readonly firebase: FirebaseService) {}

  async getActiveGestors(): Promise<GestorLite[]> {
    const snap = await this.firebase.db
      .collection(COLLECTIONS.GESTORS)
      .where('role', '==', 'gestor')
      .where('active', '==', true)
      .get();
    return snap.docs.map((d) => d.data() as GestorLite);
  }

  async computeAssignedGestorIds(extraFields: Record<string, unknown>): Promise<string[]> {
    const gestors = await this.getActiveGestors();
    return gestors
      .filter((g) => rulesMatch(extraFields, g.assignmentRules))
      .map((g) => g.uid);
  }

  async syncGestorAssignments(uid: string, rules: AssignmentRule[]): Promise<void> {
    const ticketSnap = await this.firebase.db.collection(COLLECTIONS.TICKETS).get();
    if (ticketSnap.empty) return;

    const batch = this.firebase.db.batch();

    for (const doc of ticketSnap.docs) {
      const data = doc.data();
      const extraFields = (data.extraFields as Record<string, unknown>) ?? {};
      const currentIds = (data.assignedGestorIds as string[]) ?? [];
      const matches = rulesMatch(extraFields, rules);
      const hasGestor = currentIds.includes(uid);

      if (matches && !hasGestor) {
        batch.update(doc.ref, { assignedGestorIds: FieldValue.arrayUnion(uid) });
      } else if (!matches && hasGestor) {
        batch.update(doc.ref, { assignedGestorIds: FieldValue.arrayRemove(uid) });
      }
    }

    await batch.commit();
  }

  async recomputeAllTicketAssignments(): Promise<{ updated: number }> {
    const [ticketSnap, gestors] = await Promise.all([
      this.firebase.db.collection(COLLECTIONS.TICKETS).get(),
      this.getActiveGestors(),
    ]);

    const batch = this.firebase.db.batch();
    let updated = 0;

    for (const doc of ticketSnap.docs) {
      const data = doc.data();
      const extraFields = (data.extraFields as Record<string, unknown>) ?? {};
      const assignedGestorIds = gestors
        .filter((g) => rulesMatch(extraFields, g.assignmentRules))
        .map((g) => g.uid);

      batch.update(doc.ref, { assignedGestorIds });
      updated++;
    }

    await batch.commit();
    return { updated };
  }
}
