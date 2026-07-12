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

import { genererCodeParrain, formatGNF, formatDate, notifier } from "./utils.js";

const TAUX_COMMISSION = 0.30;

const state = {
  currentUser: null,
  currentCollecteurData: null,
  contracts: [],
  payments: [],
  versements: [],
  withdrawalRequests: [],
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

// --- Bascule inscription / connexion ---
document.getElementById('voirInscriptionBtn').addEventListener('click', () => {
  showOnly(screenInscription);
});
document.getElementById('voirLoginBtn').addEventListener('click', () => {
  showOnly(loginScreen);
});

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
  state.unsubscribers.push(unsubContracts, unsubPayments, unsubVersements);
}

function renderAll() {
  renderCollecteurHeader();
  renderMembersList();
}

// --- En-tête + TC / TV / CC ---
function renderCollecteurHeader() {
  document.getElementById('collectorName').textContent = state.currentCollecteurData.nom || 'Collecteur';

  const TC = state.payments.filter((p) => p.jour_numero === 1).reduce((s, p) => s + Number(p.montant || 0), 0);
  const TV = state.versements.reduce((s, v) => s + Number(v.montant || 0), 0);
  const CC = TC * TAUX_COMMISSION;
  const resteAVerser = TC - TV;

  document.getElementById('collectorStats').textContent = `${state.contracts.length} contrat(s) actif(s)`;
  document.getElementById('commissionConfirmee').textContent = formatGNF(TV);
  document.getElementById('commissionAttente').textContent = formatGNF(resteAVerser);

  let soldeTC = document.getElementById('soldeTC');
  if (!soldeTC) {
    const bloc = document.createElement('div');
    bloc.innerHTML = `
      <div class="soldes-row"><span>Total collecté (TC) : <b id="soldeTC">0 GNF</b></span></div>
      <div class="soldes-row"><span>Commission estimée (30% TC) : <b id="soldeCC">0 GNF</b></span></div>
    `;
    document.getElementById('commissionAttente').closest('.card').appendChild(bloc);
    soldeTC = document.getElementById('soldeTC');
  }
  soldeTC.textContent = formatGNF(TC);
  document.getElementById('soldeCC').textContent = formatGNF(CC);}

// --- Liste des membres (via leurs contrats) ---
function renderMembersList() {
  const container = document.getElementById('membersList');
  container.innerHTML = '';

  const contratsActifs = state.contracts.filter((c) => c.statut === 'actif');

  if (contratsActifs.length === 0) {
    container.innerHTML = '<p style="color:#999;">Aucun membre assigné.</p>';
    return;
  }

  contratsActifs.forEach((contrat) => {
    const versements = state.payments.filter((p) => p.contract_id === contrat.id);
    const joursPayes = versements.length;
    const statut = getStatutContrat(contrat, versements);

    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `
      <div>
        <strong>${contrat.membre_nom || 'Membre'}</strong><br>
        <small>Jour ${joursPayes}/31</small>
      </div>
      <div style="text-align:right;">
        <span class="badge ${statut.classe}">${statut.texte}</span><br>
        <button style="margin-top:6px; width:auto; padding:6px 10px; font-size:13px;"
          data-contrat="${contrat.id}">Encaisser</button>
      </div>
    `;
    row.querySelector('button').addEventListener('click', () => ouvrirPaiement(contrat.id));
    container.appendChild(row);
  });
}

function getStatutContrat(contrat, versements) {
  if (versements.length >= 31) return { texte: 'Terminé', classe: 'ok' };
  if (versements.length === 0) return { texte: 'À démarrer', classe: 'due' };

  const dernier = versements.reduce((a, b) => (a.jour_numero > b.jour_numero ? a : b));
  const dateVersement = dernier.date && dernier.date.toDate ? dernier.date.toDate() : null;
  if (!dateVersement) return { texte: 'À jour', classe: 'due' };

  const diffJours = Math.floor((new Date() - dateVersement) / (1000 * 60 * 60 * 24));
  if (diffJours >= 2) return { texte: 'En retard', classe: 'late' };
  if (diffJours >= 1) return { texte: 'À jour', classe: 'due' };
  return { texte: "Payé aujourd'hui", classe: 'ok' };
}

// --- Encaissement sur un contrat existant ---
function ouvrirPaiement(contratId) {
  const contrat = state.contracts.find((c) => c.id === contratId);
  if (!contrat) return;
  const versements = state.payments.filter((p) => p.contract_id === contratId);
  const prochainJour = versements.length + 1;

  const montant = prompt(`Montant reçu de ${contrat.membre_nom} (jour ${prochainJour}/31) :`);
  if (montant === null) return;
  const montantNum = parseFloat(montant);
  if (isNaN(montantNum) || montantNum <= 0) {
    notifier('Montant invalide.', 'erreur');
    return;
  }
  enregistrerVersement(contrat, montantNum, prochainJour);
}

