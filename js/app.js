// ==========================
// CPCT-TINA — App Collecteur
// ==========================

import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, orderBy, onSnapshot, serverTimestamp,
  creerCompteSecondaire, uploaderPhotoProfil, changerMotDePasse,
} from "./firebase-config.js";

import {
  genererCodeParrain, formatGNF, formatDate, formatDateHeure, notifier,
  calculerStatutContrat, TYPES_CONTRAT, infoTypeContrat, calculerMontantDuPretGeneralise,
} from "./utils.js";

const TAUX_COMMISSION = 0.30; // journalier uniquement (jour 1)
const PART_INTERET_COLLECTEUR = 0.30; // journalier uniquement
const PART_INTERET_PDG = 0.70; // journalier uniquement
const TAUX_HEBDO_PRET = 0.02; // journalier uniquement
const TAUX_MENSUEL_PRET_DEFAUT = 0.08; // hebdo/mensuel, si le PDG n'a rien réglé
const AVATAR_DEFAUT = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><rect width='56' height='56' fill='%23ddd'/></svg>";

const state = {
  currentUser: null,
  currentCollecteurData: null,
  contracts: [],
  payments: [],
  versements: [],
  withdrawalRequests: [],
  prets: [],
  remboursements: [],
  interetsPartages: [],
  retraitsCommission: [],
  diffusionsCollecteur: [],
  mesMessagesPdg: [],
  fraisInscriptions: [],
  depenses: [],
  redistributions: [],
  parametresInterets: { pdg: 0.70, collecteur: 0.30, redistribution: 0 },
  // --- NOUVEAU (2 sept 2026) : reconductions de contrat à finaliser ---
  propositionsReconduction: [],
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

function genererMotDePasseMembre(telephone) {
  const chiffres = telephone.replace(/\D/g, "");
  return chiffres.slice(-6);
}

// ==========================================================
// --- CORRECTIF (3 sept 2026) : suppression de compte définitive ---
// Un collecteur marqué "supprime" ou "licencie" par le PDG (statut sur son
// document users/{uid}) ne doit plus jamais pouvoir accéder au dashboard,
// même si son compte Firebase Authentication reste techniquement valide
// (impossible à supprimer réellement sans Cloud Functions/plan payant).
// On bloque donc l'accès ici, à chaque connexion ET à chaque rechargement
// de l'app tant qu'une session existe.
// ==========================================================
function demarrer() {
  showOnly(loading);
  onAuthStateChanged(auth, async (user) => {
    if (creationEnCours) return;
    if (user) {
      const userSnap = await getDoc(doc(db, 'users', user.uid));
      if (userSnap.exists() && userSnap.data().role === 'collecteur') {
        const donneesCollecteur = userSnap.data();
        if (donneesCollecteur.statut === 'supprime' || donneesCollecteur.statut === 'licencie') {
          await signOut(auth);
          showOnly(loginScreen);
          loginError.textContent = "Ce compte a été supprimé ou n'est plus actif. Contactez votre PDG.";
          return;
        }
        state.currentUser = user;
        state.currentCollecteurData = { uid: user.uid, ...donneesCollecteur };
        lancerDashboard();
        return;
      } else {
        await signOut(auth);
      }
    }
    showOnly(loginScreen);
  });
}

document.getElementById('form-inscription').addEventListener('submit', async (e) => {
  e.preventDefault();
  inscError.textContent = '';
  const code = document.getElementById('inscCode').value.trim().toUpperCase();
  const nom = document.getElementById('inscNom').value.trim();
  const telephone = document.getElementById('inscTelephone').value.trim();
  const email = document.getElementById('inscEmail').value.trim();
  const residence = document.getElementById('inscResidence').value.trim();
  const prefecture = document.getElementById('inscPrefecture').value.trim();
  const sousPrefecture = document.getElementById('inscSousPrefecture').value.trim();
  const password = document.getElementById('inscPassword').value;

  if (!code.startsWith('COL-')) {
    inscError.textContent = "Ce code ne correspond pas à un code collecteur (COL-...).";
    return;
  }
  if (!prefecture) {
    inscError.textContent = "Veuillez choisir votre préfecture ou commune.";
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
      nom, telephone, email, residence,
      prefecture, sous_prefecture: sousPrefecture,
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

document.getElementById('logoutBtn').addEventListener('click', async () => {
  state.unsubscribers.forEach((u) => u());
  state.unsubscribers = [];
  await signOut(auth);
  showOnly(loginScreen);
});

document.getElementById('collecteur-avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !state.currentCollecteurData) return;
  try {
    const url = await uploaderPhotoProfil(state.currentCollecteurData.uid, file);
    await updateDoc(doc(db, 'users', state.currentCollecteurData.uid), { photoURL: url });
    state.currentCollecteurData.photoURL = url;
    document.getElementById('collecteur-avatar').src = url;
    notifier('Photo de profil mise à jour.', 'succes');
  } catch (err) {
    console.error(err);
    notifier("Erreur lors de l'envoi de la photo : " + err.message, 'erreur');
  }
});

function ajouterBoutonChangerMotDePasse() {
  if (document.getElementById('btn-changer-mdp')) return;
  const btnLogout = document.getElementById('logoutBtn');
  if (!btnLogout) return;
  btnLogout.insertAdjacentHTML(
    'beforebegin',
    `<button type="button" id="btn-changer-mdp" class="secondary" style="width:auto; margin-right:8px;">Changer mon mot de passe</button>`
  );
  document.getElementById('btn-changer-mdp').addEventListener('click', ouvrirChangementMotDePasse);
}

function ouvrirChangementMotDePasse() {
  ouvrirModal(`
    <h2>Changer mon mot de passe</h2>
    <p class="subtitle-sm">Confirmez votre mot de passe actuel puis saisissez le nouveau.</p>
    <form id="form-changer-mdp">
      <div class="field-row">
        <label>Mot de passe actuel</label>
        <input type="password" name="ancien" required />
      </div>
      <div class="field-row">
        <label>Nouveau mot de passe (6 caractères min)</label>
        <input type="password" name="nouveau" minlength="6" required />
      </div>
      <div class="field-row">
        <label>Confirmer le nouveau mot de passe</label>
        <input type="password" name="confirmation" minlength="6" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" id="modal-annuler-mdp" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Confirmer</button>
      </div>
    </form>
  `);
  document.getElementById('modal-annuler-mdp').addEventListener('click', fermerModal);
  document.getElementById('form-changer-mdp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ancien = fd.get('ancien');
    const nouveau = fd.get('nouveau');
    const confirmation = fd.get('confirmation');

    if (nouveau !== confirmation) {
      notifier('Les deux mots de passe ne correspondent pas.', 'erreur');
      return;
    }

    try {
      await changerMotDePasse(state.currentCollecteurData.email, ancien, nouveau);
      notifier('Mot de passe modifié avec succès.', 'succes');
      fermerModal();
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        notifier('Mot de passe actuel incorrect.', 'erreur');
      } else {
        notifier('Erreur : ' + err.message, 'erreur');
      }
    }
  });
}

function lancerDashboard() {
  showOnly(dashboard);
  document.getElementById('collecteur-avatar').src = state.currentCollecteurData.photoURL || AVATAR_DEFAUT;
  renderCollecteurHeader();
  ajouterBoutonChangerMotDePasse();

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
  const unsubRetraits = onSnapshot(
    query(
      collection(db, 'withdrawalRequests'),
      where('collecteur_id', '==', state.currentCollecteurData.uid),
      where('statut', '==', 'en_attente')
    ),
    (snap) => {
      state.withdrawalRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubInterets = onSnapshot(
    query(collection(db, 'interets_prets_repartis'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.interetsPartages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubRetraitsCommission = onSnapshot(
    query(
      collection(db, 'retraits_commission'),
      where('beneficiaire_role', '==', 'collecteur'),
      where('collecteur_id', '==', state.currentCollecteurData.uid)
    ),
    (snap) => {
      state.retraitsCommission = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubDiffusions = onSnapshot(
    query(collection(db, 'diffusions'), where('groupe_cible', '==', 'collecteurs')),
    (snap) => {
      state.diffusionsCollecteur = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubMesMessages = onSnapshot(
    query(collection(db, 'messages_prives'), where('participant_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.mesMessagesPdg = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  // --- NOUVEAU (25 août 2026) : types de contrats ---
  const unsubFraisInscription = onSnapshot(
    query(collection(db, 'frais_inscription'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.fraisInscriptions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubDepenses = onSnapshot(
    query(collection(db, 'depenses'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.depenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubRedistributions = onSnapshot(
    query(collection(db, 'redistributions_interets'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.redistributions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubParametres = onSnapshot(doc(db, 'parametres', 'interets_types_annuels'), (snap) => {
    if (snap.exists()) {
      const d = snap.data();
      state.parametresInterets = {
        pdg: Number(d.pdg ?? 0.70),
        collecteur: Number(d.collecteur ?? 0.30),
        redistribution: Number(d.redistribution ?? 0),
      };
    }
    renderAll();
  });
  // --- NOUVEAU (2 sept 2026) : reconductions de contrat à finaliser ---
  const unsubPropositions = onSnapshot(
    query(collection(db, 'propositions_reconduction'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.propositionsReconduction = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );

  state.unsubscribers.push(
    unsubContracts, unsubPayments, unsubVersements, unsubPrets, unsubRemboursements,
    unsubRetraits, unsubInterets, unsubRetraitsCommission, unsubDiffusions, unsubMesMessages,
    unsubFraisInscription, unsubDepenses, unsubRedistributions, unsubParametres, unsubPropositions
  );
}

function renderAll() {
  renderCollecteurHeader();
  renderRetraitsMembres();
  renderReconductionsATraiter();
  renderCommunicationCollecteur();
  renderMembersList();
}

// --- Correctif (23 août 2026) : le solde du membre compte tout versement
// NON ANNULÉ, immédiatement, sans attendre le verrouillage/confirmation du PDG.
function renderCollecteurHeader() {
  document.getElementById('collectorName').textContent = state.currentCollecteurData.nom || 'Collecteur';

  const TC = state.payments.reduce((s, p) => s + Number(p.montant || 0), 0);
  const TV = state.versements.reduce((s, v) => s + Number(v.montant || 0), 0);

  const versementsNonAnnules = state.payments.filter((p) => p.statut !== 'annule');
  const versementsConfirmes = state.payments.filter((p) => p.statut === 'confirme');
  const versementConfirmeTotal = versementsNonAnnules.reduce((s, p) => s + Number(p.montant || 0), 0);
  const versementNonConfirmeTotal = state.payments.filter((p) => p.statut === 'collecte').reduce((s, p) => s + Number(p.montant || 0), 0);

  const contratsJournaliers = state.contracts.filter((c) => (c.type_contrat || 'journalier') === 'journalier');
  const contratsConfirmes = contratsJournaliers.filter((c) =>
    state.payments.some((p) => p.contract_id === c.id && p.jour_numero === 1 && p.statut !== 'annule')
  ).length;

  const commissionsConfirmees = versementsConfirmes.filter((p) => p.jour_numero === 1);
  const totalCommissionConfirmee = commissionsConfirmees.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionInscriptions = totalCommissionConfirmee * TAUX_COMMISSION;

  // Frais d'inscription hebdo/mensuel (part collecteur), déjà calculée à la création
  const fraisInscriptionCollecteur = state.fraisInscriptions.reduce((s, f) => s + Number(f.montant_collecteur || 0), 0);

  const commissionInterets = state.interetsPartages.reduce((s, i) => s + Number(i.montant_collecteur || 0), 0);
  const CC = commissionInscriptions + fraisInscriptionCollecteur + commissionInterets;

  const soldeTotalEpargnes = state.contracts
    .filter((c) => c.statut === 'actif')
    .reduce((s, c) => s + Math.max(0, calculerEpargneNetteContrat(c)), 0);

  const commissionsNonConfirmees = state.payments.filter((p) => p.statut === 'collecte' && p.jour_numero === 1);
  const totalCommissionNonConfirmee = commissionsNonConfirmees.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionEnAttente = totalCommissionNonConfirmee * TAUX_COMMISSION;

  const retraitsCommissionConfirmes = state.retraitsCommission.filter((r) => r.statut === 'confirme');
  const retraitsCommissionEnAttente = state.retraitsCommission.filter((r) => r.statut === 'en_attente');
  const totalRetraitCommissionConfirme = retraitsCommissionConfirmes.reduce((s, r) => s + Number(r.montant || 0), 0);
  const totalRetraitCommissionEnAttente = retraitsCommissionEnAttente.reduce((s, r) => s + Number(r.montant || 0), 0);
  const commissionDisponibleRetrait = Math.max(0, CC - totalRetraitCommissionConfirme - totalRetraitCommissionEnAttente);

  document.getElementById('collectorStats').textContent = `${state.contracts.length} contrat(s)`;
  document.getElementById('commissionConfirmee').textContent = formatGNF(CC);
  document.getElementById('commissionAttente').textContent = formatGNF(commissionEnAttente);

  let situationBloc = document.getElementById('situationGenerale');
  if (!situationBloc) {
    situationBloc = document.createElement('div');
    situationBloc.id = 'situationGenerale';
    situationBloc.innerHTML = `
      <div class="soldes-row"><span>Solde total des épargnes (tous types) : <b id="soldeTotalEpargnes">0 GNF</b></span></div>
      <hr style="margin:10px 0; border:none; border-top:1px solid #eee;">
      <div class="soldes-row"><span>Contrats journaliers confirmés : <b id="nbContratsConfirmes">0</b></span></div>
      <div class="soldes-row"><span>Versement total comptabilisé : <b id="versementConfirme">0 GNF</b></span></div>
      <div class="soldes-row"><span>En attente de verrouillage (24h) : <b id="versementNonConfirme">0 GNF</b></span></div>
      <div class="soldes-row"><span>Total collecté (TC) : <b id="soldeTC">0 GNF</b></span></div>
      <div class="soldes-row"><span>Commission inscriptions journalier (30%, verrouillée) : <b id="soldeCommissionInscriptions">0 GNF</b></span></div>
      <div class="soldes-row"><span>Frais d'inscription hebdo/mensuel (ma part) : <b id="soldeFraisInscription">0 GNF</b></span></div>
      <div class="soldes-row"><span>Commission intérêts prêts : <b id="soldeCommissionInterets">0 GNF</b></span></div>
      <div class="soldes-row"><span>Commission réalisée (total) : <b id="soldeCC">0 GNF</b></span></div>
      <hr style="margin:10px 0; border:none; border-top:1px solid #eee;">
      <div class="soldes-row"><span>Déjà retiré : <b id="soldeRetraitCommissionConfirme">0 GNF</b></span></div>
      <div class="soldes-row"><span>Retrait en attente de validation PDG : <b id="soldeRetraitCommissionAttente">0 GNF</b></span></div>
      <div class="soldes-row"><span>Commission disponible au retrait : <b id="soldeCommissionDisponible">0 GNF</b></span></div>
      <button type="button" id="btn-demander-retrait-commission" style="margin-top:10px;">Demander le retrait de ma commission</button>
    `;
    document.getElementById('commissionAttente').closest('.card').appendChild(situationBloc);
    document.getElementById('btn-demander-retrait-commission').addEventListener('click', ouvrirDemandeRetraitCommission);
  }

  document.getElementById('soldeTotalEpargnes').textContent = formatGNF(soldeTotalEpargnes > 0 ? soldeTotalEpargnes : 0);
  document.getElementById('nbContratsConfirmes').textContent = contratsConfirmes;
  document.getElementById('versementConfirme').textContent = formatGNF(versementConfirmeTotal);
  document.getElementById('versementNonConfirme').textContent = formatGNF(versementNonConfirmeTotal);
  document.getElementById('soldeTC').textContent = formatGNF(TC);
  document.getElementById('soldeCommissionInscriptions').textContent = formatGNF(commissionInscriptions);
  document.getElementById('soldeFraisInscription').textContent = formatGNF(fraisInscriptionCollecteur);
  document.getElementById('soldeCommissionInterets').textContent = formatGNF(commissionInterets);
  document.getElementById('soldeCC').textContent = formatGNF(CC);
  document.getElementById('soldeRetraitCommissionConfirme').textContent = formatGNF(totalRetraitCommissionConfirme);
  document.getElementById('soldeRetraitCommissionAttente').textContent = formatGNF(totalRetraitCommissionEnAttente);
  document.getElementById('soldeCommissionDisponible').textContent = formatGNF(commissionDisponibleRetrait);

  const btnRetrait = document.getElementById('btn-demander-retrait-commission');
  if (btnRetrait) {
    btnRetrait.disabled = commissionDisponibleRetrait <= 0;
    btnRetrait.dataset.disponible = commissionDisponibleRetrait;
  }
}

function ouvrirDemandeRetraitCommission() {
  const disponible = Number(document.getElementById('btn-demander-retrait-commission').dataset.disponible || 0);
  if (disponible <= 0) {
    notifier('Aucune commission disponible pour un retrait actuellement.', 'erreur');
    return;
  }
  ouvrirModal(`
    <h2>Demander le retrait de ma commission</h2>
    <p class="subtitle-sm">Commission disponible : <b>${formatGNF(disponible)}</b>. Cette demande sera envoyée au PDG pour validation.</p>
    <form id="form-retrait-commission">
      <div class="field-row">
        <label>Montant à retirer (GNF)</label>
        <input type="number" name="montant" min="1" max="${disponible}" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" id="modal-annuler-retrait-commission" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Envoyer la demande</button>
      </div>
    </form>
  `);
  document.getElementById('modal-annuler-retrait-commission').addEventListener('click', fermerModal);
  document.getElementById('form-retrait-commission').addEventListener('submit', async (e) => {
    e.preventDefault();
    const montant = Number(new FormData(e.target).get('montant'));
    if (montant > disponible) {
      notifier('Montant supérieur à la commission disponible.', 'erreur');
      return;
    }
    try {
      await addDoc(collection(db, 'retraits_commission'), {
        beneficiaire_role: 'collecteur',
        collecteur_id: state.currentCollecteurData.uid,
        collecteur_nom: state.currentCollecteurData.nom,
        montant,
        statut: 'en_attente',
        date: serverTimestamp(),
      });
      notifier('Demande de retrait envoyée au PDG.', 'succes');
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier('Erreur : ' + err.message, 'erreur');
    }
  });
}

function libelleTypeRetrait(type) {
  const labels = {
    pret: 'Prêt',
    solde_contrat_termine: "Solde de contrat terminé",
    retrait_final: 'Retrait final (clôture du contrat)',
  };
  return labels[type] || 'Retrait';
}

function renderRetraitsMembres() {
  const container = document.getElementById('retraitsList');
  if (!container) return;

  if (state.withdrawalRequests.length === 0) {
    container.innerHTML = '<p style="color:#999; font-size:13px;">Aucune demande en attente.</p>';
    return;
  }

  container.innerHTML = '';
  state.withdrawalRequests
    .slice()
    .sort((a, b) => (b.dateCreation?.toMillis?.() || 0) - (a.dateCreation?.toMillis?.() || 0))
    .forEach((r) => {
      const row = document.createElement('div');
      row.className = 'retrait-row';
      row.innerHTML = `
        <div class="retrait-row-top">
          <div>
            <strong>${r.memberName || 'Membre'}</strong><br>
            <small>${libelleTypeRetrait(r.type)}</small><br>
            <small style="color:#999;">${formatDateHeure(r.dateCreation)}</small>
          </div>
          <span class="badge attente">${formatGNF(r.montant)}</span>
        </div>
        <div class="retrait-actions">
          <button type="button" class="secondary" data-action="rejeter" data-id="${r.id}">Rejeter</button>
          <button type="button" data-action="confirmer" data-id="${r.id}">Confirmer</button>
        </div>
      `;
      row.querySelector('[data-action="confirmer"]').addEventListener('click', () => confirmerRetraitMembre(r));
      row.querySelector('[data-action="rejeter"]').addEventListener('click', () => rejeterRetraitMembre(r));
      container.appendChild(row);
    });
}

// ==========================================================
// --- NOUVEAU (2 sept 2026) : reconductions de contrat à finaliser ---
// Après un retrait_final confirmé (Cas 4, clôture), une proposition de
// reconduction est créée pour le membre. Une fois qu'il a répondu
// ("reconduit_meme_termes" ou "reconduit_modifie"), elle apparaît ici pour
// que le collecteur crée réellement le nouveau contrat + le versement jour 1
// au moment où il encaisse la 1ère cotisation en personne.
// ==========================================================

function renderReconductionsATraiter() {
  const enAttenteTraitement = state.propositionsReconduction.filter(
    (p) => p.statut === 'reconduit_meme_termes' || p.statut === 'reconduit_modifie'
  );

  let zone = document.getElementById('reconductionsZone');
  if (!zone) {
    zone = document.createElement('div');
    zone.id = 'reconductionsZone';
    zone.className = 'card';
    zone.style.marginBottom = '14px';
    const retraitsListEl = document.getElementById('retraitsList');
    if (retraitsListEl && retraitsListEl.parentElement) {
      retraitsListEl.parentElement.insertAdjacentElement('beforebegin', zone);
    } else {
      dashboard.prepend(zone);
    }
  }

  if (enAttenteTraitement.length === 0) {
    zone.innerHTML = '';
    return;
  }

  zone.innerHTML = `
    <h3 style="font-size:14px; margin-bottom:8px;">Reconductions de contrat à finaliser</h3>
    <p style="color:#666; font-size:12px; margin-bottom:10px;">Le membre a accepté de reconduire son épargne. Créez le nouveau contrat au moment où vous encaissez son 1er versement.</p>
    ${enAttenteTraitement.map((p) => {
      const infoType = infoTypeContrat(p.type_contrat_precedent || 'journalier');
      const montantAffiche = p.statut === 'reconduit_modifie' ? p.nouveau_montant_mise : p.montant_mise_precedent;
      const libelleModif = p.statut === 'reconduit_modifie' ? ' (montant modifié demandé)' : ' (mêmes conditions)';
      return `
        <div class="retrait-row">
          <div class="retrait-row-top">
            <div>
              <strong>${p.membre_nom || 'Membre'}</strong><br>
              <small>${infoType.label}${libelleModif}</small><br>
              <small style="color:#999;">${infoType.labelVersement} suggéré : ${formatGNF(montantAffiche)}</small>
            </div>
          </div>
          <div class="retrait-actions">
            <button type="button" data-action="finaliser-reconduction" data-id="${p.id}">Encaisser le 1er versement / Créer le contrat</button>
          </div>
        </div>
      `;
    }).join('')}
  `;

  zone.querySelectorAll('[data-action="finaliser-reconduction"]').forEach((btn) => {
    btn.addEventListener('click', () => ouvrirFinalisationReconduction(btn.dataset.id));
  });
}

function ouvrirFinalisationReconduction(propositionId) {
  const proposition = state.propositionsReconduction.find((p) => p.id === propositionId);
  if (!proposition) return;

  const typeContrat = proposition.type_contrat_precedent || 'journalier';
  const montantPeriodeSuggere = proposition.statut === 'reconduit_modifie'
    ? proposition.nouveau_montant_mise
    : proposition.montant_mise_precedent;
  const infoType = infoTypeContrat(typeContrat);
  const estJournalier = typeContrat === 'journalier';

  ouvrirModal(`
    <h2>Nouveau contrat (reconduction) — ${proposition.membre_nom}</h2>
    <p class="subtitle-sm">Type de contrat reconduit : <b>${infoType.label}</b>. Ceci crée réellement le nouveau contrat au moment de l'encaissement.</p>
    <form id="form-finaliser-reconduction">
      <div class="field-row">
        <label>Montant du ${infoType.labelVersement} (GNF)</label>
        <input type="number" name="montantPeriode" min="1" value="${montantPeriodeSuggere || ''}" required />
      </div>
      <div class="field-row" id="champ-commission-fr" style="${estJournalier ? '' : 'display:none;'}">
        <label>Commission encaissée aujourd'hui (jour 1, GNF)</label>
        <input type="number" name="commission" min="1" ${estJournalier ? 'required' : ''} />
      </div>
      <div class="field-row" id="champ-frais-inscription-fr" style="${estJournalier ? 'display:none;' : ''}">
        <label>Frais d'inscription (GNF)</label>
        <input type="number" name="fraisInscription" min="0" />
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" id="modal-annuler-reconduction" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Créer le contrat</button>
      </div>
    </form>
  `);
  document.getElementById('modal-annuler-reconduction').addEventListener('click', fermerModal);
  document.getElementById('form-finaliser-reconduction').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const montantPeriode = Number(fd.get('montantPeriode'));
    const commission = Number(fd.get('commission') || 0);
    const fraisInscription = Number(fd.get('fraisInscription') || 0);

    try {
      const contratRef = await creerContratEtPremierePeriode({
        membreId: proposition.membre_id,
        membreNom: proposition.membre_nom,
        typeContrat,
        montantPeriode,
        commission,
        fraisInscription,
      });

      await updateDoc(doc(db, 'propositions_reconduction', proposition.id), {
        statut: 'traite',
        nouveau_contrat_id: contratRef.id,
        date_traitement: serverTimestamp(),
      });

      notifier('Nouveau contrat créé et proposition finalisée.', 'succes');
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier('Erreur : ' + err.message, 'erreur');
    }
  });
}

async function confirmerRetraitMembre(demande) {
  try {
    if (demande.type === 'solde_contrat_termine' && demande.contractId) {
      await updateDoc(doc(db, 'contracts', demande.contractId), { epargne_soldee: true });
    } else if (demande.type === 'retrait_final' && demande.contractId) {
      await updateDoc(doc(db, 'contracts', demande.contractId), {
        statut: 'cloture',
        epargne_soldee: true,
      });
      // --- NOUVEAU (2 sept 2026) : création de la proposition de reconduction ---
      // Manquait jusqu'ici — sans ce document, le membre ne voyait jamais la
      // proposition "voulez-vous reconduire ?" et aucun renouvellement n'était possible.
      const contratCloture = state.contracts.find((c) => c.id === demande.contractId);
      await addDoc(collection(db, 'propositions_reconduction'), {
        membre_id: demande.memberId,
        membre_nom: demande.memberName || (contratCloture ? contratCloture.membre_nom : ''),
        collecteur_id: state.currentCollecteurData.uid,
        contrat_precedent_id: demande.contractId,
        type_contrat_precedent: contratCloture ? (contratCloture.type_contrat || 'journalier') : 'journalier',
        montant_mise_precedent: contratCloture ? contratCloture.montant_mise : null,
        statut: 'en_attente',
        date: serverTimestamp(),
      });
    } else if (demande.type === 'pret') {
      const contratOrigine = state.contracts.find((c) => c.id === demande.contractId);
      const typeContrat = contratOrigine ? (contratOrigine.type_contrat || 'journalier') : 'journalier';
      const pretData = {
        contract_id: demande.contractId || null,
        membre_id: demande.memberId,
        collecteur_id: state.currentCollecteurData.uid,
        montant_initial: demande.montant,
        type_contrat: typeContrat,
        interet_deja_reconnu: 0,
        statut: 'actif',
        date_debut: serverTimestamp(),
      };
      if (typeContrat === 'hebdomadaire' || typeContrat === 'mensuel') {
        pretData.taux_mensuel = TAUX_MENSUEL_PRET_DEFAUT;
      } else {
        pretData.taux_hebdo = TAUX_HEBDO_PRET;
      }
      await addDoc(collection(db, 'prets'), pretData);
    }

    await updateDoc(doc(db, 'withdrawalRequests', demande.id), {
      statut: 'confirme',
      date_confirmation: serverTimestamp(),
      confirme_par: state.currentCollecteurData.uid,
    });

    notifier('Demande confirmée.', 'succes');
  } catch (err) {
    console.error(err);
    notifier('Erreur : ' + err.message, 'erreur');
  }
}

async function rejeterRetraitMembre(demande) {
  try {
    await updateDoc(doc(db, 'withdrawalRequests', demande.id), {
      statut: 'refuse',
      date_refus: serverTimestamp(),
      refuse_par: state.currentCollecteurData.uid,
    });
    notifier('Demande rejetée.', 'succes');
  } catch (err) {
    console.error(err);
    notifier('Erreur : ' + err.message, 'erreur');
  }
}

function renderCommunicationCollecteur() {
  renderDiffusionsCollecteur();
  renderFilPdg();
}

function renderDiffusionsCollecteur() {
  const container = document.getElementById('diffusionsCollecteurList');
  if (!container) return;

  const diffusionsTriees = [...state.diffusionsCollecteur].sort(
    (a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0)
  );

  if (diffusionsTriees.length === 0) {
    container.innerHTML = '<p style="color:#999; font-size:13px;">Aucun message du PDG pour le moment.</p>';
    return;
  }

  container.innerHTML = diffusionsTriees.slice(0, 10).map((d) => `
    <div style="background:#f4f6f8; border-radius:8px; padding:10px; margin-bottom:8px;">
      <p style="font-size:13px;">${d.contenu}</p>
      <p style="font-size:11px; color:#999; margin-top:4px;">${formatDateHeure(d.date)}</p>
    </div>
  `).join('');
}

function renderFilPdg() {
  const container = document.getElementById('filPdgMessages');
  const badge = document.getElementById('badgeMessagesNonLus');
  if (!container) return;

  const messages = [...state.mesMessagesPdg].sort(
    (a, b) => (a.date?.toMillis?.() || 0) - (b.date?.toMillis?.() || 0)
  );

  if (messages.length === 0) {
    container.innerHTML = '<p style="color:#999; font-size:13px;">Aucun échange pour le moment. Écrivez au PDG ci-dessous.</p>';
  } else {
    container.innerHTML = messages.map((m) => `
      <div style="align-self:${m.expediteur_role === 'collecteur' ? 'flex-end' : 'flex-start'}; background:${m.expediteur_role === 'collecteur' ? '#0d6efd' : '#f0f0f0'}; color:${m.expediteur_role === 'collecteur' ? 'white' : '#222'}; border-radius:10px; padding:8px 12px; max-width:80%;">
        <p style="font-size:14px;">${m.contenu}</p>
        <p style="font-size:11px; opacity:0.7; margin-top:4px;">${formatDateHeure(m.date)}</p>
      </div>
    `).join('');
    container.scrollTop = container.scrollHeight;
  }

  const nonLus = messages.filter((m) => m.expediteur_role === 'pdg' && m.lu_participant === false);
  if (badge) {
    if (nonLus.length > 0) {
      badge.textContent = nonLus.length;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  nonLus.forEach(async (m) => {
    try {
      await updateDoc(doc(db, 'messages_prives', m.id), { lu_participant: true });
    } catch (err) {
      console.error(err);
    }
  });
}

document.getElementById('form-message-pdg').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const contenu = fd.get('contenu').trim();
  if (!contenu) return;

  try {
    await addDoc(collection(db, 'messages_prives'), {
      participant_id: state.currentCollecteurData.uid,
      participant_nom: state.currentCollecteurData.nom,
      participant_role: 'collecteur',
      expediteur_id: state.currentCollecteurData.uid,
      expediteur_role: 'collecteur',
      contenu,
      date: serverTimestamp(),
      lu_pdg: false,
      lu_participant: true,
    });
    e.target.reset();
  } catch (err) {
    console.error(err);
    notifier('Erreur : ' + err.message, 'erreur');
  }
});

// ==========================================================
// --- NOUVEAU (25 août 2026) : calculs généralisés par type de contrat ---
// Journalier : jour_numero === 1 est la commission (exclue de l'épargne nette).
// Hebdomadaire / Mensuel : pas de "jour 1 = frais" — tous les versements
// périodiques comptent en épargne nette ; le frais d'inscription est un
// document séparé (collection frais_inscription), pas un versement.
// Les dépenses non compensées diminuent l'épargne nette ; les redistributions
// reçues l'augmentent.
// ==========================================================

function calculerEpargneNetteContrat(contrat) {
  const typeContrat = contrat.type_contrat || 'journalier';
  const versements = state.payments.filter((p) => p.contract_id === contrat.id && p.statut !== 'annule');

  let epargne;
  if (typeContrat === 'journalier') {
    epargne = versements.filter((p) => p.jour_numero !== 1).reduce((s, p) => s + Number(p.montant || 0), 0);
  } else {
    epargne = versements.reduce((s, p) => s + Number(p.montant || 0), 0);
    const depensesNonCompensees = state.depenses
      .filter((d) => d.contract_id === contrat.id && !d.compensee)
      .reduce((s, d) => s + Number(d.montant || 0), 0);
    const redistributionsRecues = state.redistributions
      .filter((r) => r.contract_id === contrat.id)
      .reduce((s, r) => s + Number(r.montant || 0), 0);
    epargne = epargne - depensesNonCompensees + redistributionsRecues;
  }
  return epargne;
}

function nbSemainesEntamees(pret) {
  const dateDebut = pret.date_debut && pret.date_debut.toDate ? pret.date_debut.toDate() : new Date();
  return Math.floor((new Date() - dateDebut) / (1000 * 60 * 60 * 24 * 7)) + 1;
}

function calculerMontantDuPret(pret) {
  return calculerMontantDuPretGeneralise(pret, state.remboursements);
}

function calculerSoldeDisponible(contrat) {
  const epargneNette = calculerEpargneNetteContrat(contrat);
  const pret = (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === 'actif');
  const pretDu = pret ? calculerMontantDuPret(pret) : 0;
  return Math.max(0, epargneNette - pretDu);
}

function trouverContratsNonSoldes(membreId, contratExclureId) {
  return state.contracts.filter((c) =>
    c.membre_id === membreId &&
    c.statut === 'cloture' &&
    c.id !== contratExclureId &&
    !c.epargne_soldee
  );
}

function renderMembersList() {
  const container = document.getElementById('membersList');
  container.innerHTML = '';

  const versementsConfirmesTous = state.payments.filter((p) => p.statut !== 'annule');

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
    const typeContrat = contrat.type_contrat || 'journalier';
    const infoType = infoTypeContrat(typeContrat);
    const versements = state.payments.filter((p) => p.contract_id === contrat.id);
    const periodesPayees = versements.filter((v) => v.statut !== 'annule').length;
    const dureeTotale = contrat.duree_totale || infoType.duree;
    const estCloture = contrat.statut === 'cloture' || periodesPayees >= dureeTotale;

    let statut = getStatutContrat(contrat, versements);
    if (!estCloture && calculerStatutContrat(contrat, versementsConfirmesTous) === 'inactif') {
      statut = { texte: 'Inactif', classe: 'late' };
    }
    const pret = (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === 'actif');
    const soldeDisponible = calculerSoldeDisponible(contrat);

    const contratsNonSoldes = trouverContratsNonSoldes(contrat.membre_id, contrat.id);
    const totalNonSolde = contratsNonSoldes.reduce((s, c) => s + Math.max(0, calculerEpargneNetteContrat(c)), 0);

    const depensesNonCompensees = state.depenses.filter((d) => d.contract_id === contrat.id && !d.compensee);
    const totalDepensesNonCompensees = depensesNonCompensees.reduce((s, d) => s + Number(d.montant || 0), 0);

    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `
      <div>
        <strong style="cursor:pointer; text-decoration:underline;" data-membre="${contrat.membre_id}">${contrat.membre_nom || 'Membre'}</strong>
        <span class="badge" style="background:#e9ecef; color:#333; margin-left:6px;">${infoType.label}</span><br>
        <small>${infoType.labelPeriode.charAt(0).toUpperCase() + infoType.labelPeriode.slice(1)} ${periodesPayees}/${dureeTotale}</small>
        ${pret ? `<br><small style="color:#c0392b;">Prêt en cours : ${formatGNF(calculerMontantDuPret(pret))} · Solde disponible : ${formatGNF(soldeDisponible)}</small>` : ''}
        ${totalNonSolde > 0 ? `<br><small style="color:#c0392b; font-weight:bold;">Contrat non soldé : ${formatGNF(totalNonSolde)}</small>` : ''}
        ${totalDepensesNonCompensees > 0 ? `<br><small style="color:#e67e22; font-weight:bold;">Dépenses non compensées : ${formatGNF(totalDepensesNonCompensees)}</small>` : ''}
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
        ${(typeContrat === 'hebdomadaire' || typeContrat === 'mensuel') && !estCloture ? `<button style="margin-top:6px; width:auto; padding:6px 10px; font-size:13px; background:#e67e22;"
          data-depense="${contrat.id}" data-nom="${contrat.membre_nom || 'Membre'}">+ Dépense</button>` : ''}
        ${totalDepensesNonCompensees > 0 ? `<button style="margin-top:6px; width:auto; padding:6px 10px; font-size:13px; background:#2980b9;"
          data-compenser="${contrat.id}" data-total="${totalDepensesNonCompensees}" data-nom="${contrat.membre_nom || 'Membre'}">Compenser les dépenses</button>` : ''}
      </div>
    `;
    const btnEncaisser = row.querySelector('button[data-contrat]');
    if (btnEncaisser) {
      btnEncaisser.addEventListener('click', () => ouvrirPaiement(contrat.id));
    }
    const btnNouveauContrat = row.querySelector('button[data-nouveau-contrat]');
    if (btnNouveauContrat) {
      btnNouveauContrat.addEventListener('click', () => ouvrirNouveauContrat(contrat.membre_id, contrat.membre_nom));
    }
    row.querySelector('strong').addEventListener('click', () => afficherDetailsMembre(contrat));
    const btnRembourser = row.querySelector('button[data-pret]');
    if (btnRembourser) {
      btnRembourser.addEventListener('click', () => ouvrirRemboursementPret(pret.id));
    }
    const btnDepense = row.querySelector('button[data-depense]');
    if (btnDepense) {
      btnDepense.addEventListener('click', () => ouvrirNouvelleDepense(contrat));
    }
    const btnCompenser = row.querySelector('button[data-compenser]');
    if (btnCompenser) {
      btnCompenser.addEventListener('click', () => ouvrirCompensationDepenses(contrat, totalDepensesNonCompensees, depensesNonCompensees));
    }
    container.appendChild(row);
  });
}

function getStatutContrat(contrat, versements) {
  const typeContrat = contrat.type_contrat || 'journalier';
  const infoType = infoTypeContrat(typeContrat);
  const dureeTotale = contrat.duree_totale || infoType.duree;
  const versementsNonAnnules = versements.filter((v) => v.statut !== 'annule');
  if (versementsNonAnnules.length >= dureeTotale) return { texte: 'Terminé', classe: 'ok' };
  if (versementsNonAnnules.length === 0) return { texte: 'À démarrer', classe: 'due' };

  const dernier = versementsNonAnnules.reduce((a, b) => (a.jour_numero > b.jour_numero ? a : b));
  const dateVersement = dernier.date && dernier.date.toDate ? dernier.date.toDate() : null;
  if (!dateVersement) return { texte: 'À jour', classe: 'due' };

  const diffJours = Math.floor((new Date() - dateVersement) / (1000 * 60 * 60 * 24));
  if (diffJours >= 2) return { texte: 'En retard', classe: 'late' };
  if (diffJours >= 1) return { texte: 'À jour', classe: 'due' };
  return { texte: "Payé aujourd'hui", classe: 'ok' };
}

function ouvrirPaiement(contratId) {
  const contrat = state.contracts.find((c) => c.id === contratId);
  if (!contrat) return;
  const typeContrat = contrat.type_contrat || 'journalier';
  const infoType = infoTypeContrat(typeContrat);
  const dureeTotale = contrat.duree_totale || infoType.duree;
  const versements = state.payments.filter((p) => p.contract_id === contratId && p.statut !== 'annule');
  const prochainePeriode = versements.length + 1;
  const periodesRestantes = dureeTotale - versements.length;

  if (periodesRestantes <= 0) {
    notifier(`Ce contrat a déjà atteint ${dureeTotale} ${infoType.labelPeriode}(s). Démarrez un nouveau contrat.`, 'erreur');
    return;
  }

  const montant = prompt(`Montant reçu de ${contrat.membre_nom} (${infoType.labelVersement} : ${formatGNF(contrat.montant_mise)}, à partir de la période ${prochainePeriode}/${dureeTotale}) :`);
  if (montant === null) return;
  const montantNum = parseFloat(montant);
  if (isNaN(montantNum) || montantNum <= 0) {
    notifier('Montant invalide.', 'erreur');
    return;
  }
  enregistrerVersement(contrat, montantNum, prochainePeriode, periodesRestantes);
}

async function enregistrerVersement(contrat, montantSaisi, periodeDepart, periodesRestantes) {
  try {
    const montantPeriode = Number(contrat.montant_mise) || montantSaisi;
    const periodesCouvertes = Math.max(1, Math.min(Math.round(montantSaisi / montantPeriode), periodesRestantes));
    const montantAccepte = periodesCouvertes * montantPeriode;
    const montantExcedent = montantSaisi - montantAccepte;
    const typeContrat = contrat.type_contrat || 'journalier';
    const infoType = infoTypeContrat(typeContrat);
    const dureeTotale = contrat.duree_totale || infoType.duree;

    for (let i = 0; i < periodesCouvertes; i++) {
      await addDoc(collection(db, 'payments'), {
        contract_id: contrat.id,
        collecteur_id: state.currentCollecteurData.uid,
        membre_id: contrat.membre_id,
        montant: montantPeriode,
        jour_numero: periodeDepart + i,
        statut: 'collecte',
        date: serverTimestamp(),
      });
    }

    const periodeFinale = periodeDepart + periodesCouvertes - 1;
    if (periodeFinale >= dureeTotale) {
      await updateDoc(doc(db, 'contracts', contrat.id), { statut: 'cloture' });
    }

    if (montantExcedent > 0) {
      notifier(`${periodesCouvertes} ${infoType.labelPeriode}(s) enregistrée(s) (${periodeDepart} à ${periodeFinale}) = ${formatGNF(montantAccepte)}. Excédent de ${formatGNF(montantExcedent)} NON enregistré — ouvrez un nouveau contrat pour ce reliquat.`, 'erreur');
    } else {
      notifier(`Versement enregistré : ${periodesCouvertes} ${infoType.labelPeriode}(s) couverte(s) (${periodeDepart} à ${periodeFinale}).`, 'succes');
    }
    afficherRecu({ nom: contrat.membre_nom, montant: montantAccepte, jour: periodeFinale, duree: dureeTotale, date: new Date() });
  } catch (err) {
    console.error(err);
    notifier('Erreur : ' + err.message, 'erreur');
  }
}

function ouvrirNouveauContrat(membreId, membreNom) {
  ouvrirModal(`
    <h2>Nouveau contrat — ${membreNom}</h2>
    <p class="subtitle-sm">Choisissez le type de contrat et démarrez-le.</p>
    <form id="form-nouveau-contrat">
      <div class="field-row">
        <label>Type de contrat</label>
        <select name="typeContrat" id="select-type-contrat-nc" required>
          <option value="journalier">${TYPES_CONTRAT.journalier.label}</option>
          <option value="hebdomadaire">${TYPES_CONTRAT.hebdomadaire.label}</option>
          <option value="mensuel">${TYPES_CONTRAT.mensuel.label}</option>
        </select>
      </div>
      <div class="field-row">
        <label id="label-montant-periode-nc">Montant du versement quotidien (GNF)</label>
        <input type="number" name="montantPeriode" min="1" required />
      </div>
      <div class="field-row" id="champ-commission-nc">
        <label>Commission encaissée aujourd'hui (jour 1, GNF)</label>
        <input type="number" name="commission" min="1" />
      </div>
      <div class="field-row hidden" id="champ-frais-inscription-nc">
        <label>Frais d'inscription (GNF)</label>
        <input type="number" name="fraisInscription" min="0" />
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" id="modal-annuler-nouveau-contrat" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Créer le contrat</button>
      </div>
    </form>
  `);
  document.getElementById('select-type-contrat-nc').addEventListener('change', (e) => {
    basculerChampsTypeContrat(e.target.value, 'label-montant-periode-nc', 'champ-commission-nc', 'champ-frais-inscription-nc');
  });
  document.getElementById('modal-annuler-nouveau-contrat').addEventListener('click', fermerModal);
  document.getElementById('form-nouveau-contrat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const typeContrat = fd.get('typeContrat');
    const montantPeriode = Number(fd.get('montantPeriode'));
    const commission = Number(fd.get('commission') || 0);
    const fraisInscription = Number(fd.get('fraisInscription') || 0);

    try {
      await creerContratEtPremierePeriode({
        membreId,
        membreNom,
        typeContrat,
        montantPeriode,
        commission,
        fraisInscription,
      });
      notifier('Nouveau contrat créé.', 'succes');
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier('Erreur : ' + err.message, 'erreur');
    }
  });
}

// Bascule l'affichage des champs "commission jour 1" (journalier) vs
// "frais d'inscription" (hebdo/mensuel) selon le type choisi.
function basculerChampsTypeContrat(typeContrat, labelMontantId, champCommissionId, champFraisId) {
  const infoType = infoTypeContrat(typeContrat);
  document.getElementById(labelMontantId).textContent = `Montant du ${infoType.labelVersement} (GNF)`;
  const champCommission = document.getElementById(champCommissionId);
  const champFrais = document.getElementById(champFraisId);
  if (typeContrat === 'journalier') {
    champCommission.classList.remove('hidden');
    champFrais.classList.add('hidden');
    champCommission.querySelector('input').required = true;
    champFrais.querySelector('input').required = false;
  } else {
    champCommission.classList.add('hidden');
    champFrais.classList.remove('hidden');
    champCommission.querySelector('input').required = false;
    champFrais.querySelector('input').required = false;
  }
}

// Crée le contrat + (journalier : versement jour 1 = commission) OU
// (hebdo/mensuel : document frais_inscription séparé, réparti selon
// les % réglés par le PDG dans parametres/interets_types_annuels).
async function creerContratEtPremierePeriode({ membreId, membreNom, typeContrat, montantPeriode, commission, fraisInscription }) {
  const infoType = infoTypeContrat(typeContrat);
  const contratData = {
    membre_id: membreId,
    membre_nom: membreNom,
    collecteur_id: state.currentCollecteurData.uid,
    statut: 'actif',
    type_contrat: typeContrat,
    duree_totale: infoType.duree,
    montant_mise: montantPeriode,
    date_debut: new Date().toISOString(),
  };
  if (typeContrat === 'journalier') {
    contratData.commission = commission;
  } else {
    contratData.frais_inscription = fraisInscription;
  }

  const contratRef = await addDoc(collection(db, 'contracts'), contratData);

  if (typeContrat === 'journalier') {
    await addDoc(collection(db, 'payments'), {
      contract_id: contratRef.id,
      collecteur_id: state.currentCollecteurData.uid,
      membre_id: membreId,
      montant: commission,
      jour_numero: 1,
      statut: 'collecte',
      date: serverTimestamp(),
    });
  } else if (fraisInscription > 0) {
    const montantPdg = fraisInscription * state.parametresInterets.pdg;
    const montantCollecteur = fraisInscription * state.parametresInterets.collecteur;
    await addDoc(collection(db, 'frais_inscription'), {
      contract_id: contratRef.id,
      membre_id: membreId,
      collecteur_id: state.currentCollecteurData.uid,
      montant_total: fraisInscription,
      montant_pdg: montantPdg,
      montant_collecteur: montantCollecteur,
      date: serverTimestamp(),
    });
  }

  return contratRef;
}

// ==========================================================
// --- NOUVEAU (25 août 2026) : gestion des dépenses (hebdo/mensuel) ---
// ==========================================================

function ouvrirNouvelleDepense(contrat) {
  ouvrirModal(`
    <h2>Nouvelle dépense — ${contrat.membre_nom}</h2>
    <p class="subtitle-sm">Cette dépense diminuera immédiatement l'épargne nette du membre. Elle restera visible comme justificatif tant qu'elle n'est pas compensée.</p>
    <form id="form-nouvelle-depense">
      <div class="field-row">
        <label>Date de la dépense</label>
        <input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}" />
      </div>
      <div class="field-row">
        <label>Libellé</label>
        <input type="text" name="libelle" required placeholder="Ex : frais de dossier, pénalité..." />
      </div>
      <div class="field-row">
        <label>Montant (GNF)</label>
        <input type="number" name="montant" min="1" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" id="modal-annuler-depense" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Enregistrer la dépense</button>
      </div>
    </form>
  `);
  document.getElementById('modal-annuler-depense').addEventListener('click', fermerModal);
  document.getElementById('form-nouvelle-depense').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const dateDepense = fd.get('date');
    const libelle = fd.get('libelle').trim();
    const montant = Number(fd.get('montant'));

    try {
      await addDoc(collection(db, 'depenses'), {
        contract_id: contrat.id,
        membre_id: contrat.membre_id,
        membre_nom: contrat.membre_nom,
        collecteur_id: state.currentCollecteurData.uid,
        date_depense: dateDepense,
        libelle,
        montant,
        compensee: false,
        date: serverTimestamp(),
      });
      notifier('Dépense enregistrée.', 'succes');
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier('Erreur : ' + err.message, 'erreur');
    }
  });
}

function ouvrirCompensationDepenses(contrat, totalNonCompense, depensesNonCompensees) {
  ouvrirModal(`
    <h2>Compenser les dépenses — ${contrat.membre_nom}</h2>
    <p class="subtitle-sm">Total des dépenses non compensées : <b>${formatGNF(totalNonCompense)}</b></p>
    <div style="max-height:180px; overflow-y:auto; margin:10px 0;">
      ${depensesNonCompensees.map((d) => `
        <div class="soldes-row"><span>${d.date_depense || ''} — ${d.libelle}</span><span>${formatGNF(d.montant)}</span></div>
      `).join('')}
    </div>
    <form id="form-compensation-depenses">
      <div class="field-row">
        <label>Montant versé pour compenser (GNF)</label>
        <input type="number" name="montant" min="1" max="${totalNonCompense}" value="${totalNonCompense}" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" id="modal-annuler-compensation" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Confirmer la compensation</button>
      </div>
    </form>
  `);
  document.getElementById('modal-annuler-compensation').addEventListener('click', fermerModal);
  document.getElementById('form-compensation-depenses').addEventListener('submit', async (e) => {
    e.preventDefault();
    const montant = Number(new FormData(e.target).get('montant'));
    try {
      await enregistrerCompensationDepenses(depensesNonCompensees, montant);
      notifier('Compensation enregistrée.', 'succes');
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier('Erreur : ' + err.message, 'erreur');
    }
  });
}

// Compense les dépenses les plus anciennes en premier, jusqu'à épuisement
// du montant versé. Une dépense partiellement compensée reste non compensée
// pour son reliquat (nouvelle ligne de dépense pour le reliquat, l'originale
// passe compensee=true pour la part couverte).
async function enregistrerCompensationDepenses(depensesNonCompensees, montantVerse) {
  let restant = montantVerse;
  const triees = [...depensesNonCompensees].sort((a, b) => (a.date_depense || '').localeCompare(b.date_depense || ''));

  for (const d of triees) {
    if (restant <= 0) break;
    const montantDepense = Number(d.montant || 0);
    if (restant >= montantDepense) {
      await updateDoc(doc(db, 'depenses', d.id), {
        compensee: true,
        date_compensation: serverTimestamp(),
        montant_compense: montantDepense,
      });
      restant -= montantDepense;
    } else {
      // Compensation partielle : on clôture la ligne d'origine pour la part
      // couverte et on recrée une ligne pour le reliquat non compensé.
      await updateDoc(doc(db, 'depenses', d.id), {
        compensee: true,
        date_compensation: serverTimestamp(),
        montant_compense: restant,
        montant: restant,
      });
      await addDoc(collection(db, 'depenses'), {
        contract_id: d.contract_id,
        membre_id: d.membre_id,
        membre_nom: d.membre_nom,
        collecteur_id: d.collecteur_id,
        date_depense: d.date_depense,
        libelle: d.libelle + ' (reliquat non compensé)',
        montant: montantDepense - restant,
        compensee: false,
        date: serverTimestamp(),
      });
      restant = 0;
    }
  }
}

document.getElementById('nouveauMembreBtn').addEventListener('click', () => {
  ouvrirModal(`
    <h2>Nouveau membre</h2>
    <p class="subtitle-sm">Créez le compte du membre, choisissez son type de contrat et enregistrez sa 1ère opération. Un mot de passe est généré automatiquement à partir de son numéro de téléphone.</p>
      <form id="form-nouveau-membre">
        <div class="field-row">
          <label>Nom et prénom du membre</label>
          <input type="text" name="nom" required />
        </div>
        <div class="field-row">
          <label>Téléphone (identifiant de connexion)</label>
          <input type="tel" name="telephone" required />
        </div>
        <div class="field-row">
          <label>E-mail</label>
          <input type="email" name="email" required />
        </div>
        <div class="field-row">
          <label>Résidence</label>
          <input type="text" name="residence" required />
        </div>
        <div class="field-row">
          <label>Type de contrat</label>
          <select name="typeContrat" id="select-type-contrat-nm" required>
            <option value="journalier">${TYPES_CONTRAT.journalier.label}</option>
            <option value="hebdomadaire">${TYPES_CONTRAT.hebdomadaire.label}</option>
            <option value="mensuel">${TYPES_CONTRAT.mensuel.label}</option>
          </select>
        </div>
        <div class="field-row">
          <label id="label-montant-periode-nm">Montant du versement quotidien (GNF)</label>
          <input type="number" name="montantPeriode" min="1" required />
        </div>
        <div class="field-row" id="champ-commission-nm">
          <label>Commission encaissée aujourd'hui (jour 1, GNF)</label>
          <input type="number" name="commission" min="1" />
        </div>
        <div class="field-row hidden" id="champ-frais-inscription-nm">
          <label>Frais d'inscription (GNF)</label>
          <input type="number" name="fraisInscription" min="0" />
        </div>
        <div class="modal-actions">
          <button type="button" class="secondary" id="modal-annuler-membre" style="flex:1;">Annuler</button>
          <button type="submit" style="flex:1;">Créer le compte</button>
        </div>
      </form>
  `);
  document.getElementById('select-type-contrat-nm').addEventListener('change', (e) => {
    basculerChampsTypeContrat(e.target.value, 'label-montant-periode-nm', 'champ-commission-nm', 'champ-frais-inscription-nm');
  });
  document.getElementById('modal-annuler-membre').addEventListener('click', fermerModal);
  document.getElementById('form-nouveau-membre').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const nom = fd.get('nom').trim();
    const telephone = fd.get('telephone').trim();
    const email = fd.get('email').trim();
    const residence = fd.get('residence').trim();
    const password = genererMotDePasseMembre(telephone);
    const typeContrat = fd.get('typeContrat');
    const montantPeriode = Number(fd.get('montantPeriode'));
    const commission = Number(fd.get('commission') || 0);
    const fraisInscription = Number(fd.get('fraisInscription') || 0);

    try {
      const emailTechnique = telephoneVersEmailTechnique(telephone);
      const uid = await creerCompteSecondaire(emailTechnique, password);

      await setDoc(doc(db, 'users', uid), {
        role: 'membre',
        nom, telephone, email, residence,
        parrain_id: state.currentCollecteurData.uid,
        statut: 'actif',
        date_creation: serverTimestamp(),
      });

      await creerContratEtPremierePeriode({
        membreId: uid,
        membreNom: nom,
        typeContrat,
        montantPeriode,
        commission,
        fraisInscription,
      });

      fermerModal();
      afficherIdentifiants({ nom, telephone, password });
    } catch (err) {
      console.error(err);
      notifier('Erreur : ' + err.message, 'erreur');
    }
  });
});

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
    <p>Période ${data.jour} / ${data.duree}</p>
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

function afficherIdentifiants(data) {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', zIndex: 1000,
  });
  const carte = document.createElement('div');
  Object.assign(carte.style, {
    background: 'white', borderRadius: '12px', padding: '24px',
    width: '85%', maxWidth: '350px', textAlign: 'center',
  });
  carte.innerHTML = `
    <h2 style="color:#0d6efd;">Identifiants du membre</h2>
    <p style="color:#666; margin-bottom:12px;">À transmettre oralement à ${data.nom}</p>
    <hr>
    <p style="margin:12px 0;">Téléphone :<br><strong style="font-size:18px;">${data.telephone}</strong></p>
    <p style="margin:12px 0;">Mot de passe :<br><strong style="font-size:22px; color:#198754;">${data.password}</strong></p>
    <hr>
    <p style="font-size:12px; color:#c0392b;">⚠️ Ce mot de passe ne sera plus jamais affiché ici. Transmettez-le maintenant.</p>
    <button style="margin-top:16px;" id="fermer-identifiants">J'ai transmis les identifiants</button>
  `;
  overlay.appendChild(carte);
  document.body.appendChild(overlay);
  carte.querySelector('#fermer-identifiants').addEventListener('click', () => overlay.remove());
}

// --- Correctif (23 août 2026) : versement comptabilisé = tout ce qui n'est pas annulé.
async function afficherDetailsMembre(contrat) {
  const typeContrat = contrat.type_contrat || 'journalier';
  const infoType = infoTypeContrat(typeContrat);
  const dureeTotale = contrat.duree_totale || infoType.duree;
  const versements = state.payments.filter((p) => p.contract_id === contrat.id);
  const versementsComptes = versements.filter((p) => p.statut !== 'annule');
  const versementsEnAttenteVerrou = versements.filter((p) => p.statut === 'collecte');
  const totalConfirme = versementsComptes.reduce((s, p) => s + Number(p.montant || 0), 0);
  const totalNonConfirme = versementsEnAttenteVerrou.reduce((s, p) => s + Number(p.montant || 0), 0);
  const epargneNette = calculerEpargneNetteContrat(contrat);
  const soldeDisponible = calculerSoldeDisponible(contrat);

  let telephone = '—';
  let residence = '—';
  try {
    const membreSnap = await getDoc(doc(db, 'users', contrat.membre_id));
    if (membreSnap.exists()) {
      telephone = membreSnap.data().telephone || '—';
      residence = membreSnap.data().residence || '—';
    }
  } catch (e) { /* ignore */ }

  const contratsNonSoldes = trouverContratsNonSoldes(contrat.membre_id, contrat.id);
  const totalNonSolde = contratsNonSoldes.reduce((s, c) => s + Math.max(0, calculerEpargneNetteContrat(c)), 0);

  const pret = (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === 'actif');

  const depensesContrat = state.depenses.filter((d) => d.contract_id === contrat.id)
    .sort((a, b) => (b.date_depense || '').localeCompare(a.date_depense || ''));

  ouvrirModal(`
    <h2>${contrat.membre_nom}</h2>
    <p class="subtitle-sm">Téléphone : ${telephone} · Résidence : ${residence} · Type : ${infoType.label}</p>
    <div class="soldes-row"><span>Épargne nette : <b>${formatGNF(epargneNette > 0 ? epargneNette : 0)}</b></span></div>
    ${pret ? `<div class="soldes-row"><span style="color:#c0392b;">Solde disponible (après prêt)</span><span style="color:#c0392b;"><b>${formatGNF(soldeDisponible)}</b></span></div>` : ''}
    <div class="soldes-row"><span>Versement comptabilisé : <b>${formatGNF(totalConfirme)}</b></span></div>
    <div class="soldes-row"><span>En attente de verrouillage (24h) : <b>${formatGNF(totalNonConfirme)}</b></span></div>
    <div class="soldes-row"><span>Montant du ${infoType.labelVersement} : <b>${formatGNF(contrat.montant_mise || 0)}</b></span></div>
    <div class="soldes-row"><span>${infoType.labelPeriode.charAt(0).toUpperCase() + infoType.labelPeriode.slice(1)}(s) payé(s) : <b>${versementsComptes.length}/${dureeTotale}</b></span></div>
    ${totalNonSolde > 0 ? `<div class="soldes-row"><span style="color:#c0392b;">Contrat(s) non soldé(s)</span><span style="color:#c0392b;"><b>${formatGNF(totalNonSolde)}</b></span></div>` : ""}
    ${depensesContrat.length > 0 ? `
      <h2 style="margin-top:14px; font-size:15px;">Dépenses de ce contrat</h2>
      <div style="max-height:150px; overflow-y:auto; margin-top:6px;">
        ${depensesContrat.map((d) => `
          <div class="soldes-row"><span>${d.date_depense || ''} — ${d.libelle} ${d.compensee ? '<span style="color:#198754;">(compensée)</span>' : '<span style="color:#e67e22;">(non compensée)</span>'}</span><span>${formatGNF(d.montant)}</span></div>
        `).join('')}
      </div>
    ` : ''}
    <div class="modal-actions">
      <button type="button" class="secondary" id="modal-fermer-details" style="flex:1;">Fermer</button>
    </div>
  `);
  document.getElementById('modal-fermer-details').addEventListener('click', fermerModal);
}

function ouvrirRemboursementPret(pretId) {
  const pret = state.prets.find((p) => p.id === pretId);
  if (!pret) return;
  const montantDu = calculerMontantDuPret(pret);
  const montant = prompt(`Montant dû : ${formatGNF(montantDu)}\nMontant remboursé aujourd'hui :`);
  if (montant === null) return;
  const montantNum = parseFloat(montant);
  if (isNaN(montantNum) || montantNum <= 0) {
    notifier('Montant invalide.', 'erreur');
    return;
  }
  enregistrerRemboursement(pret, montantNum, montantDu);
}

// ==========================================================
// --- NOUVEAU (25 août 2026) : répartition d'intérêt généralisée ---
// Journalier : 70% PDG / 30% collecteur (fixe, historique).
// Hebdomadaire / Mensuel : %PDG / %collecteur / %redistribution réglés
// par le PDG (state.parametresInterets). La part "redistribution" est
// répartie immédiatement entre les membres à contrat annuel actif DU MÊME
// COLLECTEUR, au prorata de leur cotisation périodique.
// ==========================================================

async function enregistrerRemboursement(pret, montant, montantDuAvant) {
  try {
    const typeContrat = pret.type_contrat || 'journalier';
    let interetAccumule;
    if (typeContrat === 'hebdomadaire' || typeContrat === 'mensuel') {
      const nbMoisEntamesFn = (await import('./utils.js')).nbMoisEntames;
      const nbMois = nbMoisEntamesFn(pret.date_debut);
      interetAccumule = pret.montant_initial * (pret.taux_mensuel || TAUX_MENSUEL_PRET_DEFAUT) * nbMois;
    } else {
      const nbSemaines = nbSemainesEntamees(pret);
      interetAccumule = pret.montant_initial * (pret.taux_hebdo || TAUX_HEBDO_PRET) * nbSemaines;
    }
    const interetDejaReconnu = Number(pret.interet_deja_reconnu || 0);
    const interetNonReconnu = Math.max(0, interetAccumule - interetDejaReconnu);
    const interetReconnuMaintenant = Math.min(montant, interetNonReconnu);

    await addDoc(collection(db, 'remboursements_prets'), {
      pret_id: pret.id,
      membre_id: pret.membre_id,
      collecteur_id: state.currentCollecteurData.uid,
      enregistre_par_role: 'collecteur',
      enregistre_par_uid: state.currentCollecteurData.uid,
      montant,
      date: serverTimestamp(),
    });

    if (interetReconnuMaintenant > 0) {
      if (typeContrat === 'hebdomadaire' || typeContrat === 'mensuel') {
        const { pdg, collecteur, redistribution } = state.parametresInterets;
        const montantPdg = interetReconnuMaintenant * pdg;
        const montantCollecteur = interetReconnuMaintenant * collecteur;
        const montantRedistribution = interetReconnuMaintenant * redistribution;

        await addDoc(collection(db, 'interets_prets_repartis'), {
          pret_id: pret.id,
          membre_id: pret.membre_id,
          collecteur_id: state.currentCollecteurData.uid,
          montant_collecteur: montantCollecteur,
          montant_pdg: montantPdg,
          montant_redistribution: montantRedistribution,
          date: serverTimestamp(),
        });

        if (montantRedistribution > 0) {
          await redistribuerAuxMembresAnnuels(pret, montantRedistribution);
        }
      } else {
        const montantCollecteur = interetReconnuMaintenant * PART_INTERET_COLLECTEUR;
        const montantPdg = interetReconnuMaintenant * PART_INTERET_PDG;
        await addDoc(collection(db, 'interets_prets_repartis'), {
          pret_id: pret.id,
          membre_id: pret.membre_id,
          collecteur_id: state.currentCollecteurData.uid,
          montant_collecteur: montantCollecteur,
          montant_pdg: montantPdg,
          date: serverTimestamp(),
        });
      }
      await updateDoc(doc(db, 'prets', pret.id), {
        interet_deja_reconnu: interetDejaReconnu + interetReconnuMaintenant,
      });
    }

    if (montant >= montantDuAvant) {
      await updateDoc(doc(db, 'prets', pret.id), { statut: 'rembourse' });
      notifier('Prêt entièrement remboursé.', 'succes');
    } else {
      notifier('Remboursement enregistré.', 'succes');
    }
  } catch (err) {
    console.error(err);
    notifier('Erreur : ' + err.message, 'erreur');
  }
}

// Répartit un montant entre les membres à contrat hebdo/mensuel actif DU MÊME
// COLLECTEUR que le prêt d'origine (pas tous les collecteurs de l'entreprise),
// au prorata de leur cotisation périodique.
async function redistribuerAuxMembresAnnuels(pretOrigine, montantARepartir) {
  const beneficiaires = state.contracts.filter((c) =>
    c.statut === 'actif' &&
    (c.type_contrat === 'hebdomadaire' || c.type_contrat === 'mensuel') &&
    c.id !== pretOrigine.contract_id
  );
  if (beneficiaires.length === 0) return;

  const totalCotisations = beneficiaires.reduce((s, c) => s + Number(c.montant_mise || 0), 0);
  if (totalCotisations <= 0) return;

  for (const contrat of beneficiaires) {
    const part = (Number(contrat.montant_mise || 0) / totalCotisations) * montantARepartir;
    if (part <= 0) continue;
    await addDoc(collection(db, 'redistributions_interets'), {
      pret_id: pretOrigine.id,
      contract_id: contrat.id,
      membre_id: contrat.membre_id,
      membre_nom: contrat.membre_nom,
      collecteur_id: state.currentCollecteurData.uid,
      montant: part,
      date: serverTimestamp(),
    });
  }
}

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
