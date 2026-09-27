// === COLLECTEUR — PARTIE 1/2 ===
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

// ==========================================================
// --- NOUVEAU (20 sept 2026) : TONTINE TOURNANTE ---
// Le module ./tournante-commun.js est chargé À LA DEMANDE, dans un try/catch :
// s'il est absent ou en erreur, le reste de l'application fonctionne comme avant.
// Les libellés sont définis ici pour ne pas dépendre de utils.js.
// ==========================================================
const LABEL_TOURNANTE = 'Tontine tournante';

const PERIODICITES = {
  jour: 'Journalière',
  semaine: 'Hebdomadaire',
  mois: 'Mensuelle',
  trimestre: 'Trimestrielle',
  semestre: 'Semestrielle',
  annee: 'Annuelle',
};

function esc(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function libelleStatutCaisse(s) {
  return s === 'inscriptions' ? 'Inscriptions ouvertes' : s === 'en_cours' ? 'En cours' : 'Clôturée';
}

let moduleTournante = null;
async function obtenirModuleTournante() {
  if (moduleTournante) return moduleTournante;
  try {
    moduleTournante = await import('./tournante-commun.js');
  } catch (err) {
    console.warn('Module tontine tournante indisponible :', err);
    moduleTournante = null;
  }
  return moduleTournante;
}

const TAUX_COMMISSION = 0.30;
const PART_INTERET_COLLECTEUR = 0.30;
const PART_INTERET_PDG = 0.70;
const TAUX_HEBDO_PRET = 0.02;
const TAUX_MENSUEL_PRET_DEFAUT = 0.08;
const AVATAR_DEFAUT = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><rect width='56' height='56' fill='%23ddd'/></svg>";

const state = {
  currentUser: null,
  currentCollecteurData: null,
  contracts: [],
  payments: [],
  versements: [],
  withdrawalRequests: [],
  retraitsConfirmesMembres: [],
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
  propositionsReconduction: [],
  propositionsNouveauContrat: [],
  // --- NOUVEAU (19 sept 2026) : tontine tournante ---
  caissesTournante: [],
  membresTournante: [],
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

function demarrer() {
  showOnly(loading);
  onAuthStateChanged(auth, async (user) => {
    if (creationEnCours) return;
    // --- MODIFIÉ (20 sept 2026) : try/catch pour afficher l'erreur au lieu de rester sur "Chargement..." ---
    try {
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
    } catch (err) {
      console.error(err);
      showOnly(loginScreen);
      loginError.textContent = 'Erreur de chargement du compte : ' + (err.message || err);
    }
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
  initialiserBoutonCommunication();

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
  // --- NOUVEAU (16 sept 2026) : retraits/prêts CONFIRMÉS des membres,
  // nécessaires au calcul du solde total d'épargne net et à l'historique. ---
  const unsubRetraitsConfirmesMembres = onSnapshot(
    query(
      collection(db, 'withdrawalRequests'),
      where('collecteur_id', '==', state.currentCollecteurData.uid),
      where('statut', '==', 'confirme')
    ),
    (snap) => {
      state.retraitsConfirmesMembres = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
  const unsubPropositions = onSnapshot(
    query(collection(db, 'propositions_reconduction'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.propositionsReconduction = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
  const unsubPropositionsNouveauContrat = onSnapshot(
    query(collection(db, 'propositions_nouveau_contrat'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.propositionsNouveauContrat = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
      // --- NOUVEAU (19 sept 2026) : finalise les adhésions tontine tournante confirmées
      // par les membres (le module n'est chargé que s'il y en a à traiter) ---
      const adhesionsAFinaliser = state.propositionsNouveauContrat.some(
        (p) => p.type_contrat === 'tournante' && p.statut === 'accepte' && p.adhesion_traitee !== true
      );
      if (adhesionsAFinaliser) {
        obtenirModuleTournante()
          .then((mod) => (mod ? mod.finaliserAdhesionsEnAttente(state.propositionsNouveauContrat) : null))
          .catch((err) => console.error(err));
      }
    }
  );

  // --- NOUVEAU (19 sept 2026) : tontine tournante (caisses et membres du collecteur) ---
  const unsubCaissesTournante = onSnapshot(
    query(collection(db, 'caisses_tournantes'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.caissesTournante = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    },
    (err) => console.warn('Caisses tournantes :', err)
  );
  const unsubMembresTournante = onSnapshot(
    query(collection(db, 'tournante_membres'), where('collecteur_id', '==', state.currentCollecteurData.uid)),
    (snap) => {
      state.membresTournante = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    },
    (err) => console.warn('Membres tontine tournante :', err)
  );

  state.unsubscribers.push(
    unsubContracts, unsubPayments, unsubVersements, unsubPrets, unsubRemboursements,
    unsubRetraits, unsubRetraitsConfirmesMembres, unsubInterets, unsubRetraitsCommission, unsubDiffusions, unsubMesMessages,
    unsubFraisInscription, unsubDepenses, unsubRedistributions, unsubParametres, unsubPropositions,
    unsubPropositionsNouveauContrat, unsubCaissesTournante, unsubMembresTournante
  );
}

function renderAll() {
  renderCollecteurHeader();
  renderRetraitsMembres();
  renderReconductionsATraiter();
  renderCommunicationCollecteur();
  // --- MODIFIÉ (20 sept 2026) : affichage des caisses isolé, une erreur ne bloque pas le reste ---
  try {
    renderCaissesTournante();
  } catch (err) {
    console.warn('Affichage des caisses tournantes :', err);
  }
  renderMembersList();
}

// ==========================================================
// --- MODIFIÉ (16 sept 2026) : tableau de bord simplifié à 5 soldes.
// 1) Solde total d'épargne net = tous les versements - commission
//    journalière (100%, jour 1) - retraits confirmés des membres.
// 2) Commission collecteur (30%) et 3) Commission totale (100%) : calculées
//    uniquement sur les contrats CRÉÉS ce mois-ci, NETTES des retraits de
//    commission déjà confirmés/en attente pour ce collecteur (corrigé le
//    26 sept 2026 : un retrait de commission doit faire baisser
//    immédiatement ces soldes, plus les laisser inchangés après retrait).
// 4) Total collecté (corrigé le 26 sept 2026) = somme des versements reçus
//    des membres depuis le début du mois en cours - somme des retraits
//    confirmés des membres durant le mois en cours (définition donnée par
//    le PDG, indépendante des commissions).
// 5) Épargne nette par type de contrat.
// En haut du tableau de bord : nombre de contrats actifs/inactifs (réutilise
// la ligne "collectorStats" déjà présente). Un bouton "HISTORIQUE DES
// RETRAIT" liste les retraits/prêts confirmés des membres.
// ==========================================================

function renderCollecteurHeader() {
  document.getElementById('collectorName').textContent = state.currentCollecteurData.nom || 'Collecteur';

  // --- a) Nombre de contrats actifs / inactifs, en haut du tableau de bord ---
  const versementsConfirmesTousPourStatut = state.payments.filter((p) => p.statut !== 'annule');
  const contratsActifsStatut = state.contracts.filter((c) => c.statut === 'actif');
  let nbActifs = 0;
  let nbInactifs = 0;
  contratsActifsStatut.forEach((c) => {
    const statutCalc = calculerStatutContrat(c, versementsConfirmesTousPourStatut);
    if (statutCalc === 'inactif') { nbInactifs++; } else { nbActifs++; }
  });
  const collectorStatsEl = document.getElementById('collectorStats');
  if (collectorStatsEl) {
    collectorStatsEl.textContent = `${nbActifs} contrat(s) actif(s) · ${nbInactifs} inactif(s)`;
  }

  // --- Masque les champs redondants avec les nouveaux soldes simplifiés ---
  ['commissionConfirmee', 'commissionAttente'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.parentElement) el.parentElement.style.display = 'none';
  });

  // --- Calcul (inchangé) de la commission disponible au retrait, cumulée
  // depuis le début (nécessaire pour le bouton de demande de retrait) ---
  const versementsConfirmes = state.payments.filter((p) => p.statut === 'confirme');
  const commissionsConfirmees = versementsConfirmes.filter((p) => p.jour_numero === 1);
  const totalCommissionConfirmee = commissionsConfirmees.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionInscriptions = totalCommissionConfirmee * TAUX_COMMISSION;
  const fraisInscriptionCollecteur = state.fraisInscriptions.reduce((s, f) => s + Number(f.montant_collecteur || 0), 0);
  const commissionInterets = state.interetsPartages.reduce((s, i) => s + Number(i.montant_collecteur || 0), 0);
  const CC = commissionInscriptions + fraisInscriptionCollecteur + commissionInterets;
  const retraitsCommissionConfirmes = state.retraitsCommission.filter((r) => r.statut === 'confirme');
  const retraitsCommissionEnAttente = state.retraitsCommission.filter((r) => r.statut === 'en_attente');
  const totalRetraitCommissionConfirme = retraitsCommissionConfirmes.reduce((s, r) => s + Number(r.montant || 0), 0);
  const totalRetraitCommissionEnAttente = retraitsCommissionEnAttente.reduce((s, r) => s + Number(r.montant || 0), 0);
  const commissionDisponibleRetrait = Math.max(0, CC - totalRetraitCommissionConfirme - totalRetraitCommissionEnAttente);

  // --- Calculs des soldes simplifiés ---
  // --- CORRIGÉ (26 sept 2026) : un retrait de commission (déjà confirmé ou
  // encore en attente de validation PDG) doit immédiatement faire baisser
  // les soldes de commission affichés — ils ne restent plus figés après un
  // retrait. On applique donc, sur la commission collecteur du mois, le
  // même retranchement (confirmé + en attente) que celui utilisé pour
  // "Commission disponible au retrait" ci-dessus. Le retrait étant demandé
  // sur la commission collecteur (30%), on ne peut retrancher que cette
  // part-là ; la part PDG (100% - 30%) n'est pas visible depuis l'app
  // Collecteur (ses propres retraits sont gérés côté PDG).
  const soldeTotalEpargneNet = calculerSoldeTotalEpargneNet();
  const { commissionTotale100, commissionCollecteur30: commissionCollecteur30Brute } = calculerCommissionsMoisEnCours();
  const retraitCommissionTotal = totalRetraitCommissionConfirme + totalRetraitCommissionEnAttente;
  const commissionCollecteur30 = Math.max(0, commissionCollecteur30Brute - retraitCommissionTotal);
  // --- CORRIGÉ (26 sept 2026) : Total collecté = versements reçus des
  // membres depuis le début du mois en cours - retraits confirmés des
  // membres du mois en cours (définition donnée par le PDG, sans lien avec
  // les commissions). ---
  const totalCollecte = calculerTotalCollecteMois();

  let situationBloc = document.getElementById('situationGenerale');
  if (!situationBloc) {
    situationBloc = document.createElement('div');
    situationBloc.id = 'situationGenerale';
    situationBloc.innerHTML = `
      <div class="soldes-row"><span>Solde total d'épargne net : <b id="soldeTotalEpargneNet">0 GNF</b></span></div>
      <div class="soldes-row"><span>Solde des commissions collecteur (mois en cours, 30%, net des retraits) : <b id="soldeCommissionCollecteurMois">0 GNF</b></span></div>
      <div class="soldes-row"><span>Commission totale (mois en cours, 100%) : <b id="soldeCommissionTotaleMois">0 GNF</b></span></div>
      <div class="soldes-row"><span>Total collecté : <b id="soldeTotalCollecte">0 GNF</b></span></div>
      <hr style="margin:10px 0; border:none; border-top:1px solid #eee;">
      <p style="font-weight:bold; margin-bottom:6px;">Épargne nette par type de contrat</p>
      <div id="soldesParType"></div>
      <hr style="margin:10px 0; border:none; border-top:1px solid #eee;">
      <div class="soldes-row"><span>Commission disponible au retrait : <b id="soldeCommissionDisponible">0 GNF</b></span></div>
      <button type="button" id="btn-demander-retrait-commission" style="margin-top:10px;">Demander le retrait de ma commission</button>
      <button type="button" id="btn-historique-retraits" class="secondary" style="margin-top:10px;">HISTORIQUE DES RETRAIT</button>
    `;
    document.getElementById('commissionAttente').closest('.card').appendChild(situationBloc);
    document.getElementById('btn-demander-retrait-commission').addEventListener('click', ouvrirDemandeRetraitCommission);
    document.getElementById('btn-historique-retraits').addEventListener('click', ouvrirHistoriqueRetraits);
  }

  document.getElementById('soldeTotalEpargneNet').textContent = formatGNF(soldeTotalEpargneNet > 0 ? soldeTotalEpargneNet : 0);
  document.getElementById('soldeCommissionCollecteurMois').textContent = formatGNF(commissionCollecteur30);
  document.getElementById('soldeCommissionTotaleMois').textContent = formatGNF(commissionTotale100);
  document.getElementById('soldeTotalCollecte').textContent = formatGNF(totalCollecte);
  document.getElementById('soldeCommissionDisponible').textContent = formatGNF(commissionDisponibleRetrait);
  renderSoldesParType();

  const btnRetrait = document.getElementById('btn-demander-retrait-commission');
  if (btnRetrait) {
    btnRetrait.disabled = commissionDisponibleRetrait <= 0;
    btnRetrait.dataset.disponible = commissionDisponibleRetrait;
  }
}

function estContratDuMoisEnCours(contrat) {
  if (!contrat || !contrat.date_debut) return false;
  const d = contrat.date_debut instanceof Date ? contrat.date_debut : new Date(contrat.date_debut);
  if (isNaN(d.getTime())) return false;
  const maintenant = new Date();
  return d.getFullYear() === maintenant.getFullYear() && d.getMonth() === maintenant.getMonth();
}

// --- NOUVEAU (19 sept 2026) : date (Timestamp Firestore ou texte) dans le mois en cours ---
function estDuMoisEnCours(dateVal) {
  if (!dateVal) return false;
  const d = dateVal.toDate ? dateVal.toDate() : new Date(dateVal);
  if (isNaN(d.getTime())) return false;
  const maintenant = new Date();
  return d.getFullYear() === maintenant.getFullYear() && d.getMonth() === maintenant.getMonth();
}

function calculerCommissionsMoisEnCours() {
  const contratsDuMois = state.contracts.filter(estContratDuMoisEnCours);
  const idsDuMois = new Set(contratsDuMois.map((c) => c.id));

  const jour1DuMois = state.payments.filter(
    (p) => p.statut === 'confirme' && p.jour_numero === 1 && idsDuMois.has(p.contract_id)
  );
  const totalJour1 = jour1DuMois.reduce((s, p) => s + Number(p.montant || 0), 0);

  const fraisDuMois = state.fraisInscriptions.filter((f) => idsDuMois.has(f.contract_id));
  const totalFrais = fraisDuMois.reduce(
    (s, f) => s + (Number(f.montant_pdg || 0) + Number(f.montant_collecteur || 0)), 0
  );
  const totalFraisCollecteur = fraisDuMois.reduce((s, f) => s + Number(f.montant_collecteur || 0), 0);

  const pretsDuMoisIds = new Set(state.prets.filter((p) => idsDuMois.has(p.contract_id)).map((p) => p.id));
  const interetsDuMois = state.interetsPartages.filter((i) => pretsDuMoisIds.has(i.pret_id));
  const totalInterets = interetsDuMois.reduce(
    (s, i) => s + (Number(i.montant_pdg || 0) + Number(i.montant_collecteur || 0)), 0
  );
  const totalInteretsCollecteur = interetsDuMois.reduce((s, i) => s + Number(i.montant_collecteur || 0), 0);

  // --- NOUVEAU (19 sept 2026) : frais et pénalités de la tontine tournante du mois ---
  const fraisTournanteDuMois = state.fraisInscriptions.filter(
    (f) => f.source === 'tontine_tournante' && estDuMoisEnCours(f.date)
  );
  const totalFraisTournante = fraisTournanteDuMois.reduce(
    (s, f) => s + (Number(f.montant_pdg || 0) + Number(f.montant_collecteur || 0)), 0
  );
  const totalFraisTournanteCollecteur = fraisTournanteDuMois.reduce((s, f) => s + Number(f.montant_collecteur || 0), 0);

  const commissionTotale100 = totalJour1 + totalFrais + totalInterets + totalFraisTournante;
  const commissionCollecteur30 = totalJour1 * 0.30 + totalFraisCollecteur + totalInteretsCollecteur + totalFraisTournanteCollecteur;

  return { commissionTotale100, commissionCollecteur30 };
}

function calculerSoldeTotalEpargneNet() {
  const TC = state.payments.filter((p) => p.statut !== 'annule').reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionJournalierTotale = state.payments
    .filter((p) => p.statut === 'confirme' && p.jour_numero === 1)
    .reduce((s, p) => s + Number(p.montant || 0), 0);
  const retraitsConfirmesTotal = state.retraitsConfirmesMembres.reduce((s, r) => s + Number(r.montant || 0), 0);
  return TC - commissionJournalierTotale - retraitsConfirmesTotal;
}

// --- NOUVEAU (26 sept 2026) : Total collecté = somme des versements reçus
// des membres depuis le début du mois en cours - somme des retraits
// confirmés des membres durant le mois en cours. Indépendant du calcul de
// commission (remplace l'ancienne définition "épargne nette + commission
// du mois", qui ne correspondait pas à la logique voulue par le PDG). ---
function calculerTotalCollecteMois() {
  const versementsDuMois = state.payments.filter(
    (p) => p.statut !== 'annule' && estDuMoisEnCours(p.date)
  );
  const totalVersementsDuMois = versementsDuMois.reduce((s, p) => s + Number(p.montant || 0), 0);

  const retraitsMembresDuMois = state.retraitsConfirmesMembres.filter(
    (r) => estDuMoisEnCours(r.date_confirmation || r.dateCreation)
  );
  const totalRetraitsMembresDuMois = retraitsMembresDuMois.reduce((s, r) => s + Number(r.montant || 0), 0);

  return totalVersementsDuMois - totalRetraitsMembresDuMois;
}

function calculerEpargneNetteParType(typeContratCle) {
  const contrats = state.contracts.filter((c) => (c.type_contrat || 'journalier') === typeContratCle);
  return contrats.reduce((s, c) => s + Math.max(0, calculerEpargneNetteContrat(c)), 0);
}

function renderSoldesParType() {
  const container = document.getElementById('soldesParType');
  if (!container) return;
  const types = ['journalier', 'hebdomadaire', 'mensuel'];
  container.innerHTML = types.map((t) => {
    const infoType = infoTypeContrat(t);
    const montant = calculerEpargneNetteParType(t);
    return `<div class="soldes-row"><span>${infoType.label} : <b>${formatGNF(montant)}</b></span></div>`;
  }).join('');
}

// ==========================================================
// --- NOUVEAU (16 sept 2026) : bouton "HISTORIQUE DES RETRAIT" — liste des
// membres ayant effectué un retrait ou un prêt confirmé, avec date et
// montant.
// ==========================================================
function ouvrirHistoriqueRetraits() {
  const items = [...state.retraitsConfirmesMembres].sort(
    (a, b) => (b.date_confirmation?.toMillis?.() || b.dateCreation?.toMillis?.() || 0)
      - (a.date_confirmation?.toMillis?.() || a.dateCreation?.toMillis?.() || 0)
  );
  const html = `
    <h2>Historique des retraits et prêts</h2>
    <p class="subtitle-sm">Membres ayant effectué un retrait ou obtenu un prêt (confirmés).</p>
    <div style="max-height:340px; overflow-y:auto; margin-top:10px;">
      ${items.length === 0 ? '<p style="color:#999; font-size:13px;">Aucun retrait ou prêt confirmé pour le moment.</p>' : items.map((r) => {
        const libelle = libelleTypeRetrait(r.type);
        const dateAffichee = formatDateHeure(r.date_confirmation || r.dateCreation);
        return `
          <div class="retrait-row">
            <div class="retrait-row-top">
              <div>
                <strong>${r.memberName || 'Membre'}</strong><br>
                <small>${libelle}</small><br>
                <small style="color:#999;">${dateAffichee}</small>
              </div>
              <span class="badge attente">${formatGNF(r.montant)}</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="modal-actions" style="margin-top:14px;">
      <button type="button" class="secondary" id="modal-fermer-historique" style="flex:1;">Fermer</button>
    </div>
  `;
  ouvrirModal(html);
  document.getElementById('modal-fermer-historique').addEventListener('click', fermerModal);
}

// ==========================================================
// --- NOUVEAU (16 sept 2026) : b) compteur du nombre total de membres,
// affiché entre parenthèses après le texte "Mes membres". Sans accès au
// HTML, on cherche l'élément par correspondance exacte de son texte.
// --- MODIFIÉ (19 sept 2026) : compte aussi les membres de tontine tournante.
// ==========================================================
function mettreAJourCompteurMembres() {
  const nombreMembresTotal = new Set(
    [...state.contracts.map((c) => c.membre_id), ...state.membresTournante.map((m) => m.membre_uid)].filter(Boolean)
  ).size;
  const elements = document.querySelectorAll('h1, h2, h3, h4, span, p, strong, b, div, button, a');
  for (const el of elements) {
    if (el.children.length === 0) {
      const texte = el.textContent.trim();
      if (texte === 'Mes membres' || /^Mes membres \(\d+\)$/.test(texte)) {
        el.textContent = `Mes membres (${nombreMembresTotal})`;
        return;
      }
    }
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
    <p class="subtitle-sm">Type de contrat reconduit : <b>${infoType.label}</b>. Ceci crée réellement le nouveau contrat au moment de l'encaissement.
    ${estJournalier ? " Le 1er versement (jour 1) est automatiquement prélevé comme commission (frais d'entretien du compte), quel que soit le montant journalier choisi ci-dessous." : ""}</p>
    <form id="form-finaliser-reconduction">
      <div class="field-row">
        <label>Montant du ${infoType.labelVersement} (GNF)</label>
        <input type="number" name="montantPeriode" min="1" value="${montantPeriodeSuggere || ''}" required />
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
    const fraisInscription = Number(fd.get('fraisInscription') || 0);

    try {
      const contratRef = await creerContratEtPremierePeriode({
        membreId: proposition.membre_id,
        membreNom: proposition.membre_nom,
        typeContrat,
        montantPeriode,
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

// ==========================================================
// --- NOUVEAU (13 sept 2026) : bouton "COMMUNICATION" créé en JS.
// Masque par défaut les diffusions du PDG, le fil de messages privés et le
// formulaire de réponse. Un clic sur le bouton affiche/masque ces zones.
// ==========================================================
function initialiserBoutonCommunication() {
  if (document.getElementById('btn-communication')) return;
  const ids = ['diffusionsCollecteurList', 'filPdgMessages', 'form-message-pdg'];
  const cartes = [];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const carte = el.closest('.card') || el.parentElement;
    if (carte && !cartes.includes(carte)) cartes.push(carte);
  });
  if (cartes.length === 0) return;

  cartes.forEach((c) => c.classList.add('hidden'));

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'btn-communication';
  btn.textContent = 'COMMUNICATION';
  btn.style.width = '100%';
  btn.style.marginBottom = '10px';
  btn.style.background = '#0d6efd';
  btn.style.color = 'white';
  btn.addEventListener('click', () => {
    const masque = cartes[0].classList.contains('hidden');
    cartes.forEach((c) => c.classList.toggle('hidden', !masque));
  });
  cartes[0].insertAdjacentElement('beforebegin', btn);
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

  const btnCommunication = document.getElementById('btn-communication');
  if (btnCommunication) {
    btnCommunication.style.background = nonLus.length > 0 ? '#198754' : '#0d6efd';
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
// === FIN COLLECTEUR — PARTIE 1/2 ===
