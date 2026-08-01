// ==========================
// CPCT-TINA — App Collecteur
// ==========================
//
// ⚠️ HYPOTHÈSES / À VALIDER :
//  - Le collecteur crée les comptes membres directement (autonomie totale,
//    plus de validation PDG). Connexion du membre par téléphone (email
//    technique généré en interne, jamais montré au membre).
//  - TC (Total Collecté) = somme de tous les paiements enregistrés par ce
//    collecteur (payments.collecteur_id === uid), tous statuts confondus.
//  - TV (Total Versé) = somme des versements de ce collecteur vers la caisse
//    de l'entreprise, enregistrés par le PDG (collection versements_collecteur).
//  - CC (vue collecteur) = 30% du TC — indicatif, pas encore reconnu par le PDG.
//  - Reste à verser = TC - TV.
// ==========================

import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, orderBy, onSnapshot, serverTimestamp,
  creerCompteSecondaire,
} from "./firebase-config.js";

import { genererCodeParrain, formatGNF, formatDate, notifier, calculerStatutContrat } from "./utils.js";

const TAUX_COMMISSION = 0.30;

const state = {
  currentUser: null,
  currentCollecteurData: null,
  contracts: [],
  payments: [],
  versements: [],
  withdrawalRequests: [],
  prets: [],
  remboursements: [],
  unsubscribers: [],
};
let creationEnCours = false;

const loading = document.getElementById('loading');
const screenInscription = document.getElementById('screen-inscription');
const loginScreen = document.getElementById('loginScreen');
const dashboard = document.getElementById('dashboard');
const loginError = document.getElementById('loginError');
const inscError = document.getElementById('inscError');

function showOnly(el) {
  [loading, screenInscription, loginScreen, dashboard].forEach((s) => {
    s.classList.toggle('hidden', s !== el);
  });
}

// --- Convertit un numéro de téléphone en "email technique" pour Firebase Auth ---
function telephoneVersEmailTechnique(telephone) {
  const chiffres = telephone.replace(/\D/g, "");
  return `${chiffres}@membre.cpct-tina.local`;
}

document.getElementById('voirInscriptionBtn').addEventListener('click', () => {
  showOnly(screenInscription);
});
document.getElementById('voirLoginBtn').addEventListener('click', () => {
  showOnly(loginScreen);
});

// --- Génère le mot de passe du membre à partir des 6 derniers chiffres du téléphone ---
function genererMotDePasseMembre(telephone) {
  const chiffres = telephone.replace(/\D/g, "");
  return chiffres.slice(-6);
}

// --- Démarrage ---
function demarrer() {
  showOnly(loading);
  onAuthStateChanged(auth, async (user) => {
    if (creationEnCours) return;
    if (user) {
      const userSnap = await getDoc(doc(db, 'users', user.uid));
      if (userSnap.exists() && userSnap.data().role === 'collecteur') {
        state.currentUser = user;
        state.currentCollecteurData = { uid: user.uid, ...userSnap.data() };
        lancerDashboard();
        return;
      } else {
        await signOut(auth);
      }
    }
    showOnly(loginScreen);
  });
}

// --- Inscription avec code COL- ---
document.getElementById('form-inscription').addEventListener('submit', async (e) => {
  e.preventDefault();
  inscError.textContent = '';
  const code = document.getElementById('inscCode').value.trim().toUpperCase();
  const nom = document.getElementById('inscNom').value.trim();
  const telephone = document.getElementById('inscTelephone').value.trim();
  const email = document.getElementById('inscEmail').value.trim();
  const password = document.getElementById('inscPassword').value;

  if (!code.startsWith('COL-')) {
    inscError.textContent = "Ce code ne correspond pas à un code collecteur (COL-...).";
    return;
  }

  creationEnCours = true;
  try {
    const codeRef = doc(db, 'codes_parrainage', code);
    const codeSnap = await getDoc(codeRef);

    if (!codeSnap.exists() || codeSnap.data().type !== 'collecteur' || codeSnap.data().actif !== true) {
      inscError.textContent = "Code invalide, déjà utilisé, ou expiré. Contactez votre PDG.";
      creationEnCours = false;
      return;
    }

    const pdgId = codeSnap.data().proprietaire_id;
    const codeParrain = genererCodeParrain('COL');

    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const userData = {
      role: 'collecteur',
      nom, telephone, email,
      code_parrain: codeParrain,
      parrain_id: pdgId,
      statut: 'actif',
      date_creation: serverTimestamp(),
    };
    await setDoc(doc(db, 'users', cred.user.uid), userData);
    await updateDoc(codeRef, { actif: false, utilise_par: cred.user.uid });

    notifier('Compte collecteur créé avec succès.', 'succes');
    state.currentUser = cred.user;
    state.currentCollecteurData = { uid: cred.user.uid, ...userData };
    creationEnCours = false;
    lancerDashboard();
  } catch (err) {
    notifier('Erreur : ' + err.message, 'erreur');
    if (auth.currentUser) {
      try { await auth.currentUser.delete(); } catch (e2) { /* ignore */ }
      try { await signOut(auth); } catch (e3) { /* ignore */ }
    }
    creationEnCours = false;
  }
});

