import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map((provider) => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export interface LocalProfilePayload {
  farmerCode: string;
  farmName: string;
  avatar: string;
  country: string;
  gender: 'male' | 'female';
  level: number;
  coopPoints: number;
}

export interface FriendRequestItem {
  id: string;
  fromUid: string;
  toUid: string;
  fromFarmerCode: string;
  fromFarmName: string;
  fromAvatar: string;
  fromCountry: string;
  fromGender: 'male' | 'female';
  fromLevel: number;
  toFarmerCode: string;
  toFarmName: string;
  toAvatar: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface CropGiftItem {
  id: string;
  fromUid: string;
  toUid: string;
  fromFarmerCode: string;
  fromFarmName: string;
  fromAvatar: string;
  cropId: string;
  cropName: string;
  qty: number;
  status: 'sent' | 'claimed';
}

type BridgeListener = (snapshot: {
  authReady: boolean;
  user: { uid: string; displayName: string | null; emailVerified: boolean } | null;
  incomingRequests: FriendRequestItem[];
  outgoingRequests: FriendRequestItem[];
  incomingGifts: CropGiftItem[];
}) => void;

let currentUser: User | null = null;
let authReady = false;
let incomingRequests: FriendRequestItem[] = [];
let outgoingRequests: FriendRequestItem[] = [];
let incomingGifts: CropGiftItem[] = [];
let unsubInReq: Unsubscribe | null = null;
let unsubOutReq: Unsubscribe | null = null;
let unsubGifts: Unsubscribe | null = null;
const listeners = new Set<BridgeListener>();

function emitState() {
  const payload = {
    authReady,
    user: currentUser
      ? {
          uid: currentUser.uid,
          displayName: currentUser.displayName,
          emailVerified: currentUser.emailVerified,
        }
      : null,
    incomingRequests: [...incomingRequests],
    outgoingRequests: [...outgoingRequests],
    incomingGifts: [...incomingGifts],
  };
  listeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (e) {
      console.error(e);
    }
  });
}

function detachUserListeners() {
  if (unsubInReq) { unsubInReq(); unsubInReq = null; }
  if (unsubOutReq) { unsubOutReq(); unsubOutReq = null; }
  if (unsubGifts) { unsubGifts(); unsubGifts = null; }
  incomingRequests = [];
  outgoingRequests = [];
  incomingGifts = [];
}

function attachUserListeners(uid: string) {
  detachUserListeners();
  const frPath = 'friendRequests';
  unsubInReq = onSnapshot(
    query(collection(db, frPath), where('toUid', '==', uid)),
    (snap) => {
      incomingRequests = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FriendRequestItem, 'id'>) }));
      emitState();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, frPath);
      } catch {
        // surfaced cleanly to console
      }
    }
  );

  unsubOutReq = onSnapshot(
    query(collection(db, frPath), where('fromUid', '==', uid)),
    (snap) => {
      outgoingRequests = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FriendRequestItem, 'id'>) }));
      emitState();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, frPath);
      } catch {
        // surfaced cleanly to console
      }
    }
  );

  const giftPath = 'cropGifts';
  unsubGifts = onSnapshot(
    query(collection(db, giftPath), where('toUid', '==', uid)),
    (snap) => {
      incomingGifts = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<CropGiftItem, 'id'>) }))
        .filter((g) => g.status === 'sent');
      emitState();
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, giftPath);
      } catch {
        // surfaced cleanly to console
      }
    }
  );
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  authReady = true;
  if (user) {
    attachUserListeners(user.uid);
  } else {
    detachUserListeners();
  }
  emitState();
});

const sanitizeFarmerCode = (raw: string) =>
  String(raw || 'HF-FARM1')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 24) || 'HF-FARM1';

const clampStr = (s: string, max: number, fallback: string) => {
  const cleaned = String(s || '').trim();
  return (cleaned || fallback).slice(0, max);
};

