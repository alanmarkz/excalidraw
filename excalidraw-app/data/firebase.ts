import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
  IV_LENGTH_BYTES,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";
import type { UploadMetadata } from "firebase/storage";

// private
// -----------------------------------------------------------------------------

let FIREBASE_CONFIG: Record<string, any>;
try {
  FIREBASE_CONFIG = JSON.parse(import.meta.env.VITE_APP_FIREBASE_CONFIG);
} catch (error: any) {
  console.warn(
    `Error JSON parsing firebase config. Supplied value: ${
      import.meta.env.VITE_APP_FIREBASE_CONFIG
    }`,
  );
  FIREBASE_CONFIG = {};
}

const lazy = <T>(load: () => Promise<T>) => {
  let promise: Promise<T> | null = null;
  return () =>
    (promise ??= load().catch((error) => {
      promise = null;
      throw error;
    }));
};

const _initializeFirebase = lazy(async () => {
  const sdk = await import("./firebaseSDK");
  return { sdk, app: sdk.initializeApp(FIREBASE_CONFIG) };
});

// collab scenes and files are kept by the collaboration server
// (excalidraw-room) on its own disk instead of in Firebase
const STORAGE_URL = `${(import.meta.env.VITE_APP_WS_SERVER_URL || "").replace(
  /\/$/,
  "",
)}/api`;

const getStorageFileUrl = (prefix: string, id: FileId) =>
  `${STORAGE_URL}/${prefix.replace(/^\//, "")}/${id}`;

const _loadStorage = lazy(async () => {
  const { sdk, app } = await _initializeFirebase();
  const { getStorage, ref, uploadBytes } = sdk;
  return { storage: getStorage(app), ref, uploadBytes };
});

// -----------------------------------------------------------------------------

export const uploadBytesToFirebase = async (
  path: string,
  data: Blob | Uint8Array,
  metadata?: UploadMetadata,
) => {
  const { storage, ref, uploadBytes } = await _loadStorage();
  return uploadBytes(ref(storage, path), data, metadata);
};

/** the IV followed by the encrypted elements */
type StoredScene = Uint8Array<ArrayBuffer>;

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: StoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const iv = data.slice(0, IV_LENGTH_BYTES);
  const ciphertext = data.slice(IV_LENGTH_BYTES);

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      // an unreachable server must fail the whole save rather than be
      // reported per file as `erroredFiles` (which share links ignore, and
      // collab never retries)
      const response = await fetch(getStorageFileUrl(prefix, id), {
        method: "PUT",
        body: buffer as Uint8Array<ArrayBuffer>,
      });
      if (response.ok) {
        savedFiles.push(id);
      } else {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createStoredScene = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
): Promise<StoredScene> => {
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  const storedScene = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  storedScene.set(iv, 0);
  storedScene.set(new Uint8Array(ciphertext), iv.byteLength);
  return storedScene;
};

const fetchStoredScene = async (
  roomId: string,
): Promise<StoredScene | null> => {
  const response = await fetch(`${STORAGE_URL}/scenes/${roomId}`, {
    cache: "no-store",
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Couldn't load the scene (${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  const prevStoredScene = await fetchStoredScene(roomId);
  const reconciledElements = prevStoredScene
    ? getSyncableElements(
        reconcileElements(
          elements,
          getSyncableElements(
            restoreElements(
              await decryptElements(prevStoredScene, roomKey),
              null,
            ),
          ) as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      )
    : elements;

  const storedScene = await createStoredScene(reconciledElements, roomKey);
  const response = await fetch(`${STORAGE_URL}/scenes/${roomId}`, {
    method: "PUT",
    body: storedScene,
  });
  if (!response.ok) {
    throw new Error(
      response.status === 413
        ? "Scene is longer than the server allows (in bytes)"
        : `Couldn't save the scene (${response.status})`,
    );
  }

  // Return the stored elements as the in memory `reconciledElements` could have mutated in the meantime

  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const storedScene = await fetchStoredScene(roomId);
  if (!storedScene) {
    return null;
  }
  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(getStorageFileUrl(prefix, id));
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
