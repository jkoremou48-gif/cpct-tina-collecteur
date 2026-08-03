import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyCJkP6sOu-gbZwum8vQVqllFIHgrtUxQMc",
  authDomain: "cppct-tina.firebaseapp.com",
  projectId: "cppct-tina",
  storageBucket: "cppct-tina.firebasestorage.app",
  messagingSenderId: "525781235034",
  appId: "1:525781235034:web:d0e97fd3b391b57a22ef63",
};

const app = initializeApp(firebaseConfig, "collecteur");
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

async function creerCompteSecondaire(email, password) {
  const secondaryApp = initializeApp(firebaseConfig, "Secondary-" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    const uid = cred.user.uid;
    await signOut(secondaryAuth);
    await deleteApp(secondaryApp);
    return uid;
  } catch (err) {
    try { await deleteApp(secondaryApp); } catch (e2) { /* ignore */ }
    throw err;
  }
}

async function uploaderPhotoProfil(uid, file) {
  const chemin = `photos_profil/${uid}.jpg`;
  const storageRef = ref(storage, chemin);
  await uploadBytes(storageRef, file);
  return await getDownloadURL(storageRef);
}

export {
  auth,
  db,
  storage,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  creerCompteSecondaire,
  uploaderPhotoProfil,
};
