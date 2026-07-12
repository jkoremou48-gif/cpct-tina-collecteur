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

// --- Création d'un compte utilisateur SANS déconnecter le collecteur ---
// Même mécanisme que côté PDG : une application Firebase secondaire temporaire,
// isolée de la session principale, pour créer le compte du membre sur place.
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

export {
  auth,
  db,
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
};
