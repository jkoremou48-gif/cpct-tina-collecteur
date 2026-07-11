// ==========================
// CPCT-TINA — App Collecteur
// ==========================
//
// ⚠️ HYPOTHÈSES / À VALIDER :
//  - Schéma aligné sur le PDG : collection "users" (role: 'collecteur'/'membre'/'pdg'),
//    "contracts" {membre_id, collecteur_id, statut:'actif'/'cloture', commission,
//    montant_mise, date_debut}, "payments" {contract_id, montant, jour_numero, date,
//    statut:'collecte'/'confirme'} — le champ statut sur payments est NOUVEAU (ajouté
//    ici pour le double solde), le PDG ne le lit pas encore (chantier "double solde"
//    côté PDG à faire séparément).
//  - "+ Nouveau membre" : le collecteur enregistre le 1er versement (jour 1 = commission)
//    sur place. Le membre créé a statut:'en_attente_validation' — CÔTÉ PDG IL FAUT UN
//    ÉCRAN POUR VALIDER CES MEMBRES (pas encore construit). Une fois validé, le PDG
//    génère un code MBR- envoyé au membre pour qu'il s'inscrive sur l'app Membre.
// ==========================

import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, orderBy, onSnapshot, serverTimestamp,
} from "./firebase-config.js";

import { genererCodeParrain, formatGNF, formatDate, notifier } from "./utils.js";

const state = {
  currentUser: null,
  currentCollecteurData: null,
  contracts: [],
  payments: [],
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
      soldeCollecteur: 0,
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
  state.unsubscribers.push(unsubContracts, unsubPayments);
}

function renderAll() {
  renderCollecteurHeader();
  renderMembersList();
}

// --- En-tête + double solde ---
function renderCollecteurHeader() {
  document.getElementById('collectorName').textContent = state.currentCollecteurData.nom || 'Collecteur';

  const commissionsJour1 = state.payments.filter((p) => p.jour_numero === 1);
  const confirmee = commissionsJour1.filter((p) => p.statut === 'confirme').reduce((s, p) => s + p.montant, 0);
  const attente = commissionsJour1.filter((p) => p.statut === 'collecte').reduce((s, p) => s + p.montant, 0);

  document.getElementById('collectorStats').textContent = `${state.contracts.length} contrat(s) actif(s)`;
  document.getElementById('commissionConfirmee').textContent = formatGNF(confirmee);
  document.getElementById('commissionAttente').textContent = formatGNF(attente);
}

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

    notifier('Versement enregistré (en attente de confirmation du PDG).', 'succes');
    afficherRecu({ nom: contrat.membre_nom, montant, jour: jourNumero, date: new Date() });
  } catch (err) {
    console.error(err);
    notifier('Erreur : ' + err.message, 'erreur');
  }
}

// --- Nouveau membre (onboarding sur place, 1er versement = commission) ---
document.getElementById('nouveauMembreBtn').addEventListener('click', () => {
  ouvrirModal(`
    <h2>Nouveau membre</h2>
    <p class="subtitle-sm">Enregistrez le 1er versement (commission) reçu sur place. Le PDG devra ensuite valider ce membre avant qu'il puisse s'inscrire sur l'app Membre.</p>
    <form id="form-nouveau-membre">
      <div class="field-row">
        <label>Nom complet du membre</label>
        <input type="text" name="nom" required />
      </div>
      <div class="field-row">
        <label>Téléphone</label>
        <input type="tel" name="telephone" required />
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
        <button type="submit" style="flex:1;">Enregistrer</button>
      </div>
    </form>
  `);
  document.getElementById('modal-annuler-membre').addEventListener('click', fermerModal);
  document.getElementById('form-nouveau-membre').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const nom = fd.get('nom').trim();
    const telephone = fd.get('telephone').trim();
    const montantJour = Number(fd.get('montantJour'));
    const commission = Number(fd.get('commission'));

    try {
      const membreEnAttenteRef = await addDoc(collection(db, 'membres_en_attente_validation'), {
        nom, telephone,
        montant_jour: montantJour,
        collecteur_id: state.currentCollecteurData.uid,
        statut: 'en_attente_validation',
        date_creation: serverTimestamp(),
      });

      const contratRef = await addDoc(collection(db, 'contracts'), {
        membre_id: null,
        membre_nom: nom,
        membre_en_attente_id: membreEnAttenteRef.id,
        collecteur_id: state.currentCollecteurData.uid,
        statut: 'actif',
        commission,
        montant_mise: montantJour,
        date_debut: new Date().toISOString(),
      });

      await addDoc(collection(db, 'payments'), {
        contract_id: contratRef.id,
        collecteur_id: state.currentCollecteurData.uid,
        membre_id: null,
        montant: commission,
        jour_numero: 1,
        statut: 'collecte',
        date: serverTimestamp(),
      });

      notifier('Membre enregistré. En attente de validation par le PDG.', 'succes');
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
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function fermerModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-content').innerHTML = '';
}
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') fermerModal();
});

demarrer();
