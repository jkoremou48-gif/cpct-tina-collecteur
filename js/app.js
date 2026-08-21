import {
  auth,
  db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  doc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  serverTimestamp,
  uploaderPhotoProfil,
  changerMotDePasse,
} from "./firebase-config.js";

import {
  formatMontant,
  formatDate,
  formatDateHeure,
  badgeStatut,
  afficherMessage,
  calculerStatutContrat,
} from "./utils.js";

const AVATAR_DEFAUT = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='56'><rect width='56' height='56' fill='%23ddd'/></svg>";

let currentUser = null;
let currentMemberData = null;
let totalConfirmeMembre = 0;
let totalCommissionMembre = 0;
let propositionActuelle = null;
let pretActif = null;
let contratActifMembre = null;
let versementsConfirmesMembre = [];
let contratsTousMembre = [];
let demandesRetraitMembre = [];
let tousPaiementsMembre = [];

const loginScreen = document.getElementById('loginScreen');
const loading = document.getElementById('loading');
const dashboard = document.getElementById('dashboard');
const loginError = document.getElementById('loginError');

function telephoneVersEmailTechnique(telephone) {
  const chiffres = telephone.replace(/\D/g, "");
  return `${chiffres}@membre.cpct-tina.local`;
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const telephone = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  loginError.textContent = '';

  if (!telephone || !password) {
    loginError.textContent = 'Veuillez remplir tous les champs.';
    return;
  }

  const email = telephoneVersEmailTechnique(telephone);

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    loginError.textContent = "Téléphone ou mot de passe incorrect.";
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    loginScreen.classList.add('hidden');
    loading.classList.remove('hidden');
    await chargerDonneesMembre(user.uid);
    loading.classList.add('hidden');
    dashboard.classList.remove('hidden');
    ajouterBoutonChangerMotDePasse();
  } else {
    currentUser = null;
    dashboard.classList.add('hidden');
    loading.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  }
});

// --- Photo de profil ---
document.getElementById('membre-avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !currentUser) return;
  try {
    const url = await uploaderPhotoProfil(currentUser.uid, file);
    await updateDoc(doc(db, 'users', currentUser.uid), { photoURL: url });
    if (currentMemberData) currentMemberData.photoURL = url;
    document.getElementById('membre-avatar').src = url;
    afficherMessage('retraitMsg', 'Photo de profil mise à jour.', 'green');
  } catch (err) {
    console.error(err);
    afficherMessage('retraitMsg', "Erreur lors de l'envoi de la photo : " + err.message, 'red');
  }
});

// --- Changement de mot de passe ---
function ajouterBoutonChangerMotDePasse() {
  if (document.getElementById('btn-changer-mdp')) return;
  const btnLogout = document.getElementById('logoutBtn');
  if (!btnLogout) return;
  btnLogout.insertAdjacentHTML(
    'beforebegin',
    `<button type="button" id="btn-changer-mdp" style="width:auto; margin-right:8px;">Changer mon mot de passe</button>`
  );
  document.getElementById('btn-changer-mdp').addEventListener('click', ouvrirChangementMotDePasse);
}

function ouvrirChangementMotDePasseModal(html) {
  let overlay = document.getElementById('modal-overlay-mdp');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-overlay-mdp';
    Object.assign(overlay.style, {
      position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
      background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', zIndex: 1000,
    });
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target.id === 'modal-overlay-mdp') overlay.remove();
    });
  }
  const carte = document.createElement('div');
  Object.assign(carte.style, {
    background: 'white', borderRadius: '12px', padding: '24px',
    width: '85%', maxWidth: '350px',
  });
  carte.innerHTML = html;
  overlay.innerHTML = '';
  overlay.appendChild(carte);
  return overlay;
}