const FarmFirebase = {
  isReady() {
    return authReady;
  },
  getUser() {
    return currentUser
      ? { uid: currentUser.uid, displayName: currentUser.displayName, emailVerified: currentUser.emailVerified }
      : null;
  },
  onStateChange(cb: BridgeListener) {
    listeners.add(cb);
    if (authReady) {
      cb({
        authReady,
        user: currentUser
          ? { uid: currentUser.uid, displayName: currentUser.displayName, emailVerified: currentUser.emailVerified }
          : null,
        incomingRequests: [...incomingRequests],
        outgoingRequests: [...outgoingRequests],
        incomingGifts: [...incomingGifts],
      });
    }
    return () => listeners.delete(cb);
  },
  async signInWithGoogle() {
    const provider = new GoogleAuthProvider();
    const res = await signInWithPopup(auth, provider);
    return { uid: res.user.uid, displayName: res.user.displayName, emailVerified: res.user.emailVerified };
  },
  async signOutUser() {
    await signOut(auth);
  },
  async syncFarmerProfile(profile: LocalProfilePayload) {
    if (!currentUser || !currentUser.emailVerified) return null;
    const uid = currentUser.uid;
    const farmerPath = `farmers/${uid}`;
    const farmName = clampStr(profile.farmName, 32, 'مزرعة السعادة');
    const avatar = clampStr(profile.avatar, 12, '👨‍🌾');
    const country = clampStr(profile.country, 40, 'مصر');
    const gender: 'male' | 'female' = profile.gender === 'female' ? 'female' : 'male';
    const level = Math.max(1, Math.min(999, Math.floor(Number(profile.level) || 1)));
    const coopPoints = Math.max(0, Math.min(10000000, Math.floor(Number(profile.coopPoints) || 0)));

    let existingSnap;
    try {
      existingSnap = await getDoc(doc(db, 'farmers', uid));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, farmerPath);
    }

    if (existingSnap && existingSnap.exists()) {
      const data = existingSnap.data();
      const lockedCode = sanitizeFarmerCode(String(data.farmerCode || profile.farmerCode));
      const batch = writeBatch(db);
      batch.update(doc(db, 'farmers', uid), {
        farmName,
        avatar,
        country,
        gender,
        level,
        coopPoints,
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'farmerCodes', lockedCode), {
        farmName,
        avatar,
        updatedAt: serverTimestamp(),
      });
      try {
        await batch.commit();
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, farmerPath);
      }
      return lockedCode;
    }

    const code = sanitizeFarmerCode(profile.farmerCode);
    const batch = writeBatch(db);
    batch.set(doc(db, 'farmers', uid), {
      uid,
      farmerCode: code,
      farmName,
      avatar,
      country,
      gender,
      level,
      coopPoints,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'farmerCodes', code), {
      uid,
      farmerCode: code,
      farmName,
      avatar,
      updatedAt: serverTimestamp(),
    });
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, farmerPath);
    }
    return code;
  },
  async sendFriendRequestByCode(rawCode: string, myProfile: LocalProfilePayload) {
    if (!currentUser || !currentUser.emailVerified) {
      throw new Error('NOT_SIGNED_IN');
    }
    const targetCode = sanitizeFarmerCode(rawCode);
    const codePath = `farmerCodes/${targetCode}`;
    let codeSnap;
    try {
      codeSnap = await getDoc(doc(db, 'farmerCodes', targetCode));
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, codePath);
    }
    if (!codeSnap || !codeSnap.exists()) {
      throw new Error('FARMER_NOT_FOUND');
    }
    const targetDir = codeSnap.data() as { uid: string; farmerCode: string; farmName: string; avatar: string };
    if (targetDir.uid === currentUser.uid) {
      throw new Error('CANNOT_ADD_SELF');
    }

    await this.syncFarmerProfile(myProfile);
    const reqId = `${currentUser.uid}_${targetDir.uid}`.slice(0, 128);
    const reqPath = `friendRequests/${reqId}`;
    try {
      await setDoc(doc(db, 'friendRequests', reqId), {
        fromUid: currentUser.uid,
        toUid: targetDir.uid,
        fromFarmerCode: sanitizeFarmerCode(myProfile.farmerCode),
        fromFarmName: clampStr(myProfile.farmName, 32, 'مزرعة السعادة'),
        fromAvatar: clampStr(myProfile.avatar, 12, '👨‍🌾'),
        fromCountry: clampStr(myProfile.country, 40, 'مصر'),
        fromGender: myProfile.gender === 'female' ? 'female' : 'male',
        fromLevel: Math.max(1, Math.min(999, Math.floor(Number(myProfile.level) || 1))),
        toFarmerCode: sanitizeFarmerCode(targetDir.farmerCode),
        toFarmName: clampStr(targetDir.farmName, 32, 'مزرعة صديق'),
        toAvatar: clampStr(targetDir.avatar, 12, '👨‍🌾'),
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, reqPath);
    }
    return targetDir;
  },
  async respondFriendRequest(requestId: string, status: 'accepted' | 'rejected') {
    if (!currentUser || !currentUser.emailVerified) throw new Error('NOT_SIGNED_IN');
    const reqPath = `friendRequests/${requestId}`;
    try {
      await updateDoc(doc(db, 'friendRequests', requestId), {
        status,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, reqPath);
    }
  },
  async sendCropGift(
    toUid: string,
    cropId: string,
    cropName: string,
    qty: number,
    myProfile: LocalProfilePayload
  ) {
    if (!currentUser || !currentUser.emailVerified) throw new Error('NOT_SIGNED_IN');
    const safeCropId = String(cropId || 'wheat').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32) || 'wheat';
    const safeQty = Math.max(1, Math.min(20, Math.floor(Number(qty) || 1)));
    const giftId = `gift_${currentUser.uid.slice(0, 12)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const giftPath = `cropGifts/${giftId}`;
    try {
      await setDoc(doc(db, 'cropGifts', giftId), {
        fromUid: currentUser.uid,
        toUid,
        fromFarmerCode: sanitizeFarmerCode(myProfile.farmerCode),
        fromFarmName: clampStr(myProfile.farmName, 32, 'مزرعة السعادة'),
        fromAvatar: clampStr(myProfile.avatar, 12, '👨‍🌾'),
        cropId: safeCropId,
        cropName: clampStr(cropName, 40, safeCropId),
        qty: safeQty,
        status: 'sent',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, giftPath);
    }
    return giftId;
  },
  async claimCropGift(giftId: string) {
    if (!currentUser || !currentUser.emailVerified) return;
    const giftPath = `cropGifts/${giftId}`;
    try {
      await updateDoc(doc(db, 'cropGifts', giftId), {
        status: 'claimed',
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, giftPath);
    }
  },
  async saveCloudSnapshot(state: {
    farmerCode: string;
    farmName: string;
    level: number;
    coins: number;
    dinars: number;
    unlockedSize: number;
    unlockedCrops: string[];
    barn: Record<string, number>;
  }) {
    if (!currentUser || !currentUser.emailVerified) return false;
    const uid = currentUser.uid;
    const savePath = `users/${uid}/saves/main`;
    const cleanBarn: Record<string, number> = {};
    Object.entries(state.barn || {}).slice(0, 80).forEach(([k, v]) => {
      if (typeof v === 'number' && v > 0) cleanBarn[k.slice(0, 32)] = Math.floor(v);
    });
    const cleanCrops = Array.isArray(state.unlockedCrops)
      ? state.unlockedCrops.slice(0, 60).map((c) => String(c).slice(0, 32))
      : [];
    try {
      await setDoc(doc(db, 'users', uid, 'saves', 'main'), {
        ownerId: uid,
        farmerCode: sanitizeFarmerCode(state.farmerCode),
        farmName: clampStr(state.farmName, 32, 'مزرعة السعادة'),
        level: Math.max(1, Math.min(999, Math.floor(Number(state.level) || 1))),
        coins: Math.max(0, Math.floor(Number(state.coins) || 0)),
        dinars: Math.max(0, Math.floor(Number(state.dinars) || 0)),
        unlockedSize: Math.max(6, Math.min(16, Math.floor(Number(state.unlockedSize) || 6))),
        unlockedCrops: cleanCrops,
        barn: cleanBarn,
        updatedAt: serverTimestamp(),
      });
      return true;
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, savePath);
    }
  },
  async loadCloudSnapshot() {
    if (!currentUser) return null;
    const uid = currentUser.uid;
    const savePath = `users/${uid}/saves/main`;
    try {
      const snap = await getDoc(doc(db, 'users', uid, 'saves', 'main'));
      return snap.exists() ? snap.data() : null;
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, savePath);
    }
  }
};

(window as unknown as { FarmFirebase: typeof FarmFirebase }).FarmFirebase = FarmFirebase;
window.dispatchEvent(new CustomEvent('farm-firebase-ready'));