// --- Connexion ---
document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  loginError.textContent = '';

  if (!email || !password) {
    loginError.textContent = 'Veuillez remplir tous les champs.';
    return;
  }
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    loginError.textContent = 'Email ou mot de passe incorrect.';
    console.error(err);
  }
});

// --- Déconnexion ---
document.getElementById('logoutBtn').addEventListener('click', async () => {
  state.unsubscribers.forEach((u) => u());
  state.unsubscribers = [];
  await signOut(auth);
  showOnly(loginScreen);
});

// --- Lancer le tableau de bord ---
function lancerDashboard() {
  showOnly(dashboard);
  renderCollecteurHeader();

  const unsubContracts = onSnapshot(
    query(collection(db, 'contracts'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.contracts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubPayments = onSnapshot(
    query(collection(db, 'payments'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.payments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubVersements = onSnapshot(
    query(collection(db, 'versements_collecteur'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.versements = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubPrets = onSnapshot(
    query(collection(db, 'prets'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.prets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubRemboursements = onSnapshot(collection(db, 'remboursements_prets'), (snap) => {
    state.remboursements = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  });
  state.unsubscribers.push(unsubContracts, unsubPayments, unsubVersements, unsubPrets, unsubRemboursements);
}

function renderAll() {
  renderCollecteurHeader();
  renderMembersList();
}

// --- En-tête + TC / TV / CC ---
function renderCollecteurHeader() {
  document.getElementById('collectorName').textContent = state.currentCollecteurData.nom || 'Collecteur';

  const TC = state.payments.reduce((s, p) => s + Number(p.montant || 0), 0);
  const TV = state.versements.reduce((s, v) => s + Number(v.montant || 0), 0);
  
  const resteAVerser = TC - TV;

  const versementsConfirmes = state.payments.filter((p) => p.statut === 'confirme');
  const versementsNonConfirmes = state.payments.filter((p) => p.statut !== 'confirme');
  const versementConfirmeTotal = versementsConfirmes.reduce((s, p) => s + Number(p.montant || 0), 0);
  const versementNonConfirmeTotal = versementsNonConfirmes.reduce((s, p) => s + Number(p.montant || 0), 0);

  const contratsConfirmes = state.contracts.filter((c) =>
    state.payments.some((p) => p.contract_id === c.id && p.jour_numero === 1 && p.statut === 'confirme')
  ).length;

  // Commission = uniquement le jour 1 (frais de compte), confirmé
  const commissionsConfirmees = versementsConfirmes.filter((p) => p.jour_numero === 1);
  const totalCommissionConfirmee = commissionsConfirmees.reduce((s, p) => s + Number(p.montant || 0), 0);
  const CC = totalCommissionConfirmee * TAUX_COMMISSION;

  // Épargne nette = versements confirmés hors jour 1 (le jour 1 est la commission, pas l'épargne du membre)
  const soldeTotalEpargnes = versementConfirmeTotal - totalCommissionConfirmee;

  const commissionsNonConfirmees = versementsNonConfirmes.filter((p) => p.jour_numero === 1);
  const totalCommissionNonConfirmee = commissionsNonConfirmees.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionEnAttente = totalCommissionNonConfirmee * TAUX_COMMISSION;

  document.getElementById('collectorStats').textContent = `${state.contracts.length} contrat(s) actif(s)`;
  document.getElementById('commissionConfirmee').textContent = formatGNF(CC);
  document.getElementById('commissionAttente').textContent = formatGNF(commissionEnAttente);

  let situationBloc = document.getElementById('situationGenerale');
  if (!situationBloc) {
    situationBloc = document.createElement('div');
    situationBloc.id = 'situationGenerale';
    situationBloc.innerHTML = `
      <div class="soldes-row"><span>Solde total des épargnes : <b id="soldeTotalEpargnes">0 GNF</b></span></div>
      <hr style="margin:10px 0; border:none; border-top:1px solid #eee;">
      <div class="soldes-row"><span>Contrats confirmés : <b id="nbContratsConfirmes">0</b></span></div>
      <div class="soldes-row"><span>Versement total confirmé : <b id="versementConfirme">0 GNF</b></span></div>
      <div class="soldes-row"><span>Versement non confirmé : <b id="versementNonConfirme">0 GNF</b></span></div>
      <div class="soldes-row"><span>Total collecté (TC) : <b id="soldeTC">0 GNF</b></span></div>
      <div class="soldes-row"><span>Commission réalisée (30%) : <b id="soldeCC">0 GNF</b></span></div>
    `;
    document.getElementById('commissionAttente').closest('.card').appendChild(situationBloc);
  }

  document.getElementById('soldeTotalEpargnes').textContent = formatGNF(soldeTotalEpargnes > 0 ? soldeTotalEpargnes : 0);
  document.getElementById('nbContratsConfirmes').textContent = contratsConfirmes;
  document.getElementById('versementConfirme').textContent = formatGNF(versementConfirmeTotal);
  document.getElementById('versementNonConfirme').textContent = formatGNF(versementNonConfirmeTotal);
  document.getElementById('soldeTC').textContent = formatGNF(TC);
  document.getElementById('soldeCC').textContent = formatGNF(CC);
  }

// --- Liste des membres (via leurs contrats) ---
// Affiche pour chaque membre son contrat le plus récent (actif OU clôturé).
// Un contrat clôturé affiche "Nouveau contrat" à la place d'"Encaisser".
function renderMembersList() {
  const container = document.getElementById('membersList');
  container.innerHTML = '';

  const versementsConfirmesTous = state.payments.filter((p) => p.statut === 'confirme');

  // Un membre peut avoir plusieurs contrats dans le temps : on ne garde que le plus récent par membre.
  const contratsParMembre = {};
  state.contracts
    .filter((c) => c.statut === 'actif' || c.statut === 'cloture')
    .forEach((c) => {
      const existant = contratsParMembre[c.membre_id];
      if (!existant || (c.date_debut || '') > (existant.date_debut || '')) {
        contratsParMembre[c.membre_id] = c;
      }
    });
  const contratsAffiches = Object.values(contratsParMembre);

  if (contratsAffiches.length === 0) {
    container.innerHTML = '<p style="color:#999;">Aucun membre assigné.</p>';
    return;
  }

  contratsAffiches.forEach((contrat) => {
    const versements = state.payments.filter((p) => p.contract_id === contrat.id);
    const joursPayes = versements.length;
    const estCloture = contrat.statut === 'cloture' || joursPayes >= 31;

    let statut = getStatutContrat(contrat, versements);
    if (!estCloture && calculerStatutContrat(contrat, versementsConfirmesTous) === 'inactif') {
      statut = { texte: 'Inactif', classe: 'late' };
    }
    const pret = (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === 'actif');

    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `
      <div>
        <strong style="cursor:pointer; text-decoration:underline;" data-membre="${contrat.membre_id}">${contrat.membre_nom || 'Membre'}</strong><br>
        <small>Jour ${joursPayes}/31</small>
        ${pret ? `<br><small style="color:#c0392b;">Prêt en cours : ${formatGNF(calculerMontantDuPret(pret))}</small>` : ''}
      </div>
      <div style="text-align:right;">
        <span class="badge ${statut.classe}">${statut.texte}</span><br>
        ${estCloture
          ? `<button style="margin-top:6px; width:auto; padding:6px 10px; font-size:13px; background:#198754;"
              data-nouveau-contrat="${contrat.membre_id}" data-nom="${contrat.membre_nom || 'Membre'}">Nouveau contrat</button>`
          : `<button style="margin-top:6px; width:auto; padding:6px 10px; font-size:13px;"
              data-contrat="${contrat.id}">Encaisser</button>`
        }
        ${pret ? `<button style="margin-top:6px; width:auto; padding:6px 10px; font-size:13px; background:#c0392b;"
          data-pret="${pret.id}">Rembourser prêt</button>` : ''}