function ouvrirChangementMotDePasse() {
  const overlay = ouvrirChangementMotDePasseModal(`
    <h2 style="color:#0d6efd;">Changer mon mot de passe</h2>
    <p style="color:#666; font-size:13px; margin-bottom:12px;">Confirmez votre mot de passe actuel puis saisissez le nouveau.</p>
    <form id="form-changer-mdp">
      <label style="display:block; margin-bottom:10px;">Mot de passe actuel
        <input type="password" name="ancien" required style="width:100%; margin-top:4px;" />
      </label>
      <label style="display:block; margin-bottom:10px;">Nouveau mot de passe (6 caractères min)
        <input type="password" name="nouveau" minlength="6" required style="width:100%; margin-top:4px;" />
      </label>
      <label style="display:block; margin-bottom:14px;">Confirmer le nouveau mot de passe
        <input type="password" name="confirmation" minlength="6" required style="width:100%; margin-top:4px;" />
      </label>
      <div id="changer-mdp-msg" style="font-size:13px; margin-bottom:10px;"></div>
      <div style="display:flex; gap:8px;">
        <button type="button" id="btn-annuler-mdp" style="flex:1;">Annuler</button>
        <button type="submit" style="flex:1;">Confirmer</button>
      </div>
    </form>
  `);
  document.getElementById('btn-annuler-mdp').addEventListener('click', () => overlay.remove());
  document.getElementById('form-changer-mdp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const ancien = fd.get('ancien');
    const nouveau = fd.get('nouveau');
    const confirmation = fd.get('confirmation');
    const msgZone = document.getElementById('changer-mdp-msg');

    if (nouveau !== confirmation) {
      msgZone.textContent = 'Les deux mots de passe ne correspondent pas.';
      msgZone.style.color = 'red';
      return;
    }

    try {
      const emailTechnique = telephoneVersEmailTechnique(currentMemberData.telephone);
      await changerMotDePasse(emailTechnique, ancien, nouveau);
      msgZone.textContent = 'Mot de passe modifié avec succès.';
      msgZone.style.color = 'green';
      setTimeout(() => overlay.remove(), 1200);
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        msgZone.textContent = 'Mot de passe actuel incorrect.';
      } else {
        msgZone.textContent = 'Erreur : ' + err.message;
      }
      msgZone.style.color = 'red';
    }
  });
}

async function chargerDonneesMembre(uid) {
  try {
    const memberRef = doc(db, 'users', uid);
    const memberSnap = await getDoc(memberRef);

    if (memberSnap.exists()) {
      currentMemberData = memberSnap.data();
      document.getElementById('memberName').textContent = currentMemberData.nom || 'Membre';
      document.getElementById('membre-avatar').src = currentMemberData.photoURL || AVATAR_DEFAUT;

      if (currentMemberData.parrain_id) {
        const collecteurSnap = await getDoc(doc(db, 'users', currentMemberData.parrain_id));
        if (collecteurSnap.exists()) {
          const collecteur = collecteurSnap.data();
          document.getElementById('collecteurNom').textContent = collecteur.nom || '';
          document.getElementById('collecteurTelephone').textContent = collecteur.telephone || '';
        }
      }
    } else {
      document.getElementById('memberName').textContent = 'Membre';
      document.getElementById('membre-avatar').src = AVATAR_DEFAUT;
    }
    ecouterCotisations(uid);
    ecouterContratsMembre(uid);
    ecouterHistoriqueRetraits(uid);
    ecouterPretActif(uid);
    ecouterPropositionReconduction(uid);

  } catch (err) {
    console.error('Erreur chargement membre :', err);
  }
}

function ecouterContratsMembre(uid) {
  const q = query(
    collection(db, 'contracts'),
    where('membre_id', '==', uid)
  );

  onSnapshot(q, (snapshot) => {
    totalCommissionMembre = snapshot.docs.reduce(
      (s, d) => s + Number(d.data().commission || 0), 0
    );
    const contrats = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    contratsTousMembre = contrats;
    contratActifMembre = contrats.find((c) => c.statut === 'actif') || null;
    rafraichirCotisations();
    mettreAJourBadgeInactif();
    mettreAJourContratNonSolde();
  });
}

function recalculerSolde() {
  const pretDu = calculerMontantDuPretActif();
  const solde = totalConfirmeMembre - pretDu;
  document.getElementById('soldeMembre').textContent = formatMontant(solde > 0 ? solde : 0);
}

