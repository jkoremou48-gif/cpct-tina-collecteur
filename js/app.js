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
    }
  );

  state.unsubscribers.push(
    unsubContracts, unsubPayments, unsubVersements, unsubPrets, unsubRemboursements,
    unsubRetraits, unsubInterets, unsubRetraitsCommission, unsubDiffusions, unsubMesMessages,
    unsubFraisInscription, unsubDepenses, unsubRedistributions, unsubParametres, unsubPropositions,
    unsubPropositionsNouveauContrat
  );
}

function renderAll() {
  renderCollecteurHeader();
  renderRetraitsMembres();
  renderReconductionsATraiter();
  renderCommunicationCollecteur();
  renderMembersList();
}

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
