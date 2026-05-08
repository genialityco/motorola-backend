import { Injectable, Logger } from '@nestjs/common';
import {
  initializeApp,
  getApps,
  cert,
  applicationDefault,
  App,
} from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';
import { getStorage, Storage } from 'firebase-admin/storage';

@Injectable()
export class FirebaseService {
  private readonly logger = new Logger(FirebaseService.name);
  private _app: App;
  db: Firestore;
  auth: Auth;
  storage: Storage;

  constructor() {
    const useEmulators = process.env.USE_FIREBASE_EMULATORS === 'true';

    // El Admin SDK lee estas variables de entorno de forma lazy, antes del
    // primer acceso a Firestore/Auth. Hay que setearlas antes de initializeApp.
    if (useEmulators) {
      process.env.FIRESTORE_EMULATOR_HOST =
        process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8010';
      process.env.FIREBASE_AUTH_EMULATOR_HOST =
        process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
      process.env.FIREBASE_STORAGE_EMULATOR_HOST =
        process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199';
    }

    if (getApps().length === 0) {
      const projectId =
        process.env.FIREBASE_PROJECT_ID || 'lenovo-experiences';
      const storageBucket =
        process.env.FIREBASE_STORAGE_BUCKET ||
        'lenovo-experiences.firebasestorage.app';

      if (useEmulators) {
        // Con emuladores no se necesita service account
        this._app = initializeApp({ projectId, storageBucket });
        this.logger.log('Firebase Admin SDK inicializado en modo EMULADOR.');
      } else {
        const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (!credPath) {
          this.logger.error(
            'Sin credenciales: define GOOGLE_APPLICATION_CREDENTIALS en .env ' +
            'apuntando a tu service-account.json, o activa ' +
            'USE_FIREBASE_EMULATORS=true para desarrollo local.',
          );
        }
        this._app = initializeApp({
          credential: credPath ? cert(credPath) : applicationDefault(),
          projectId,
          storageBucket,
        });
        this.logger.log(
          `Firebase Admin SDK inicializado (proyecto: ${projectId}).`,
        );
      }
    } else {
      this._app = getApps()[0];
    }

    this.db = getFirestore(this._app);
    this.auth = getAuth(this._app);
    this.storage = getStorage(this._app);
  }
}