function mettreAJourBadgeInactif() {
  const badge = document.getElementById('badgeInactif');
  if (!badge) return;
  const statut = calculerStatutContrat(contratActifMembre, versementsConfirmesMembre);
  badge.classList.toggle('hidden', statut !== 'inactif');
}

function calculerEpargneNetteContratLocal(contratId) {
  return versementsConfirmesMembre
    .filter((v) => v.contract_id === contratId && v.jour_numero !== 1)
    .reduce((s, v) => s + Number(v.montant || 0), 0);
}

function calculerMontantDuPretActif() {
  if (!pretActif) return 0;
  const dateDebut = pretActif.date_debut && pretActif.date_debut.toDate ? pretActif.date_debut.toDate() : new Date();
  const nbSemaines = Math.floor((new Date() - dateDebut) / (1000 * 60 * 60 * 24 * 7)) + 1;
  const montantDuBrut = pretActif.montant_initial * (1 + pretActif.taux_hebdo * nbSemaines);
  return Math.max(0, montantDuBrut);
}

function calculerSoldeDisponible() {
  const epargneNette = contratActifMembre ? calculerEpargneNetteContratLocal(contratActifMembre.id) : 0;
  const pretDu = calculerMontantDuPretActif();
  return Math.max(0, epargneNette - pretDu);
}

// --- Calcul du solde des anciens contrats clôturés, non encore soldés ---
// Réutilisé à la fois par l'affichage informatif ET par evaluerCasRetrait(),
// pour éviter toute divergence entre ce qui est affiché et ce qui est réellement autorisé.
function calculerAnciensContratsNonSoldes() {
  const idContratActif = contratActifMembre ? contratActifMembre.id : null;
  const anciensNonSoldes = contratsTousMembre.filter((c) =>
    c.statut === 'cloture' && !c.epargne_soldee && c.id !== idContratActif
  );
  const total = anciensNonSoldes.reduce(
    (s, c) => s + Math.max(0, calculerEpargneNetteContratLocal(c.id)), 0
  );
  return { anciensNonSoldes, total };
}

// --- Contrat(s) non soldé(s) : informatif uniquement, le retrait se fait via "Demander un retrait" ---
function mettreAJourContratNonSolde() {
  const zone = document.getElementById('contratNonSoldeZone');
  if (!zone) return;

  const { total: totalNonSolde } = calculerAnciensContratsNonSoldes();

  if (totalNonSolde > 0) {
    zone.innerHTML = `
      <div class="pret-card" style="border-left-color:#c0392b;">
        <p><strong style="color:#c0392b;">Contrat(s) non soldé(s)</strong></p>
        <p>Épargne non retirée d'ancien(s) contrat(s) : <strong>${formatMontant(totalNonSolde)}</strong></p>
        <p style="font-size:12px; color:#999;">Pour la retirer, tapez ce montant dans "Demander un retrait" ci-dessous.</p>
      </div>
    `;
  } else {
    zone.innerHTML = '';
  }
}

function ecouterPretActif(uid) {
  const q = query(
    collection(db, 'prets'),
    where('membre_id', '==', uid),
    where('statut', '==', 'actif')
  );
  onSnapshot(q, (snapshot) => {
    if (snapshot.empty) {
      pretActif = null;
      afficherPretActif();
      recalculerSolde();
      return;
    }
    const d = snapshot.docs[0];
    pretActif = { id: d.id, ...d.data() };
    afficherPretActif();
    recalculerSolde();
  });
}

function afficherPretActif() {
  const zone = document.getElementById('pretZone');
  if (!zone) return;
  if (!pretActif) {
    zone.innerHTML = '';
    return;
  }
  const montantDu = calculerMontantDuPretActif();
  zone.innerHTML = `
    <div class="pret-card">
      <p><strong>Prêt en cours</strong></p>
      <p>Capital emprunté : ${formatMontant(pretActif.montant_initial)}</p>
      <p>Montant dû actuellement (2%/semaine) : <strong>${formatMontant(montantDu)}</strong></p>
      <p style="font-size:12px; color:#c0392b;">Aucune nouvelle demande de prêt ou de retrait n'est possible tant que ce prêt n'est pas totalement remboursé.</p>
    </div>
  `;
}