async function enregistrerVersement(contrat, montant, jourNumero) {
  try {
    await addDoc(collection(db, 'payments'), {
      contract_id: contrat.id,
      collecteur_id: state.currentCollecteurData.uid,
      membre_id: contrat.membre_id,
      montant,
      jour_numero: jourNumero,
      statut: 'collecte',
      date: serverTimestamp(),
    });

    if (jourNumero >= 31) {
      await updateDoc(doc(db, 'contracts', contrat.id), { statut: 'cloture' });
    }

    notifier('Versement enregistré.', 'succes');
    afficherRecu({ nom: contrat.membre_nom, montant, jour: jourNumero, date: new Date() });
  } catch (err) {
    console.error(err);
    notifier('Erreur : ' + err.message, 'erreur');
  }
}

// --- Nouveau membre : création DIRECTE du compte (plus de validation PDG) ---
document.getElementById('nouveauMembreBtn').addEventListener('click', () => {
  ouvrirModal(`
    <h2>Nouveau membre</h2>
    <p class="subtitle-sm">Créez le compte du membre et enregistrez son 1er versement (commission). Il pourra se connecter avec son téléphone et le mot de passe ci-dessous.</p>
    <form id="form-nouveau-membre">
      <div class="field-row">
        <label>Nom complet du membre</label>
        <input type="text" name="nom" required />
      </div>
      <div class="field-row">
        <label>Téléphone (identifiant de connexion)</label>
        <input type="tel" name="telephone" required />
      </div>
      <div class="field-row">
        <label>Mot de passe à créer (6 caractères min)</label>
        <input type="text" name="password" minlength="6" required />
      </div>
      <div class="field-row">
        <label>Montant du versement quotidien (GNF)</label>
        <input type="number" name="montantJour" min="1" required />
      </div>
      <div class="field-row">
        <label>Commission encaissée aujourd'hui (jour 1, GNF)</label>
        <input type="number" name="commission" min="1" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" id="modal-annuler-membre" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Créer le compte</button>
      </div>
    </form>
  `);
  document.getElementById('modal-annuler-membre').addEventListener('click', fermerModal);
  document.getElementById('form-nouveau-membre').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const nom = fd.get('nom').trim();
    const telephone = fd.get('telephone').trim();
    const password = fd.get('password');
    const montantJour = Number(fd.get('montantJour'));
    const commission = Number(fd.get('commission'));

    try {
      const emailTechnique = telephoneVersEmailTechnique(telephone);
      const uid = await creerCompteSecondaire(emailTechnique, password);

      await setDoc(doc(db, 'users', uid), {
        role: 'membre',
        nom, telephone,
        parrain_id: state.currentCollecteurData.uid,
        statut: 'actif',
        date_creation: serverTimestamp(),
      });

      const contratRef = await addDoc(collection(db, 'contracts'), {
        membre_id: uid,
        membre_nom: nom,
        collecteur_id: state.currentCollecteurData.uid,
        statut: 'actif',
        commission,
        montant_mise: montantJour,
        date_debut: new Date().toISOString(),
      });

      await addDoc(collection(db, 'payments'), {
        contract_id: contratRef.id,
        collecteur_id: state.currentCollecteurData.uid,
        membre_id: uid,
        montant: commission,
        jour_numero: 1,
        statut: 'collecte',
        date: serverTimestamp(),
      });

      notifier(`Compte créé. Transmettez au membre : téléphone ${telephone} + le mot de passe choisi.`, 'succes');
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier('Erreur : ' + err.message, 'erreur');
    }
  });
});

// --- Reçu ---
function afficherRecu(data) {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', zIndex: 1000,
  });
  const recu = document.createElement('div');
  Object.assign(recu.style, {
    background: 'white', borderRadius: '12px', padding: '24px',
    width: '85%', maxWidth: '350px', textAlign: 'center',
  });
  recu.innerHTML = `
    <h2 style="color:#0d6efd;">CPCT-TINA</h2>
    <p style="color:#666; margin-bottom:12px;">Reçu d'encaissement</p>
    <hr>
    <p style="margin:12px 0;"><strong>${data.nom}</strong></p>
    <p style="font-size:22px; color:#198754; font-weight:bold;">${formatGNF(data.montant)}</p>
    <p>Jour ${data.jour} / 31</p>
    <p style="color:#999; font-size:13px; margin-top:12px;">
      ${data.date.toLocaleDateString('fr-FR')} à ${data.date.toLocaleTimeString('fr-FR')}
    </p>
    <hr>
    <p style="font-size:12px; color:#aaa;">Faites une capture d'écran de ce reçu</p>
    <button style="margin-top:16px;" id="fermer-recu">Fermer</button>
  `;
  overlay.appendChild(recu);
  document.body.appendChild(overlay);
  recu.querySelector('#fermer-recu').addEventListener('click', () => overlay.remove());
}

// --- Modal utilitaires ---
function ouvrirModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
}
function fermerModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('hidden');
  overlay.style.display = 'none';
  document.getElementById('modal-content').innerHTML = '';
}
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') fermerModal();
});

demarrer();
