# Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. No PII (`email`, `phone`, `address`) is ever written to `farmers` or `farmerCodes`.
2. A user can only create or update their own `farmers/{uid}` and `farmerCodes/{farmerCode}` documents, and `farmerCode` is immutable once registered.
3. A `friendRequests/{requestId}` document cannot be created for oneself (`fromUid != toUid`), must start with `status == 'pending'`, must reference an existing recipient in `/farmers/{toUid}`, and only the recipient (`toUid`) may transition a `'pending'` request to `'accepted'` or `'rejected'`. Terminal states (`accepted`, `rejected`) are immutable.
4. A `cropGifts/{giftId}` document can only be created by `fromUid == request.auth.uid` for an existing recipient (`toUid != fromUid`), with `qty` bounded between `1` and `20`, starting in `status == 'sent'`. Only `toUid` can transition `'sent'` to `'claimed'`.
5. Private saves under `users/{userId}/saves/{saveId}` are strictly readable and writable only by `userId == request.auth.uid`.
6. Blanket `list` queries on `farmers` and `farmerCodes` are blocked (`allow list: if false`); `friendRequests` and `cropGifts` `list` queries require `resource.data.fromUid == request.auth.uid || resource.data.toUid == request.auth.uid`.

## 2. Dirty Dozen Attack Payloads
1. Unauthenticated read/write to `farmers/u1` -> `PERMISSION_DENIED`.
2. Shadow field injection (`isAdmin: true`) in `farmers/u1` -> `PERMISSION_DENIED`.
3. Spoofing `uid: "otherUser"` on `farmers/attacker` -> `PERMISSION_DENIED`.
4. Unverified email account attempting create/update on `farmers` -> `PERMISSION_DENIED`.
5. Oversized `farmName` (500 chars) on `farmers/u1` -> `PERMISSION_DENIED`.
6. Self-friend-request (`fromUid == toUid`) -> `PERMISSION_DENIED`.
7. Creating a `friendRequests` doc already set to `status: "accepted"` -> `PERMISSION_DENIED`.
8. Sender (`fromUid`) trying to accept their own pending `friendRequests` doc -> `PERMISSION_DENIED`.
9. Re-opening an already `rejected` friend request back to `pending` -> `PERMISSION_DENIED`.
10. Sending a `cropGifts` doc with `qty: 99999` or negative `qty: -5` -> `PERMISSION_DENIED`.
11. Unbounded `list` query on `cropGifts` without `toUid`/`fromUid` filter -> `PERMISSION_DENIED`.
12. Reading another user's private save `/users/victim/saves/main` -> `PERMISSION_DENIED`.