function ecouterPropositionReconduction(uid) {
  const q = query(
    collection(db, 'propositions_reconduction'),
    where('membre_id', '==', uid),
    where('statut', '==', 'en_attente')
  );
  onSnapshot(q, (snapshot) => {
    if (snapshot.empty) {
      propositionActuelle = null;
      afficherPropositionReconduction();
      return;
    }
    const d = snapshot.docs[0];
    propositionActuelle = { id: d.id, ...d.data() };
    afficherPropositionReconduction();
  });
}

function afficherPropositionReconduction() {
  const zone = document.getElementById('propositionZone');
  if (!zone) return;
  if (!propositionActuelle) {
    zone.innerHTML = '';
    return;
  }
  zone.innerHTML = `
    <div class="proposition-card">
      <p><strong>Votre contrat est arrivé à son terme.</strong></p>
      <p>Souhaitez-vous reconduire votre épargne ?</p>
      <button id="btn-reconduire-memes-termes">Reconduire aux mêmes conditions</button>
      <button id="btn-reconduire-modifie">Reconduire avec modification</button>
      <button id="btn-refuser-reconduction">Ne pas reconduire</button>
    </div>
  `;
  document.getElementById('btn-reconduire-memes-termes').addEventListener('click', () => repondreProposition('reconduit_meme_termes'));
  document.getElementById('btn-reconduire-modifie').addEventListener('click', ouvrirModificationMontant);
  document.getElementById('btn-refuser-reconduction').addEventListener('click', () => repondreProposition('refuse'));
}

function ecouterCotisations(uid) {
  const q = query(
    collection(db, 'payments'),
    where('membre_id', '==', uid)
  );

  onSnapshot(q, (snapshot) => {
    tousPaiementsMembre = snapshot.docs.map((d) => d.data());
    versementsConfirmesMembre = tousPaiementsMembre.filter((d) => d.statut === 'confirme');
    rafraichirCotisations();
    mettreAJourBadgeInactif();
    mettreAJourContratNonSolde();
  });
}

function rafraichirCotisations() {
  const list = document.getElementById('cotisationsList');

  if (!contratActifMembre) {
    totalConfirmeMembre = 0;
    list.innerHTML = '<p style="color:#999; font-size:13px;">Aucun contrat en cours.</p>';
    recalculerSolde();
    return;
  }

  const docsDuContrat = tousPaiementsMembre
    .filter((d) => d.contract_id === contratActifMembre.id)
    .sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0));

  totalConfirmeMembre = docsDuContrat
    .filter((d) => d.statut === 'confirme' && d.jour_numero !== 1)
    .reduce((s, d) => s + Number(d.montant || 0), 0);
  recalculerSolde();

  if (docsDuContrat.length === 0) {
    list.innerHTML = '<p style="color:#999; font-size:13px;">Aucune cotisation enregistrée.</p>';
    return;
  }

  list.innerHTML = '';
  docsDuContrat.forEach((data) => {
    const row = document.createElement('div');
    row.className = 'cotis-row';
    row.innerHTML = `
      <span>${formatDate(data.date)}</span>
      <span>${formatMontant(data.montant)}</span>
    `;
    list.appendChild(row);
  });
}

function libelleTypeRetrait(type) {
  const labels = {
    'pret': 'Prêt (en cours de contrat)',
    'solde_contrat_termine': 'Solde de contrat terminé',
    'retrait_final': 'Retrait final (clôture du contrat)',
  };
  return labels[type] || 'Retrait';
}

function ecouterHistoriqueRetraits(uid) {
  const q = query(
    collection(db, 'withdrawalRequests'),
    where('memberId', '==', uid)
  );

  onSnapshot(q, (snapshot) => {
    const list = document.getElementById('withdrawalHistory');
    list.innerHTML = '';

    demandesRetraitMembre = snapshot.docs.map((d) => d.data());
    mettreAJourContratNonSolde();

    if (snapshot.empty) {
      list.innerHTML = '<p style="color:#999; font-size:13px;">Aucune demande pour le moment.</p>';
      return;
    }

    const docs = [...demandesRetraitMembre]
      .sort((a, b) => (b.dateCreation?.toMillis?.() || 0) - (a.dateCreation?.toMillis?.() || 0));

    docs.forEach((data) => {
      const row = document.createElement('div');
      row.className = 'cotis-row';
      row.innerHTML = `
        <span>${formatMontant(data.montant)} — <small>${libelleTypeRetrait(data.type)}</small><br>
        <small style="color:#999;">${formatDateHeure(data.dateCreation)}</small></span>
        ${badgeStatut(data.statut)}
      `;
      list.appendChild(row);
    });
  });
}

