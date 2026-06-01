import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { COLLECTIONS, FirebaseService } from '../firebase/firebase.service';
import { GestorAssignmentsService } from './_internal/gestor-assignments.service';
import { AssignmentRule } from './_internal/utils';

export { AssignmentRule } from './_internal/utils';

export interface GestorUser {
  uid: string;
  email: string;
  name: string;
  role: 'gestor';
  assignmentRules: AssignmentRule[];
  active: boolean;
  createdAt: number;
}

export interface CreateGestorDto {
  email: string;
  name: string;
  password: string;
  assignmentRules?: AssignmentRule[];
}

export interface UpdateGestorDto {
  name?: string;
  assignmentRules?: AssignmentRule[];
  active?: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly assignments: GestorAssignmentsService,
  ) {}

  async createGestor(dto: CreateGestorDto): Promise<GestorUser> {
    const { email, name, password, assignmentRules = [] } = dto;

    let uid: string;
    try {
      const record = await this.firebase.auth.createUser({ email, password, displayName: name });
      uid = record.uid;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Error creando usuario en Firebase Auth: ${msg}`);
    }

    await this.firebase.auth.setCustomUserClaims(uid, { role: 'gestor' });

    const gestor: GestorUser = {
      uid, email, name, role: 'gestor',
      assignmentRules, active: true, createdAt: Date.now(),
    };

    await this.firebase.db.collection(COLLECTIONS.GESTORS).doc(uid).set(gestor);
    await this.assignments.syncGestorAssignments(uid, assignmentRules);

    return gestor;
  }

  async listUsers(): Promise<GestorUser[]> {
    const snap = await this.firebase.db.collection(COLLECTIONS.GESTORS).get();
    return snap.docs.map((d) => d.data() as GestorUser);
  }

  async getUser(uid: string): Promise<GestorUser> {
    const snap = await this.firebase.db.collection(COLLECTIONS.GESTORS).doc(uid).get();
    if (!snap.exists) throw new NotFoundException(`Usuario ${uid} no encontrado.`);
    return snap.data() as GestorUser;
  }

  async updateUser(uid: string, dto: UpdateGestorDto): Promise<void> {
    const ref = this.firebase.db.collection(COLLECTIONS.GESTORS).doc(uid);
    const snap = await ref.get();
    if (!snap.exists) throw new NotFoundException(`Usuario ${uid} no encontrado.`);

    const updates: Record<string, unknown> = {};
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.active !== undefined) updates.active = dto.active;
    if (dto.assignmentRules !== undefined) updates.assignmentRules = dto.assignmentRules;

    if (Object.keys(updates).length > 0) {
      await ref.update(updates);
    }

    if (dto.assignmentRules !== undefined) {
      await this.assignments.syncGestorAssignments(uid, dto.assignmentRules);
    }
  }

  async deleteUser(uid: string): Promise<void> {
    await this.firebase.auth.deleteUser(uid).catch(() => null);
    await this.firebase.db.collection(COLLECTIONS.GESTORS).doc(uid).delete();
  }

  async promoteToAdmin(uid: string, setupKey: string): Promise<void> {
    const expectedKey = process.env.ADMIN_SETUP_KEY;
    if (!expectedKey) {
      throw new BadRequestException('ADMIN_SETUP_KEY no está configurado en el servidor.');
    }
    if (setupKey !== expectedKey) {
      throw new BadRequestException('Clave de configuración incorrecta.');
    }
    await this.firebase.auth.setCustomUserClaims(uid, { role: 'admin' });
  }

  computeAssignedGestorIds(extraFields: Record<string, unknown>): Promise<string[]> {
    return this.assignments.computeAssignedGestorIds(extraFields);
  }

  recomputeAllTicketAssignments(): Promise<{ updated: number }> {
    return this.assignments.recomputeAllTicketAssignments();
  }
}
