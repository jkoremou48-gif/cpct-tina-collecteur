// ==========================
// CPCT-TINA — App Collecteur
// ==========================

import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, orderBy, onSnapshot, serverTimestamp,
  creerCompteSecondaire, uploaderPhotoProfil, changerMotDePasse,
} from "./firebase-config.js";

import { genererCodeParrain, formatGNF, formatDate, notifier, calculerStatutContrat } from "./utils.js";

const TAUX_COMMISSION = 0.30;
const PART_INTERET_COLLECTEUR = 0.30;
const PART_INTERET_PDG = 0.70;
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

// --- Photo de profil ---
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

// --- Changement de mot de passe ---
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
  // Chantier "autonomie collecteur" (13 août 2026) : ne charge que les demandes
  // de retrait/prêt des membres de CE collecteur (filtre sur collecteur_id,
  // renseigné par l'app Membre lors de la création de la demande).
  const unsubRetraits = onSnapshot(
    query(
      collection(db, 'withdrawalRequests'),
      where('statut', '==', 'en_attente'),
      where('collecteur_id', '==', state.currentCollecteurData.uid)
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
  state.unsubscribers.push(unsubContracts, unsubPayments, unsubVersements, unsubPrets, unsubRemboursements, unsubRetraits, unsubInterets, unsubRetraitsCommission);
}

function renderAll() {
  renderCollecteurHeader();
  renderMembersList();
  renderDemandesRetrait();
}

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

  const commissionsConfirmees = versementsConfirmes.filter((p) => p.jour_numero === 1);
  const totalCommissionConfirmee = commissionsConfirmees.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionInscriptions = totalCommissionConfirmee * TAUX_COMMISSION;
  const commissionInterets = state.interetsPartages.reduce((s, i) => s + Number(i.montant_collecteur || 0), 0);
  const CC = commissionInscriptions + commissionInterets;

  const soldeTotalEpargnes = versementConfirmeTotal - totalCommissionConfirmee;

  const commissionsNonConfirmees = versementsNonConfirmes.filter((p) => p.jour_numero === 1);
  const totalCommissionNonConfirmee = commissionsNonConfirmees.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionEnAttente = totalCommissionNonConfirmee * TAUX_COMMISSION;

  const retraitsCommissionConfirmes = state.retraitsCommission.filter((r) => r.statut === 'confirme');
  const retraitsCommissionEnAttente = state.retraitsCommission.filter((r) => r.statut === 'en_attente');
  const totalRetraitCommissionConfirme = retraitsCommissionConfirmes.reduce((s, r) => s + Number(r.montant || 0), 0);
  const totalRetraitCommissionEnAttente = retraitsCommissionEnAttente.reduce((s, r) => s + Number(r.montant || 0), 0);
  const commissionDisponibleRetrait = Math.max(0, CC - totalRetraitCommissionConfirme - totalRetraitCommissionEnAttente);

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
      <div class="soldes-row"><span>Commission inscriptions (30%) : <b id="soldeCommissionInscriptions">0 GNF</b></span></div>
      <div class="soldes-row"><span>Commission intérêts prêts (30%) : <b id="soldeCommissionInterets">0 GNF</b></span></div>
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

function calculerEpargneNetteContrat(contrat) {
  const versements = state.payments.filter((p) => p.contract_id === contrat.id);
  return versements
    .filter((p) => p.statut === 'confirme' && p.jour_numero > 1)
    .reduce((s, p) => s + Number(p.montant || 0), 0);
}

function nbSemainesEntamees(pret) {
  const dateDebut = pret.date_debut && pret.date_debut.toDate ? pret.date_debut.toDate() : new Date();
  return Math.floor((new Date() - dateDebut) / (1000 * 60 * 60 * 24 * 7)) + 1;
}

function calculerMontantDuPret(pret) {
  const nbSemaines = nbSemainesEntamees(pret);
  const montantDuBrut = pret.montant_initial * (1 + pret.taux_hebdo * nbSemaines);
  const dejaRembourse = (state.remboursements || [])
    .filter((r) => r.pret_id === pret.id)
    .reduce((s, r) => s + Number(r.montant || 0), 0);
  return Math.max(0, montantDuBrut - dejaRembourse);
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

// --- Demandes de retrait / prêt des membres de ce collecteur ---
// Chantier "autonomie collecteur" (13 août 2026) : logique reprise telle quelle
// de l'ancien traitement PDG (création du prêt, clôture + reconduction, solde soldé).
function infoTypeRetraitCollecteur(type) {
  const infos = {
    'pret': { libelle: 'Prêt (2%/semaine)', actionLabel: 'Valider comme prêt' },
    'solde_contrat_termine': { libelle: 'Solde de contrat terminé', actionLabel: 'Confirmer' },
    'retrait_final': { libelle: 'Retrait final (clôture)', actionLabel: 'Confirmer' },
  };
  return infos[type] || { libelle: "Retrait d'épargne", actionLabel: 'Confirmer' };
}

function renderDemandesRetrait() {
  let bloc = document.getElementById('blocDemandesRetrait');
  if (!bloc) {
    bloc = document.createElement('div');
    bloc.id = 'blocDemandesRetrait';
    bloc.className = 'card';
    bloc.innerHTML = `
      <h2 style="font-size:15px; margin-bottom:8px;">Demandes de retrait de mes membres</h2>
      <div id="demandesRetraitList"></div>
    `;
    const membersListEl = document.getElementById('membersList');
    membersListEl.parentElement.insertBefore(bloc, membersListEl);

    bloc.addEventListener('click', async (e) => {
      const btnConfirmer = e.target.closest("button[data-action='confirmer-retrait']");
      if (btnConfirmer) {
        await traiterDemandeRetrait(btnConfirmer.dataset.id, 'confirmer');
        return;
      }
      const btnAnnuler = e.target.closest("button[data-action='annuler-retrait']");
      if (btnAnnuler) {
        await traiterDemandeRetrait(btnAnnuler.dataset.id, 'annuler');
      }
    });
  }

  const container = document.getElementById('demandesRetraitList');
  if (state.withdrawalRequests.length === 0) {
    container.innerHTML = '<p style="color:#999; font-size:13px;">Aucune demande en attente.</p>';
    return;
  }

  container.innerHTML = state.withdrawalRequests.map((r) => {
    const info = infoTypeRetraitCollecteur(r.type);
    return `
      <div class="member-row" data-id="${r.id}">
        <div>
          <strong>${r.memberName || 'Membre'}</strong><br>
          <small>${info.libelle} — ${formatGNF(r.montant)}</small>
        </div>
        <div style="text-align:right;">
          <button style="margin-top:4px; width:auto; padding:6px 10px; font-size:13px; background:#198754;"
            data-action="confirmer-retrait" data-id="${r.id}">${info.actionLabel}</button>
          <button style="margin-top:4px; width:auto; padding:6px 10px; font-size:13px; background:#c0392b;"
            data-action="annuler-retrait" data-id="${r.id}">Annuler</button>
        </div>
      </div>
    `;
  }).join('');
}

async function traiterDemandeRetrait(id, action) {
  const retrait = state.withdrawalRequests.find((r) => r.id === id);
  if (!retrait) return;

  if (action === 'annuler') {
    try {
      await updateDoc(doc(db, 'withdrawalRequests', id), {
        statut: 'annule',
        date_annulation: serverTimestamp(),
        annule_par: state.currentCollecteurData.uid,
      });
      notifier('Demande de retrait annulée.', 'succes');
    } catch (err) {
      console.error(err);
      notifier('Erreur : ' + err.message, 'erreur');
    }
    return;
  }

  try {
    if (retrait.type === 'pret') {
      await addDoc(collection(db, 'prets'), {
        membre_id: retrait.memberId,
        collecteur_id: state.currentCollecteurData.uid,
        contract_id: retrait.contractId || null,
        montant_initial: retrait.montant,
        taux_hebdo: 0.02,
        statut: 'actif',
        interet_deja_reconnu: 0,
        date_debut: serverTimestamp(),
      });
      await updateDoc(doc(db, 'withdrawalRequests', id), {
        statut: 'confirme',
        date_confirmation: serverTimestamp(),
      });
      notifier('Prêt validé et enregistré.', 'succes');
    } else if (retrait.type === 'retrait_final') {
      await updateDoc(doc(db, 'withdrawalRequests', id), {
        statut: 'confirme',
        date_confirmation: serverTimestamp(),
      });
      if (retrait.contractId) {
        await updateDoc(doc(db, 'contracts', retrait.contractId), {
          statut: 'cloture',
          epargne_soldee: true,
        });
      }
      await addDoc(collection(db, 'propositions_reconduction'), {
        membre_id: retrait.memberId,
        contrat_precedent_id: retrait.contractId || null,
        statut: 'en_attente',
        date_creation: serverTimestamp(),
      });
      notifier('Retrait confirmé, contrat clôturé. Le membre peut choisir de reconduire.', 'succes');
    } else {
      await updateDoc(doc(db, 'withdrawalRequests', id), {
        statut: 'confirme',
        date_confirmation: serverTimestamp(),
      });
      const contratsNonSoldes = trouverContratsNonSoldes(retrait.memberId, null);
      for (const contrat of contratsNonSoldes) {
        await updateDoc(doc(db, 'contracts', contrat.id), { epargne_soldee: true });
      }
      notifier('Retrait traité.', 'succes');
    }
  } catch (err) {
    console.error(err);
    notifier('Erreur : ' + err.message, 'erreur');
  }
}

function renderMembersList() {
  const container = document.getElementById('membersList');
  container.innerHTML = '';

  const versementsConfirmesTous = state.payments.filter((p) => p.statut === 'confirme');

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
    // Les paiements annulés par le PDG (statut "annule") ne comptent plus
    // dans le nombre de jours payés du contrat (13 août 2026).
    const versements = state.payments.filter((p) => p.contract_id === contrat.id && p.statut !== 'annule');
    const joursPayes = versements.length;
    const estCloture = contrat.statut === 'cloture' || joursPayes >= 31;

    let statut = getStatutContrat(contrat, versements);
    if (!estCloture && calculerStatutContrat(contrat, versementsConfirmesTous) === 'inactif') {
      statut = { texte: 'Inactif', classe: 'late' };
    }
    const pret = (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === 'actif');
    const soldeDisponible = calculerSoldeDisponible(contrat);

    const contratsNonSoldes = trouverContratsNonSoldes(contrat.membre_id, contrat.id);
    const totalNonSolde = contratsNonSoldes.reduce((s, c) => s + Math.max(0, calculerEpargneNetteContrat(c)), 0);

    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `
      <div>
        <strong style="cursor:pointer; text-decoration:underline;" data-membre="${contrat.membre_id}">${contrat.membre_nom || 'Membre'}</strong><br>
        <small>Jour ${joursPayes}/31</small>
        ${pret ? `<br><small style="color:#c0392b;">Prêt en cours : ${formatGNF(calculerMontantDuPret(pret))} · Solde disponible : ${formatGNF(soldeDisponible)}</small>` : ''}
        ${totalNonSolde > 0 ? `<br><small style="color:#c0392b; font-weight:bold;">Contrat non soldé : ${formatGNF(totalNonSolde)}</small>` : ''}
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

function ouvrirPaiement(contratId) {
  const contrat = state.contracts.find((c) => c.id === contratId);
  if (!contrat) return;
  const versements = state.payments.filter((p) => p.contract_id === contratId && p.statut !== 'annule');
  const prochainJour = versements.length + 1;
  const joursRestants = 31 - versements.length;

  if (joursRestants <= 0) {
    notifier('Ce contrat a déjà atteint 31 jours. Démarrez un nouveau contrat.', 'erreur');
    return;
  }

  const montant = prompt(`Montant reçu de ${contrat.membre_nom} (cotisation journalière : ${formatGNF(contrat.montant_mise)}, à partir du jour ${prochainJour}/31) :`);
  if (montant === null) return;
  const montantNum = parseFloat(montant);
  if (isNaN(montantNum) || montantNum <= 0) {
    notifier('Montant invalide.', 'erreur');
    return;
  }
  enregistrerVersement(contrat, montantNum, prochainJour, joursRestants);
}

async function enregistrerVersement(contrat, montantSaisi, jourDepart, joursRestants) {
  try {
    const montantJournalier = Number(contrat.montant_mise) || montantSaisi;
    const joursCouverts = Math.max(1, Math.min(Math.round(montantSaisi / montantJournalier), joursRestants));
    const montantAccepte = joursCouverts * montantJournalier;
    const montantExcedent = montantSaisi - montantAccepte;

    for (let i = 0; i < joursCouverts; i++) {
      await addDoc(collection(db, 'payments'), {
        contract_id: contrat.id,
        collecteur_id: state.currentCollecteurData.uid,
        membre_id: contrat.membre_id,
        montant: montantJournalier,
        jour_numero: jourDepart + i,
        statut: 'confirme',
        date: serverTimestamp(),
      });
    }

    const jourFinal = jourDepart + joursCouverts - 1;
    if (jourFinal >= 31) {
      await updateDoc(doc(db, 'contracts', contrat.id), { statut: 'cloture' });
    }

    if (montantExcedent > 0) {
      notifier(`${joursCouverts} jour(s) enregistré(s) (jour ${jourDepart} à ${jourFinal}) = ${formatGNF(montantAccepte)}. Excédent de ${formatGNF(montantExcedent)} NON enregistré — ouvrez un nouveau contrat pour ce reliquat.`, 'erreur');
    } else {
      notifier(`Versement enregistré : ${joursCouverts} jour(s) couvert(s) (jour ${jourDepart} à ${jourFinal}).`, 'succes');
    }
    afficherRecu({ nom: contrat.membre_nom, montant: montantAccepte, jour: jourFinal, date: new Date() });
  } catch (err) {
    console.error(err);
    notifier('Erreur : ' + err.message, 'erreur');
  }
}

function ouvrirNouveauContrat(membreId, membreNom) {
  ouvrirModal(`
    <h2>Nouveau contrat — ${membreNom}</h2>
    <p class="subtitle-sm">Ce membre a terminé son précédent cycle de 31 jours. Démarrez un nouveau contrat et enregistrez son 1er versement (commission).</p>
    <form id="form-nouveau-contrat">
      <div class="field-row">
        <label>Montant du versement quotidien (GNF)</label>
        <input type="number" name="montantJour" min="1" required />
      </div>
      <div class="field-row">
        <label>Commission encaissée aujourd'hui (jour 1, GNF)</label>
        <input type="number" name="commission" min="1" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="secondary" id="modal-annuler-nouveau-contrat" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Créer le contrat</button>
      </div>
    </form>
  `);
  document.getElementById('modal-annuler-nouveau-contrat').addEventListener('click', fermerModal);
  document.getElementById('form-nouveau-contrat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const montantJour = Number(fd.get('montantJour'));
    const commission = Number(fd.get('commission'));

    try {
      const contratRef = await addDoc(collection(db, 'contracts'), {
        membre_id: membreId,
        membre_nom: membreNom,
        collecteur_id: state.currentCollecteurData.uid,
        statut: 'actif',
        commission,
        montant_mise: montantJour,
        date_debut: new Date().toISOString(),
      });

      await addDoc(collection(db, 'payments'), {
        contract_id: contratRef.id,
        collecteur_id: state.currentCollecteurData.uid,
        membre_id: membreId,
        montant: commission,
        jour_numero: 1,
        statut: 'confirme',
        date: serverTimestamp(),
      });

      notifier('Nouveau contrat créé.', 'succes');
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier('Erreur : ' + err.message, 'erreur');
    }
  });
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

async function enregistrerRemboursement(pret, montant, montantDuAvant) {
  try {
    const nbSemaines = nbSemainesEntamees(pret);
    const interetAccumule = pret.montant_initial * pret.taux_hebdo * nbSemaines;
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

document.getElementById('nouveauMembreBtn').addEventListener('click', () => {
  ouvrirModal(`
    <h2>Nouveau membre</h2>
    <p class="subtitle-sm">Créez le compte du membre et enregistrez son 1er versement (commission). Un mot de passe est généré automatiquement à partir de son numéro de téléphone.</p>
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
    const email = fd.get('email').trim();
    const residence = fd.get('residence').trim();
    const password = genererMotDePasseMembre(telephone);
    const montantJour = Number(fd.get('montantJour'));
    const commission = Number(fd.get('commission'));

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
        statut: 'confirme',
        date: serverTimestamp(),
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

async function afficherDetailsMembre(contrat) {
  const versements = state.payments.filter((p) => p.contract_id === contrat.id && p.statut !== 'annule');
  const versementsConfirmes = versements.filter((p) => p.statut === 'confirme');
  const versementsNonConfirmes = versements.filter((p) => p.statut !== 'confirme');
  const totalConfirme = versementsConfirmes.reduce((s, p) => s + Number(p.montant || 0), 0);
  const totalNonConfirme = versementsNonConfirmes.reduce((s, p) => s + Number(p.montant || 0), 0);
  const commissionConfirmee = versementsConfirmes
    .filter((p) => p.jour_numero === 1)
    .reduce((s, p) => s + Number(p.montant || 0), 0);
  const epargneNette = totalConfirme - commissionConfirmee;
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

  ouvrirModal(`
    <h2>${contrat.membre_nom}</h2>
    <p class="subtitle-sm">Téléphone : ${telephone} · Résidence : ${residence}</p>
    <div class="soldes-row"><span>Épargne nette : <b>${formatGNF(epargneNette > 0 ? epargneNette : 0)}</b></span></div>
    ${pret ? `<div class="soldes-row"><span style="color:#c0392b;">Solde disponible (après prêt)</span><span style="color:#c0392b;"><b>${formatGNF(soldeDisponible)}</b></span></div>` : ''}
    <div class="soldes-row"><span>Versement confirmé : <b>${formatGNF(totalConfirme)}</b></span></div>
    <div class="soldes-row"><span>Versement non confirmé : <b>${formatGNF(totalNonConfirme)}</b></span></div>
    <div class="soldes-row"><span>Montant du versement quotidien : <b>${formatGNF(contrat.montant_mise || 0)}</b></span></div>
    <div class="soldes-row"><span>Jours payés : <b>${versements.length}/31</b></span></div>
    ${totalNonSolde > 0 ? `<div class="soldes-row"><span style="color:#c0392b;">Contrat(s) non soldé(s)</span><span style="color:#c0392b;"><b>${formatGNF(totalNonSolde)}</b></span></div>` : ""}
    <div class="modal-actions">
      <button type="button" class="secondary" id="modal-fermer-details" style="flex:1;">Fermer</button>
    </div>
  `);
  document.getElementById('modal-fermer-details').addEventListener('click', fermerModal);
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