// --- CORRECTIF (21 août 2026) ---
// Bug : un membre SANS contrat actif (uniquement un ancien contrat clôturé non soldé)
// se voyait systématiquement rejeté avec "Vous n'avez aucun contrat en cours.",
// car ce test intervenait avant même le calcul du solde des anciens contrats non soldés.
// Résultat : impossible de demander le retrait d'une épargne d'ancien contrat
// une fois le contrat actif terminé/absent, alors que le message affiché à l'écran
// invite justement à le faire via "Demander un retrait".
//
// Correction : le solde des anciens contrats non soldés est désormais calculé AVANT
// le test d'absence de contrat actif, et un cas dédié gère la demande de retrait
// de ce solde même sans contrat actif.
function evaluerCasRetrait(montant) {
  // Règle absolue : tant qu'un prêt actif n'est pas totalement remboursé (capital + intérêt),
  // aucune nouvelle demande de retrait ou de prêt n'est autorisée, quel que soit le montant.
  if (pretActif) {
    const montantDu = calculerMontantDuPretActif();
    return {
      decision: 'rejet',
      message: `Vous avez déjà un prêt en cours (${formatMontant(montantDu)} dû). Aucune nouvelle demande de retrait ou de prêt n'est possible tant qu'il n'est pas totalement remboursé.`,
    };
  }

  const { anciensNonSoldes, total: ancienSolde } = calculerAnciensContratsNonSoldes();

  // Cas 1 : pas de contrat actif. Seul un retrait sur le solde d'anciens contrats
  // non soldés est envisageable.
  if (!contratActifMembre) {
    if (ancienSolde === 0) {
      return { decision: 'rejet', message: "Vous n'avez aucun contrat en cours." };
    }
    if (montant > ancienSolde) {
      return { decision: 'rejet', message: `Retrait impossible : votre ancien solde non soldé (${formatMontant(ancienSolde)}) est insuffisant pour couvrir ce montant.` };
    }
    return {
      decision: 'accepte',
      type: 'solde_contrat_termine',
      contratId: anciensNonSoldes.length > 0 ? anciensNonSoldes[0].id : null,
      message: 'Demande envoyée à votre collecteur : ce retrait sera traité comme un solde de contrat terminé.',
    };
  }

  // Cas 2 : contrat actif présent (logique inchangée)
  const epargneNette = calculerEpargneNetteContratLocal(contratActifMembre.id);

  if (montant > epargneNette) {
    if (ancienSolde === 0) {
      return { decision: 'rejet', message: "Retrait impossible : le montant dépasse votre épargne nette actuelle et vous n'avez aucun ancien contrat non soldé." };
    }
    if (ancienSolde < montant) {
      return { decision: 'rejet', message: `Retrait impossible : votre ancien solde non soldé (${formatMontant(ancienSolde)}) est insuffisant pour couvrir ce montant.` };
    }
    return {
      decision: 'accepte',
      type: 'solde_contrat_termine',
      contratId: contratActifMembre.id,
      message: 'Demande envoyée à votre collecteur : ce retrait sera traité comme un solde de contrat terminé.',
    };
  }

  if (montant === epargneNette && ancienSolde === 0) {
    return {
      decision: 'accepte',
      type: 'retrait_final',
      contratId: contratActifMembre.id,
      message: 'Demande envoyée à votre collecteur : ce retrait clôturera votre contrat en cours si votre collecteur la confirme.',
    };
  }

  return {
    decision: 'accepte',
    type: 'pret',
    contratId: contratActifMembre.id,
    message: 'Demande envoyée à votre collecteur : ce retrait sera traité comme un prêt à 2%/semaine, en attente de sa validation.',
  };
}

