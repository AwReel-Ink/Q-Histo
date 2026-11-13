/*!
 * sync-maison.js — synchronisation des applis avec le serveur maison (PocketBase)
 * Version 1.3 — à copier tel quel dans chaque appli, ne pas modifier.
 *
 * Deux modes :
 *  - "complet" : chaque enregistrement est synchronisé (ajouts, modifications, suppressions)
 *  - "simple"  : l'appli envoie une sauvegarde complète quand ses données changent,
 *                et peut la récupérer depuis le serveur
 *
 * L'adresse du serveur, le compte et le nom de l'appareil sont communs à toutes les
 * applis publiées sur le même site (localStorage partagé) : on les saisit une seule fois.
 *
 * Utilisation (voir le guide d'intégration) :
 *   SyncMaison.configurer({ app, nom, mode, ... });
 *   SyncMaison.modifie(store, enregistrement);   // après chaque enregistrement local
 *   SyncMaison.supprime(store, id);              // après chaque suppression locale
 *   SyncMaison.ouvrirReglages();                 // bouton « Serveur maison » des paramètres
 */
(function (global) {
  'use strict';

  const VERSION = '1.3';
  const CLES = {
    serveur: 'maison.serveur',
    jeton: 'maison.jeton',
    compte: 'maison.compte',
    jetonDate: 'maison.jetonDate',
    appareil: 'maison.appareil',
  };
  const DELAI_SANTE = 4000;      // ms pour savoir si on est à la maison
  const DELAI_REQUETE = 30000;   // ms par requête
  const PAR_PAGE = 200;
  const ANTI_REBOND = 4000;      // ms entre une modification et l'envoi
  const RELANCE_MIN = 30000;     // ms minimum entre deux synchros automatiques

  // ---------------------------------------------------------------------------
  // Petits outils
  // ---------------------------------------------------------------------------
  class ErreurMaison extends Error {
    constructor(code, message, statut) {
      super(message);
      this.code = code;     // 'hors-maison' | 'non-connecte' | 'serveur' | 'configuration'
      this.statut = statut || 0;
    }
  }

  const memoireLocale = {
    get(cle) { try { return global.localStorage.getItem(cle); } catch (_) { return null; } },
    set(cle, val) { try { global.localStorage.setItem(cle, val); } catch (_) { /* plein ou bloqué */ } },
    del(cle) { try { global.localStorage.removeItem(cle); } catch (_) { /* rien */ } },
  };

  function normaliserAdresse(adresse) {
    let a = String(adresse || '').trim();
    if (!a) return '';
    if (!/^https?:\/\//i.test(a)) a = 'http://' + a;
    return a.replace(/\/+$/, '');
  }

  function besoinAnnotationLocale(adresse) {
    let hote = '';
    try { hote = new URL(adresse).hostname.toLowerCase(); } catch (_) { return false; }
    if (hote === 'localhost' || hote.endsWith('.local')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hote)) return false;   // IPv4
    if (hote.startsWith('[') || hote.includes(':')) return false; // IPv6
    return true;
  }

  // updatedAt peut être un nombre (ms) ou un texte de date ISO ("2026-11-12T21:55:00Z")
  function horodatage(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
    return 0;
  }

  function estBlob(v) { return typeof Blob !== 'undefined' && v instanceof Blob; }

  async function empreinte(blob) {
    const octets = new Uint8Array(await blob.arrayBuffer());
    if (global.crypto && global.crypto.subtle) {
      const h = await global.crypto.subtle.digest('SHA-256', octets);
      return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 2166136261; // repli FNV-1a si crypto.subtle est absent
    for (const b of octets) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
    return 'fnv' + h.toString(16) + '-' + octets.length;
  }

  function idAleatoire() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function nomAppareilParDefaut() {
    const ua = (global.navigator && global.navigator.userAgent) || '';
    const systeme = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS'
      : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Appareil';
    const nav = (global.navigator && global.navigator.brave) || /Brave/i.test(ua) ? 'Brave' : /Firefox/i.test(ua) ? 'Firefox' : /Edg\//i.test(ua) ? 'Edge'
      : /Chrome/i.test(ua) ? 'Chrome' : /Safari/i.test(ua) ? 'Safari' : '';
    return (systeme + (nav ? ' ' + nav : '')).trim();
  }

  // Remplace les Blob/File d'un objet par des marqueurs, et renvoie la liste des fichiers.
  function extraireFichiers(valeur) {
    const fichiers = [];
    function parcourir(v) {
      if (estBlob(v)) {
        const marque = 'c' + fichiers.length;
        fichiers.push({ marque, blob: v });
        const m = { __fichier: marque, type: v.type || '' };
        if (typeof File !== 'undefined' && v instanceof File) m.nom = v.name;
        return m;
      }
      if (Array.isArray(v)) return v.map(parcourir);
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = {};
        for (const k of Object.keys(v)) o[k] = parcourir(v[k]);
        return o;
      }
      if (v instanceof Date) return { __date: v.toISOString() };
      return v;
    }
    return { donnees: parcourir(valeur), fichiers };
  }

  // Remet les fichiers (téléchargés via charger(nomServeur)) à la place des marqueurs.
  async function remettreFichiers(valeur, nomsServeur, charger) {
    async function parcourir(v) {
      if (Array.isArray(v)) return Promise.all(v.map(parcourir));
      if (v && typeof v === 'object') {
        if (typeof v.__date === 'string' && Object.keys(v).length === 1) return new Date(v.__date);
        if (typeof v.__fichier === 'string') {
          const nom = (nomsServeur || []).find((n) => n.startsWith('maison' + v.__fichier + '_'));
          if (!nom) return null;
          const blob = await charger(nom, v.type);
          if (v.nom && typeof File !== 'undefined') return new File([blob], v.nom, { type: v.type || blob.type });
          return blob;
        }
        const o = {};
        for (const k of Object.keys(v)) o[k] = await parcourir(v[k]);
        return o;
      }
      return v;
    }
    return parcourir(valeur);
  }

  // ---------------------------------------------------------------------------
  // Mémoire de synchro de l'appli (IndexedDB « sync-maison-<app> »)
  //   attente : modifications locales pas encore envoyées
  //   liens   : correspondance enregistrement local ↔ ligne du serveur
  //   etat    : curseur de synchro, empreinte de la dernière sauvegarde…
  // ---------------------------------------------------------------------------
  function baseIndexedDB(app) {
    let promesse = null;
    function ouvrir() {
      if (!promesse) {
        promesse = new Promise((resolve, reject) => {
          const req = global.indexedDB.open('sync-maison-' + app, 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            for (const nom of ['attente', 'liens', 'etat']) {
              if (!db.objectStoreNames.contains(nom)) db.createObjectStore(nom, { keyPath: 'cle' });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return promesse;
    }
    async function op(store, mode, action) {
      const db = await ouvrir();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = action(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    return {
      get: (store, cle) => op(store, 'readonly', (s) => s.get(cle)),
      put: (store, obj) => op(store, 'readwrite', (s) => s.put(obj)),
      del: (store, cle) => op(store, 'readwrite', (s) => s.delete(cle)),
      tout: (store) => op(store, 'readonly', (s) => s.getAll()),
      compter: (store) => op(store, 'readonly', (s) => s.count()),
    };
  }

  // ---------------------------------------------------------------------------
  // Une instance de synchro par appli
  // ---------------------------------------------------------------------------
  function creer(config) {
    const c = Object.assign({ mode: 'complet', cle: 'id', stores: [] }, config || {});
    if (!c.app || !/^[a-z0-9_]+$/.test(c.app)) throw new Error('SyncMaison : « app » doit être le nom de la table (ex. "qhisto").');
    c.nom = c.nom || c.app;
    if (c.mode === 'complet') {
      if (!Array.isArray(c.stores) || !c.stores.length) throw new Error('SyncMaison : « stores » est obligatoire en mode complet.');
      if (typeof c.toutLire !== 'function' || typeof c.appliquer !== 'function') {
        throw new Error('SyncMaison : « toutLire » et « appliquer » sont obligatoires en mode complet.');
      }
    } else if (c.mode === 'simple') {
      if (typeof c.exporter !== 'function' || typeof c.importer !== 'function') {
        throw new Error('SyncMaison : « exporter » et « importer » sont obligatoires en mode simple.');
      }
    } else {
      throw new Error('SyncMaison : « mode » doit être "complet" ou "simple".');
    }
    if (c.copie && typeof c.copie.exporter !== 'function') {
      throw new Error('SyncMaison : « copie.exporter » doit être une fonction.');
    }

    const local = c._memoireLocale || memoireLocale;
    const base = c._base || baseIndexedDB(c.app);
    const auditeurs = new Set();
    let etat = { statut: 'inactif', message: '', derniere: null, enAttente: 0 };
    let enCours = null;
    let relance = null;
    let minuterie = null;
    let derniereTentative = 0;

    // --- réglages partagés -------------------------------------------------
    const reglages = {
      serveur: () => normaliserAdresse(local.get(CLES.serveur)),
      jeton: () => local.get(CLES.jeton) || '',
      compte: () => local.get(CLES.compte) || '',
      appareil() {
        let a = null;
        try { a = JSON.parse(local.get(CLES.appareil) || 'null'); } catch (_) { a = null; }
        if (!a || !a.id) {
          a = { id: idAleatoire(), nom: nomAppareilParDefaut() };
          local.set(CLES.appareil, JSON.stringify(a));
        }
        return a;
      },
    };
    function etiquetteAppareil() { const a = reglages.appareil(); return `${a.nom} (${a.id.slice(0, 8)})`; }

    function changerEtat(maj) {
      etat = Object.assign({}, etat, maj);
      for (const f of auditeurs) { try { f(etat); } catch (_) { /* rien */ } }
    }
    async function rafraichirCompteur() {
      if (c.mode !== 'complet') return;
      try { changerEtat({ enAttente: await base.compter('attente') }); } catch (_) { /* rien */ }
    }

    // --- accès au serveur ----------------------------------------------------
    async function requete(chemin, options, delai) {
      const serveur = (options && options.serveur) || reglages.serveur();
      if (!serveur) throw new ErreurMaison('configuration', "Adresse du serveur non renseignée.");
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const minut = ctrl ? setTimeout(() => ctrl.abort(), delai || DELAI_REQUETE) : null;
      const entetes = Object.assign({}, (options && options.headers) || {});
      const jeton = reglages.jeton();
      if (jeton && !(options && options.sansJeton)) entetes.Authorization = jeton;
      const init = {
        method: (options && options.method) || 'GET',
        headers: entetes,
        body: options && options.body,
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined,
      };
      // Chrome reconnaît seul une IP privée (192.168…) ou un nom en .local.
      // Pour un autre nom (ex. serveur.maison) il faut préciser que la cible est locale ;
      // à ne pas mettre pour localhost/127.0.0.1, sinon Chrome bloque la requête.
      if (besoinAnnotationLocale(serveur)) init.targetAddressSpace = 'local';
      let rep;
      try {
        rep = await fetch(serveur + chemin, init);
      } catch (err) {
        throw new ErreurMaison('hors-maison', 'Serveur injoignable (hors de la maison ?)');
      } finally {
        if (minut) clearTimeout(minut);
      }
      if (options && options.brut) {
        if (!rep.ok) throw new ErreurMaison('serveur', `Erreur ${rep.status}`, rep.status);
        return rep;
      }
      let corps = null;
      try { corps = await rep.json(); } catch (_) { corps = null; }
      if (rep.status === 401 || (rep.status === 403 && !jeton)) {
        throw new ErreurMaison('non-connecte', 'Connexion au compte nécessaire.', rep.status);
      }
      if (!rep.ok) {
        throw new ErreurMaison('serveur', (corps && corps.message) || `Erreur ${rep.status}`, rep.status);
      }
      return corps;
    }

    function json(corps) {
      return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) };
    }

    async function verifierPresence(adresse) {
      const debut = Date.now();
      await requete('/api/health', { serveur: normaliserAdresse(adresse) || undefined, sansJeton: true }, DELAI_SANTE);
      return Date.now() - debut;
    }

    // Vérifie le compte à chaque synchro (un jeton invalide renverrait des listes vides
    // sans erreur) et prolonge sa validité.
    async function rafraichirJeton() {
      const r = await requete('/api/collections/users/auth-refresh', { method: 'POST' });
      if (r && r.token) { local.set(CLES.jeton, r.token); local.set(CLES.jetonDate, String(Date.now())); }
    }

    async function jetonFichiers() {
      const r = await requete('/api/files/token', { method: 'POST' });
      return r.token;
    }

    async function telechargerFichier(table, idLigne, nom, type, jetonF) {
      const rep = await requete(`/api/files/${table}/${idLigne}/${encodeURIComponent(nom)}?token=${encodeURIComponent(jetonF)}`, { brut: true });
      const blob = await rep.blob();
      return type && blob.type !== type ? new Blob([blob], { type }) : blob;
    }

    // --- mode complet --------------------------------------------------------
    function cleDe(store, id) { return store + '\u0001' + id; }
    function idDe(store, enr) {
      const champ = (c.cles && c.cles[store]) || c.cle;
      const id = enr && enr[champ];
      if (id === undefined || id === null || id === '') throw new Error(`SyncMaison : enregistrement sans « ${champ} » dans « ${store} ».`);
      return String(id);
    }

    async function lireEtat(cle, defaut) {
      const e = await base.get('etat', cle);
      return e ? e.valeur : defaut;
    }
    function ecrireEtat(cle, valeur) { return base.put('etat', { cle, valeur }); }

    async function mettreEnAttente(store, id, enr, supprime) {
      const modifie = supprime ? Date.now() : (horodatage(enr && enr.updatedAt) || Date.now());
      await base.put('attente', { cle: cleDe(store, id), store, rid: id, data: supprime ? null : enr, supprime: !!supprime, modifie });
    }

    async function premiereFois() {
      if (await lireEtat('initialise', false)) return;
      for (const store of c.stores) {
        const liste = (await c.toutLire(store)) || [];
        for (const enr of liste) {
          const id = idDe(store, enr);
          if (await base.get('attente', cleDe(store, id))) continue;
          // sans date de modification, on considère la donnée comme ancienne : le serveur gagne
          await base.put('attente', { cle: cleDe(store, id), store, rid: id, data: enr, supprime: false, modifie: horodatage(enr.updatedAt) || 1 });
        }
      }
      await ecrireEtat('initialise', true);
    }

    // Réception par paquets de PAR_PAGE. Le repère (date de mise à jour + id de la dernière
    // ligne reçue) avance à chaque paquet : on redemande toujours « ce qui vient après »,
    // sans numéro de page, pour ne jamais sauter de lignes.
    async function tirer() {
      let recus = 0;
      let pos = await lireEtat('curseur', '');
      if (!pos || typeof pos === 'string') pos = { updated: pos || '', id: '' }; // ancien format (1.0 à 1.2)
      let jetonF = null;
      let total = 0;
      let fait = 0;
      for (let premier = true; ; premier = false) {
        const esc = (v) => String(v).replace(/"/g, '\\"');
        const filtre = pos.updated
          ? `&filter=${encodeURIComponent(`updated > "${esc(pos.updated)}" || (updated = "${esc(pos.updated)}" && id > "${esc(pos.id)}")`)}`
          : '';
        const r = await requete(`/api/collections/${c.app}/records?perPage=${PAR_PAGE}&page=1&sort=updated,id&skipTotal=${premier ? 0 : 1}${filtre}`);
        const lignes = (r && r.items) || [];
        if (premier) total = (r && r.totalItems) || lignes.length;
        const changements = [];
        const liensAPoser = [];
        for (const l of lignes) {
          if (!c.stores.includes(l.store)) continue;
          const cle = cleDe(l.store, l.rid);
          const lien = await base.get('liens', cle);
          if (lien && lien.modifie === l.modifie && lien.pbId === l.id) continue; // version déjà connue
          const attente = await base.get('attente', cle);
          if (attente && attente.modifie > l.modifie) continue; // la version locale est plus récente
          if (attente) await base.del('attente', cle);
          let data = null;
          if (!l.deleted) {
            const noms = l.fichiers || [];
            if (noms.length && !jetonF) jetonF = await jetonFichiers();
            data = await remettreFichiers(l.data, noms, (nom, type) => telechargerFichier(c.app, l.id, nom, type, jetonF));
          }
          changements.push({ store: l.store, id: l.rid, data, modifie: l.modifie });
          liensAPoser.push({ cle, pbId: l.id, modifie: l.modifie });
        }
        if (changements.length) { await c.appliquer(changements); recus += changements.length; }
        for (const lien of liensAPoser) await base.put('liens', lien);
        if (lignes.length) {
          const derniere = lignes[lignes.length - 1];
          pos = { updated: derniere.updated, id: derniere.id };
          await ecrireEtat('curseur', pos);
        }
        fait += lignes.length;
        if (total) changerEtat({ progression: { etape: 'reception', fait: Math.min(fait, total), total } });
        if (lignes.length < PAR_PAGE) break;
      }
      return recus;
    }

    async function chercherLigne(store, rid) {
      const filtre = encodeURIComponent(`store = "${store.replace(/"/g, '\\"')}" && rid = "${rid.replace(/"/g, '\\"')}"`);
      const r = await requete(`/api/collections/${c.app}/records?perPage=1&skipTotal=1&filter=${filtre}`);
      return r && r.items && r.items[0];
    }

    async function envoyerUne(entree) {
      const lien = await base.get('liens', entree.cle);
      const commun = { store: entree.store, rid: entree.rid, modifie: entree.modifie, appareil: etiquetteAppareil(), deleted: entree.supprime };
      let corps;
      if (entree.supprime) {
        corps = json(Object.assign(commun, { data: null, fichiers: [] }));
      } else {
        const { donnees, fichiers } = extraireFichiers(entree.data);
        if (fichiers.length) {
          const fd = new FormData();
          for (const [k, v] of Object.entries(commun)) fd.append(k, String(v));
          fd.append('data', JSON.stringify(donnees));
          for (const f of fichiers) fd.append('fichiers', f.blob, 'maison' + f.marque + '.bin'); // PocketBase ajoute _xxxxxxxxxx au nom
          corps = { body: fd };
        } else {
          corps = json(Object.assign(commun, { data: donnees, fichiers: [] }));
        }
      }

      let pbId = lien && lien.pbId;
      if (!pbId) { const existante = await chercherLigne(entree.store, entree.rid); pbId = existante && existante.id; }
      let resultat;
      try {
        resultat = pbId
          ? await requete(`/api/collections/${c.app}/records/${pbId}`, Object.assign({ method: 'PATCH' }, corps))
          : await requete(`/api/collections/${c.app}/records`, Object.assign({ method: 'POST' }, corps));
      } catch (err) {
        if (err.statut === 404 && pbId) { // la ligne a disparu du serveur : on la recrée
          await base.del('liens', entree.cle);
          resultat = await requete(`/api/collections/${c.app}/records`, Object.assign({ method: 'POST' }, corps));
        } else if (err.statut === 409) {
          return 'serveur-plus-recent';
        } else {
          throw err;
        }
      }
      await base.put('liens', { cle: entree.cle, pbId: resultat.id, modifie: entree.modifie });
      return 'ok';
    }

    async function pousser() {
      let envoyes = 0;
      const entrees = (await base.tout('attente')).sort((a, b) => a.modifie - b.modifie);
      let n = 0;
      for (const e of entrees) {
        n++;
        if (n === 1 || n % 10 === 0 || n === entrees.length) {
          changerEtat({ progression: { etape: 'envoi', fait: n, total: entrees.length } });
        }
        let issue;
        try {
          issue = await envoyerUne(e);
        } catch (err) {
          if (err.code === 'serveur' && err.statut === 400) {
            console.warn('[SyncMaison] refusé par le serveur :', e.store, e.rid, err.message);
            continue; // on garde l'entrée, elle sera retentée
          }
          throw err;
        }
        // on ne retire l'entrée que si elle n'a pas été remodifiée pendant l'envoi
        const actuelle = await base.get('attente', e.cle);
        if (actuelle && actuelle.modifie === e.modifie) await base.del('attente', e.cle);
        if (issue === 'serveur-plus-recent') await ecrireEtat('curseur', ''); // on retirera tout au prochain passage
        else envoyes++;
      }
      return envoyes;
    }

    // --- mode simple ---------------------------------------------------------
    async function contenuExport() {
      const v = await c.exporter();
      if (estBlob(v)) return v;
      if (typeof v === 'string') return new Blob([v], { type: 'application/json' });
      return new Blob([JSON.stringify(v)], { type: 'application/json' });
    }

    async function envoyerSauvegarde(forcer) {
      const blob = await contenuExport();
      const h = await empreinte(blob);
      if (!forcer && h === (await lireEtat('empreinte', ''))) return false;
      const fd = new FormData();
      fd.append('app', c.app);
      fd.append('appareil', etiquetteAppareil());
      fd.append('empreinte', h);
      fd.append('taille', String(blob.size));
      fd.append('fichier', blob, `${c.app}.json`);
      await requete('/api/collections/sauvegardes/records', { method: 'POST', body: fd });
      await ecrireEtat('empreinte', h);
      return true;
    }

    // --- copie lisible (même fichier que l'export manuel) --------------------
    // Envoyée au plus une fois par intervalle (20 h par défaut), seulement si le
    // contenu a changé. Le serveur la range dans exports/<appli>/.
    async function envoyerCopie(forcer) {
      if (!c.copie) return false;
      const intervalle = (c.copie.intervalleHeures != null ? c.copie.intervalleHeures : 20) * 3600 * 1000;
      if (!forcer && Date.now() - (await lireEtat('copieDate', 0)) < intervalle) return false;
      let v = await c.copie.exporter();
      let nom = c.copie.nom || `${c.app}.json`;
      if (v && !estBlob(v) && v.blob) { nom = v.nom || nom; v = v.blob; }
      const blob = estBlob(v) ? v : new Blob([typeof v === 'string' ? v : JSON.stringify(v)], { type: 'application/json' });
      const h = await empreinte(blob);
      if (h === (await lireEtat('copieEmpreinte', ''))) { await ecrireEtat('copieDate', Date.now()); return false; }
      const fd = new FormData();
      fd.append('app', c.app);
      fd.append('appareil', etiquetteAppareil());
      fd.append('empreinte', h);
      fd.append('taille', String(blob.size));
      fd.append('fichier', blob, nom);
      await requete('/api/collections/copies/records', { method: 'POST', body: fd });
      await ecrireEtat('copieEmpreinte', h);
      await ecrireEtat('copieDate', Date.now());
      return true;
    }

    async function listerSauvegardes() {
      const filtre = encodeURIComponent(`app = "${c.app}"`);
      const r = await requete(`/api/collections/sauvegardes/records?perPage=30&sort=-created&skipTotal=1&filter=${filtre}`);
      return ((r && r.items) || []).map((l) => ({ id: l.id, date: l.created, appareil: l.appareil, taille: l.taille, empreinte: l.empreinte, fichier: l.fichier }));
    }

    async function restaurerSauvegarde(id) {
      const l = await requete(`/api/collections/sauvegardes/records/${id}`);
      const jetonF = await jetonFichiers();
      const blob = await telechargerFichier('sauvegardes', l.id, l.fichier, '', jetonF);
      const contenu = c.format === 'blob' ? blob : await blob.text();
      await c.importer(contenu);
      await ecrireEtat('empreinte', l.empreinte || '');
    }

    // --- synchro -------------------------------------------------------------
    async function faireSynchro(options) {
      if (!reglages.serveur()) { changerEtat({ statut: 'non-configure', message: 'Serveur non configuré' }); return etat; }
      if (!reglages.jeton()) { changerEtat({ statut: 'non-connecte', message: 'Compte non connecté' }); return etat; }
      changerEtat({ statut: 'en-cours', message: 'Synchronisation…', progression: null });
      let recus = 0;
      let envoyes = 0;
      try {
        await verifierPresence();
        await rafraichirJeton();
        if (c.mode === 'complet') {
          await premiereFois();
          recus = await tirer();
          envoyes = await pousser();
          try {
            await envoyerCopie(options && options.forcer);
          } catch (err) {
            if (err.code === 'hors-maison' || err.code === 'non-connecte') throw err;
            console.warn('[SyncMaison] copie lisible non envoyée :', err.message || err);
          }
        } else {
          envoyes = (await envoyerSauvegarde(options && options.forcer)) ? 1 : 0;
        }
        const derniere = Date.now();
        await ecrireEtat('derniere', derniere);
        changerEtat({ statut: 'ok', message: 'Synchronisé', derniere, recus, envoyes, progression: null });
      } catch (err) {
        const code = err instanceof ErreurMaison ? err.code : 'erreur';
        const statut = code === 'hors-maison' ? 'hors-maison' : code === 'non-connecte' ? 'non-connecte' : 'erreur';
        if (statut === 'erreur') console.error('[SyncMaison]', err);
        changerEtat({ statut, message: err.message || String(err), progression: null });
      } finally {
        await rafraichirCompteur();
      }
      return etat;
    }

    // Une demande qui arrive pendant une synchro en cours en relance une juste après
    // (la synchro en cours a pu démarrer avant la modification ou hors de la maison).
    function synchroniser(options) {
      derniereTentative = Date.now();
      if (enCours) {
        if (!relance) relance = enCours.then(() => { relance = null; return synchroniser(options); });
        return relance;
      }
      enCours = faireSynchro(options).finally(() => { enCours = null; });
      return enCours;
    }

    function programmer() {
      clearTimeout(minuterie);
      minuterie = setTimeout(() => synchroniser(), ANTI_REBOND);
    }

    // --- interface publique de l'instance -----------------------------------
    const instance = {
      version: VERSION,
      config: c,
      get etat() { return etat; },
      surEtat(f) { auditeurs.add(f); f(etat); return () => auditeurs.delete(f); },

      async modifie(store, enr) {
        if (c.mode !== 'complet') { programmer(); return; }
        await mettreEnAttente(store, idDe(store, enr), enr, false);
        await rafraichirCompteur();
        programmer();
      },
      async supprime(store, id) {
        if (c.mode !== 'complet') { programmer(); return; }
        await mettreEnAttente(store, String(id), null, true);
        await rafraichirCompteur();
        programmer();
      },
      synchroniser,
      tester: (adresse) => verifierPresence(adresse),

      async connecter(adresse, email, motDePasse) {
        if (adresse !== undefined && adresse !== null) local.set(CLES.serveur, normaliserAdresse(adresse));
        const r = await requete('/api/collections/users/auth-with-password',
          Object.assign({ method: 'POST', sansJeton: true }, json({ identity: email, password: motDePasse })));
        local.set(CLES.jeton, r.token);
        local.set(CLES.jetonDate, String(Date.now()));
        local.set(CLES.compte, (r.record && r.record.email) || email);
        return r.record;
      },
      deconnecter() { local.del(CLES.jeton); local.del(CLES.jetonDate); local.del(CLES.compte); changerEtat({ statut: 'non-connecte', message: 'Compte non connecté' }); },
      definirServeur(adresse) { local.set(CLES.serveur, normaliserAdresse(adresse)); },
      definirNomAppareil(nom) { const a = reglages.appareil(); a.nom = String(nom || '').trim() || a.nom; local.set(CLES.appareil, JSON.stringify(a)); },
      reglages,

      // mode simple
      envoyerSauvegarde: (forcer) => envoyerSauvegarde(forcer),
      envoyerCopie: (forcer) => envoyerCopie(forcer),
      listerSauvegardes,
      restaurerSauvegarde,

      // à appeler par l'appli au démarrage (fait automatiquement par configurer())
      demarrer() {
        lireEtat('derniere', null).then((d) => changerEtat({ derniere: d })).catch(() => {});
        rafraichirCompteur();
        if (typeof document === 'undefined') return;
        if (c.indicateur !== false) installerIndicateur(instance);
        const auto = () => { if (Date.now() - derniereTentative > RELANCE_MIN) synchroniser(); };
        setTimeout(() => synchroniser(), 1500);
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') auto(); });
        global.addEventListener('online', auto);
      },
    };
    return instance;
  }

  // ---------------------------------------------------------------------------
  // Panneau « Serveur maison »
  // ---------------------------------------------------------------------------
  function formaterDate(d) {
    if (!d) return 'jamais';
    const date = typeof d === 'number' ? new Date(d) : new Date(String(d).replace(' ', 'T'));
    return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }
  function formaterTaille(o) {
    if (!o && o !== 0) return '';
    return o < 1024 ? o + ' o' : o < 1048576 ? (o / 1024).toFixed(0) + ' Ko' : (o / 1048576).toFixed(1) + ' Mo';
  }
  const LIBELLES = {
    'inactif': '—', 'en-cours': '🔄 Synchronisation…', 'ok': '✅ Synchronisé',
    'hors-maison': '🏠 Hors de la maison (synchro au retour)', 'non-connecte': '🔑 Compte non connecté',
    'non-configure': '⚙️ Serveur non configuré', 'erreur': '⚠️ Erreur',
  };

  const STYLE = `
    :host { all: initial; }
    .fond { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 2147483647; font: 15px/1.45 system-ui, sans-serif; }
    .boite { background: #fff; color: #1f2937; width: min(30rem, 94vw); max-height: 90vh; overflow: auto; border-radius: 14px; padding: 1.1rem 1.2rem 1.3rem; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
    h2 { margin: 0 0 .8rem; font-size: 1.15rem; display: flex; justify-content: space-between; align-items: center; }
    h3 { margin: 1.1rem 0 .4rem; font-size: .95rem; color: #374151; }
    label { display: block; font-size: .85rem; color: #4b5563; margin: .4rem 0 .15rem; }
    input { width: 100%; box-sizing: border-box; padding: .55rem .6rem; font-size: 1rem; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: inherit; }
    .ligne { display: flex; gap: .5rem; align-items: center; margin-top: .5rem; flex-wrap: wrap; }
    button { padding: .5rem .9rem; font-size: .95rem; border-radius: 8px; border: 0; background: #2563eb; color: #fff; cursor: pointer; }
    button.second { background: #e5e7eb; color: #111827; }
    button.danger { background: #dc2626; }
    button:disabled { opacity: .55; }
    .fermer { background: transparent; color: #6b7280; font-size: 1.4rem; padding: 0 .3rem; }
    .msg { margin-top: .45rem; font-size: .9rem; white-space: pre-wrap; }
    .ok { color: #15803d; } .ko { color: #b91c1c; }
    .etat { padding: .6rem .7rem; border-radius: 8px; background: #f3f4f6; font-size: .92rem; }
    ul { list-style: none; padding: 0; margin: .3rem 0 0; }
    li { display: flex; justify-content: space-between; align-items: center; gap: .5rem; padding: .45rem 0; border-bottom: 1px solid #eee; font-size: .88rem; }
    details { margin-top: 1rem; font-size: .88rem; color: #4b5563; }
    summary { cursor: pointer; }
    @media (prefers-color-scheme: dark) {
      .boite { background: #1f2937; color: #f3f4f6; }
      h3, label, details { color: #d1d5db; }
      input { background: #111827; border-color: #374151; }
      .etat { background: #111827; }
      button.second { background: #374151; color: #f3f4f6; }
      li { border-color: #374151; }
    }`;

  // ---------------------------------------------------------------------------
  // Indicateur discret : barre de chargement en haut pendant la synchro,
  // petit message « ✅ Synchronisé » quand quelque chose a été échangé.
  // Hors de la maison : rien ne s'affiche.
  // ---------------------------------------------------------------------------
  const STYLE_INDICATEUR = `
    :host { all: initial; }
    .barre { position: fixed; top: 0; left: 0; right: 0; height: 3px; overflow: hidden; z-index: 2147483646;
      opacity: 0; transition: opacity .25s; pointer-events: none; }
    .barre.on { opacity: 1; }
    .barre::before { content: ''; position: absolute; top: 0; height: 100%; width: 35%; left: -35%;
      background: #2563eb; border-radius: 3px; animation: glisse 1.1s infinite ease-in-out; }
    @keyframes glisse { from { left: -35%; } to { left: 100%; } }
    .bulle { position: fixed; top: calc(10px + env(safe-area-inset-top, 0px)); left: 50%; z-index: 2147483646;
      transform: translate(-50%, -12px); opacity: 0; transition: opacity .25s, transform .25s; pointer-events: none;
      background: rgba(31,41,55,.94); color: #fff; padding: .45rem .9rem; border-radius: 999px;
      font: 14px/1.3 system-ui, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.25); white-space: nowrap; }
    .bulle.on { opacity: 1; transform: translate(-50%, 0); }`;

  function installerIndicateur(instance) {
    const poser = () => {
      const hote = document.createElement('div');
      hote.setAttribute('data-sync-maison', 'indicateur');
      const ombre = hote.attachShadow({ mode: 'open' });
      ombre.innerHTML = `<style>${STYLE_INDICATEUR}</style><div class="barre"></div><div class="bulle"></div>`;
      document.body.appendChild(hote);
      const barre = ombre.querySelector('.barre');
      const bulle = ombre.querySelector('.bulle');
      let minutBarre = null;
      let minutBulle = null;
      let premiereOk = true;
      const dejaSignale = new Set();

      function montrer(texte) {
        bulle.textContent = texte;
        bulle.classList.add('on');
        clearTimeout(minutBulle);
        minutBulle = setTimeout(() => bulle.classList.remove('on'), 2600);
      }
      function pluriel(n, mot) { return `${n} ${mot}${n > 1 ? 's' : ''}`; }

      let progressionVue = false;
      instance.surEtat((e) => {
        if (e.statut === 'en-cours') {
          if (!barre.classList.contains('on')) {
            clearTimeout(minutBarre);
            minutBarre = setTimeout(() => barre.classList.add('on'), 250); // pas de clignotement si c'est rapide
          }
          // grosse synchro : bulle de progression qui reste affichée jusqu'à la fin
          const p = e.progression;
          if (p && p.total >= 20) {
            progressionVue = true;
            clearTimeout(minutBulle);
            bulle.textContent = `🔄 ${p.etape === 'envoi' ? 'Envoi' : 'Réception'}… ${p.fait} / ${p.total}`;
            bulle.classList.add('on');
          }
          return;
        }
        if (progressionVue) { progressionVue = false; bulle.classList.remove('on'); }
        clearTimeout(minutBarre);
        barre.classList.remove('on');
        if (e.statut === 'ok') {
          const r = e.recus || 0;
          const s = e.envoyes || 0;
          if (r || s) {
            const details = [r ? pluriel(r, 'reçu') : '', s ? pluriel(s, 'envoyé') : ''].filter(Boolean).join(', ');
            montrer(`✅ Synchronisé · ${details}`);
          } else if (premiereOk) {
            montrer('✅ Synchronisé');
          }
          premiereOk = false;
        } else if ((e.statut === 'erreur' || e.statut === 'non-connecte') && !dejaSignale.has(e.statut)) {
          dejaSignale.add(e.statut);
          montrer(e.statut === 'non-connecte' ? '🔑 Synchro : compte à reconnecter' : '⚠️ Synchro impossible');
        }
      });
    };
    if (document.body) poser();
    else document.addEventListener('DOMContentLoaded', poser, { once: true });
  }

  function ouvrirReglages(instance) {
    if (typeof document === 'undefined') return;
    const hote = document.createElement('div');
    const ombre = hote.attachShadow({ mode: 'open' });
    document.body.appendChild(hote);
    const c = instance.config;
    const r = instance.reglages;

    ombre.innerHTML = `<style>${STYLE}</style>
      <div class="fond"><div class="boite" role="dialog" aria-label="Serveur maison">
        <h2><span>🏠 Serveur maison</span><button class="fermer" data-a="fermer" aria-label="Fermer">×</button></h2>
        <div class="etat" data-z="etat"></div>
        <div class="ligne"><button data-a="synchro">Synchroniser maintenant</button></div>

        <h3>Adresse du serveur</h3>
        <input data-z="adresse" inputmode="url" autocomplete="off" placeholder="ex. http://192.168.1.63:8090">
        <div class="ligne"><button class="second" data-a="tester">Tester la connexion</button></div>
        <div class="msg" data-z="msgTest"></div>

        <h3>Compte</h3>
        <div data-z="compte"></div>

        <h3>Cet appareil</h3>
        <label>Nom affiché dans les sauvegardes</label>
        <input data-z="appareil">

        <div data-z="sauvegardes"></div>

        <details><summary>Ça ne marche pas ?</summary>
          <p>• Le téléphone doit être sur le Wi-Fi de la maison (la synchro se fait toute seule au retour).</p>
          <p>• Android : Paramètres → Applications → ton navigateur (Brave, Chrome…) → Autorisations → « Appareils à proximité » ou « Réseau local » → Autoriser.</p>
          <p>• Si le navigateur demande l'accès au réseau local, réponds « Autoriser ».</p>
          <p>• Firefox ne permet pas à un site sécurisé de joindre le serveur maison : utilise Brave ou Chrome.</p>
          <p>Ces réglages (adresse, compte, nom de l'appareil) sont communs à toutes les applis.</p>
        </details>
      </div></div>`;

    const $ = (z) => ombre.querySelector(`[data-z="${z}"]`);
    const msg = (z, texte, ok) => { const el = $(z); el.textContent = texte; el.className = 'msg ' + (ok === true ? 'ok' : ok === false ? 'ko' : ''); };

    $('adresse').value = r.serveur();
    $('appareil').value = r.appareil().nom;
    $('appareil').addEventListener('change', (e) => instance.definirNomAppareil(e.target.value));
    $('adresse').addEventListener('change', (e) => instance.definirServeur(e.target.value));

    function dessinerCompte() {
      const z = $('compte');
      if (r.jeton()) {
        z.innerHTML = `<div>Connecté : <strong></strong></div><div class="ligne"><button class="second" data-a="deconnecter">Se déconnecter</button></div>`;
        z.querySelector('strong').textContent = r.compte();
      } else {
        z.innerHTML = `<label>E-mail</label><input data-z="email" type="email" autocomplete="username">
          <label>Mot de passe</label><input data-z="mdp" type="password" autocomplete="current-password">
          <div class="ligne"><button data-a="connecter">Se connecter</button></div><div class="msg" data-z="msgCompte"></div>`;
      }
    }

    async function dessinerSauvegardes() {
      if (c.mode !== 'simple') return;
      const z = $('sauvegardes');
      z.innerHTML = `<h3>Sauvegardes sur le serveur</h3><div class="msg">Chargement…</div>`;
      try {
        const liste = await instance.listerSauvegardes();
        if (!liste.length) { z.innerHTML = `<h3>Sauvegardes sur le serveur</h3><div class="msg">Aucune sauvegarde pour l'instant.</div>`; return; }
        z.innerHTML = `<h3>Sauvegardes sur le serveur</h3><ul></ul>`;
        const ul = z.querySelector('ul');
        for (const s of liste) {
          const li = document.createElement('li');
          const texte = document.createElement('span');
          texte.textContent = `${formaterDate(s.date)} — ${s.appareil || '?'} — ${formaterTaille(s.taille)}`;
          const b = document.createElement('button');
          b.className = 'second'; b.textContent = 'Restaurer';
          b.addEventListener('click', async () => {
            if (!global.confirm(`Remplacer les données de ${c.nom} sur cet appareil par la sauvegarde du ${formaterDate(s.date)} ?`)) return;
            b.disabled = true; b.textContent = '…';
            try { await instance.restaurerSauvegarde(s.id); b.textContent = '✅ Restauré'; }
            catch (err) { b.textContent = 'Échec'; global.alert('Restauration impossible : ' + err.message); }
          });
          li.append(texte, b);
          ul.appendChild(li);
        }
      } catch (err) {
        z.innerHTML = `<h3>Sauvegardes sur le serveur</h3><div class="msg ko"></div>`;
        z.querySelector('.msg').textContent = err.code === 'hors-maison' ? 'Serveur injoignable : liste disponible à la maison.' : err.message;
      }
    }

    function dessinerEtat(e) {
      const z = $('etat');
      if (!z) return;
      let texte = `${LIBELLES[e.statut] || e.statut}`;
      if (e.statut === 'en-cours' && e.progression) {
        texte += ` (${e.progression.etape === 'envoi' ? 'envoi' : 'réception'} ${e.progression.fait} / ${e.progression.total})`;
      }
      if (e.statut === 'erreur' && e.message) texte += ` : ${e.message}`;
      texte += `\nDernière synchro : ${formaterDate(e.derniere)}`;
      if (c.mode === 'complet') texte += `\nModifications en attente : ${e.enAttente || 0}`;
      z.textContent = texte;
      z.style.whiteSpace = 'pre-wrap';
    }
    const desabonner = instance.surEtat(dessinerEtat);

    function fermer() { desabonner(); hote.remove(); }

    ombre.addEventListener('click', async (ev) => {
      if (ev.target.classList && ev.target.classList.contains('fond')) return fermer();
      const a = ev.target.closest && ev.target.closest('[data-a]');
      if (!a) return;
      const action = a.getAttribute('data-a');
      if (action === 'fermer') return fermer();
      if (action === 'tester') {
        instance.definirServeur($('adresse').value);
        $('adresse').value = r.serveur();
        msg('msgTest', 'Test en cours…');
        try {
          const ms = await instance.tester();
          msg('msgTest', `✅ Serveur joint en ${ms} ms.`, true);
        } catch (err) {
          msg('msgTest', err.code === 'configuration' ? '⚠️ Indique d\'abord l\'adresse du serveur.'
            : '❌ Serveur injoignable. Vérifie que tu es sur le Wi-Fi de la maison, l\'adresse, et les autorisations (voir « Ça ne marche pas ? »).', false);
        }
      }
      if (action === 'connecter') {
        instance.definirServeur($('adresse').value);
        const email = $('email').value.trim();
        const mdp = $('mdp').value;
        msg('msgCompte', 'Connexion…');
        try {
          await instance.connecter(null, email, mdp);
          dessinerCompte();
          instance.synchroniser().then(dessinerSauvegardes);
        } catch (err) {
          msg('msgCompte', err.code === 'hors-maison' ? '❌ Serveur injoignable.' : '❌ E-mail ou mot de passe incorrect.', false);
        }
      }
      if (action === 'deconnecter') { instance.deconnecter(); dessinerCompte(); }
      if (action === 'synchro') {
        a.disabled = true;
        await instance.synchroniser({ forcer: true });
        a.disabled = false;
        dessinerSauvegardes();
      }
    });

    dessinerCompte();
    dessinerSauvegardes();
  }

  // ---------------------------------------------------------------------------
  // Objet global
  // ---------------------------------------------------------------------------
  let defaut = null;
  const SyncMaison = {
    version: VERSION,
    creer,
    configurer(config) {
      defaut = creer(config);
      defaut.demarrer();
      return defaut;
    },
    get instance() { return defaut; },
    get etat() { return defaut ? defaut.etat : null; },
    surEtat: (f) => defaut && defaut.surEtat(f),
    modifie: (store, enr) => defaut ? defaut.modifie(store, enr) : Promise.resolve(),
    supprime: (store, id) => defaut ? defaut.supprime(store, id) : Promise.resolve(),
    synchroniser: (o) => defaut ? defaut.synchroniser(o) : Promise.resolve(null),
    ouvrirReglages: () => { if (defaut) ouvrirReglages(defaut); },
  };

  global.SyncMaison = SyncMaison;
  if (typeof module !== 'undefined' && module.exports) module.exports = SyncMaison;
})(typeof window !== 'undefined' ? window : globalThis);