document.getElementById('demandeRetraitBtn').addEventListener('click', async () => {
  const montantInput = document.getElementById('montantRetrait');
  const montant = parseFloat(montantInput.value);
  const retraitMsg = document.getElementById('retraitMsg');
  retraitMsg.textContent = '';

  if (!montant || montant <= 0) {
    afficherMessage('retraitMsg', 'Veuillez entrer un montant valide.', 'red');
    return;
  }

  if (!currentMemberData || !currentMemberData.parrain_id) {
    afficherMessage('retraitMsg', "Aucun collecteur n'est rattaché à votre compte. Contactez le PDG.", 'red');
    return;
  }

  const demandeDejaEnCours = demandesRetraitMembre.some((d) => d.statut === 'en_attente');
  if (demandeDejaEnCours) {
    afficherMessage('retraitMsg', 'Vous avez déjà une demande en attente. Attendez son traitement avant d\'en envoyer une nouvelle.', 'red');
    return;
  }

  const resultat = evaluerCasRetrait(montant);

  if (resultat.decision === 'rejet') {
    afficherMessage('retraitMsg', resultat.message, 'red');
    return;
  }

  try {
    await addDoc(collection(db, 'withdrawalRequests'), {
      memberId: currentUser.uid,
      memberName: currentMemberData ? currentMemberData.nom : '',
      // Chantier "autonomie collecteur" (13 août 2026) : la demande est routée
      // directement vers le collecteur du membre, qui la confirme ou l'annule.
      collecteur_id: currentMemberData.parrain_id,
      montant: montant,
      statut: 'en_attente',
      type: resultat.type,
      contractId: resultat.contratId,
      dateCreation: serverTimestamp(),
    });
    afficherMessage('retraitMsg', resultat.message, 'green');
    montantInput.value = '';
  } catch (err) {
    console.error('Erreur demande de retrait :', err);
    afficherMessage('retraitMsg', "Erreur lors de l'envoi de la demande.", 'red');
  }
});

async function repondreProposition(choix) {
  if (!propositionActuelle) return;
  try {
    await updateDoc(doc(db, 'propositions_reconduction', propositionActuelle.id), {
      statut: choix,
      date_reponse: serverTimestamp(),
    });
    afficherMessage('retraitMsg', 'Votre réponse a été enregistrée.', 'green');
  } catch (err) {
    console.error('Erreur réponse proposition :', err);
    afficherMessage('retraitMsg', "Erreur lors de l'envoi de votre réponse.", 'red');
  }
}

function ouvrirModificationMontant() {
  const nouveauMontant = prompt('Quel nouveau montant de versement quotidien souhaitez-vous ? (GNF)');
  if (nouveauMontant === null) return;
  const montantNum = parseFloat(nouveauMontant);
  if (isNaN(montantNum) || montantNum <= 0) {
    afficherMessage('retraitMsg', 'Montant invalide.', 'red');
    return;
  }
  enregistrerModificationMontant(montantNum);
}

async function enregistrerModificationMontant(nouveauMontant) {
  if (!propositionActuelle) return;
  try {
    await updateDoc(doc(db, 'propositions_reconduction', propositionActuelle.id), {
      statut: 'reconduit_modifie',
      nouveau_montant_mise: nouveauMontant,
      date_reponse: serverTimestamp(),
    });
    afficherMessage('retraitMsg', 'Votre demande de modification a été envoyée au PDG.', 'green');
  } catch (err) {
    console.error('Erreur modification montant :', err);
    afficherMessage('retraitMsg', "Erreur lors de l'envoi de votre demande.", 'red');
  }
}

// --- Dépliants ---
document.getElementById('titre-cotisations').addEventListener('click', () => {
  document.getElementById('cotisationsList').classList.toggle('hidden');
  document.getElementById('titre-cotisations').classList.toggle('ouvert');
});
document.getElementById('titre-historique-demandes').addEventListener('click', () => {
  document.getElementById('withdrawalHistory').classList.toggle('hidden');
  document.getElementById('titre-historique-demandes').classList.toggle('ouvert');
});
