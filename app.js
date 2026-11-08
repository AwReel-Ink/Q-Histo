/**
 * Q'HISTO - Application de gestion de recettes
 * Version 2.0.0
 */

const APP_VERSION = '2.0.0';

const STORAGE = {
    recipes: 'qhisto-recipes',
    theme: 'qhisto-theme',
    shopping: 'qhisto-shopping',
    cooking: 'qhisto-cooking',
    lastExport: 'qhisto-last-export',
    listPrefs: 'qhisto-list-prefs'
};

const DEFAULT_TAGS = ['Apéro', 'Entrée', 'Plat', 'Accompagnement', 'Dessert', 'Goûter', 'Boisson', 'Sauce', 'Végétarien', 'Rapide'];

// Unités convertibles entre elles (pour additionner dans la liste de courses)
const UNIT_CONVERSIONS = {
    mg: { family: 'masse', factor: 0.001, base: 'g' },
    g: { family: 'masse', factor: 1, base: 'g' },
    kg: { family: 'masse', factor: 1000, base: 'g' },
    ml: { family: 'volume', factor: 1, base: 'ml' },
    cl: { family: 'volume', factor: 10, base: 'ml' },
    L: { family: 'volume', factor: 1000, base: 'ml' }
};

const NON_DIVISIBLE_UNITS = ['pincée', 'gousse', 'œuf', 'oeuf', 'pièce', 'tranche', 'feuille', 'branche'];

const PLURALS = {
    'pincée': 'pincées', 'gousse': 'gousses', 'œuf': 'œufs', 'oeuf': 'oeufs', 'pièce': 'pièces',
    'tranche': 'tranches', 'feuille': 'feuilles', 'branche': 'branches', 'tasse': 'tasses', 'cup': 'cups'
};

const UNIT_GROUPS = [
    { label: 'Masse', units: [['mg', 'mg (milligramme)'], ['g', 'g (gramme)'], ['kg', 'kg (kilogramme)']] },
    { label: 'Volume', units: [['ml', 'ml (millilitre)'], ['cl', 'cl (centilitre)'], ['L', 'L (litre)']] },
    { label: 'Mesures cuisine', units: [['c. à café', 'c. à café (cuillère à café)'], ['c. à soupe', 'c. à soupe (cuillère à soupe)'], ['tasse', 'tasse'], ['cup', 'cup']] },
    { label: 'Unités non divisibles', units: [['pincée', 'pincée'], ['gousse', 'gousse'], ['œuf', 'œuf'], ['pièce', 'pièce'], ['tranche', 'tranche'], ['feuille', 'feuille'], ['branche', 'branche']] }
];

// Les cases cochées pendant la cuisine sont oubliées après 12 h
const COOKING_STATE_TTL = 12 * 60 * 60 * 1000;
const BACKUP_REMINDER_DAYS = 30;

// ===== STOCKAGE DES PHOTOS (IndexedDB, bien plus spacieux que localStorage) =====
const PhotoStore = {
    _db: null,
    open() {
        if (this._db) return this._db;
        this._db = new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) return reject(new Error('IndexedDB indisponible'));
            const request = indexedDB.open('qhisto', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('photos');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return this._db;
    },
    async _run(mode, action) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('photos', mode);
            const request = action(tx.objectStore('photos'));
            tx.oncomplete = () => resolve(request ? request.result : undefined);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    },
    get(id) { return this._run('readonly', s => s.get(id)); },
    set(id, data) { return this._run('readwrite', s => s.put(data, id)); },
    delete(id) { return this._run('readwrite', s => s.delete(id)); },
    clear() { return this._run('readwrite', s => s.clear()); }
};

class QHistoApp {
    constructor() {
        this.recipes = [];
        this.currentRecipeId = null;
        this.editingId = null;
        this.ratio = 1;
        this.editorTags = new Set();
        this.editorPhoto = { data: null, changed: false };
        this.editorDirty = false;
        this.photoCache = new Map();
        this.shoppingReturn = 'menu';
        this.importMode = 'replace';

        this.shopping = this.loadJSON(STORAGE.shopping, { recipes: [], checked: [] });
        this.cooking = this.loadJSON(STORAGE.cooking, {});
        this.listPrefs = Object.assign({ sort: 'az', tag: null, favOnly: false }, this.loadJSON(STORAGE.listPrefs, {}));

        this.loadData();
        this.init();
    }

    // ===== INITIALISATION =====
    init() {
        this.loadTheme();
        this.updateRecipeCount();

        const form = document.getElementById('recipe-form');
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveRecipe();
        });
        form.addEventListener('input', () => { this.editorDirty = true; });

        document.getElementById('search').addEventListener('input', () => this.renderRecipeList());

        const sortSelect = document.getElementById('sort-select');
        sortSelect.value = this.listPrefs.sort;
        sortSelect.addEventListener('change', (e) => {
            this.listPrefs.sort = e.target.value;
            this.saveJSON(STORAGE.listPrefs, this.listPrefs);
            this.renderRecipeList();
        });

        // Filtres de la liste (favoris / étiquettes)
        document.getElementById('list-filters').addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;
            if (chip.dataset.filter === 'fav') {
                this.listPrefs.favOnly = !this.listPrefs.favOnly;
            } else {
                this.listPrefs.tag = this.listPrefs.tag === chip.dataset.tag ? null : chip.dataset.tag;
            }
            this.saveJSON(STORAGE.listPrefs, this.listPrefs);
            this.renderRecipeList();
        });

        // Étiquettes dans l'éditeur
        document.getElementById('editor-tags').addEventListener('click', (e) => {
            const chip = e.target.closest('.chip');
            if (!chip) return;
            const tag = chip.dataset.tag;
            if (this.editorTags.has(tag)) this.editorTags.delete(tag);
            else this.editorTags.add(tag);
            this.editorDirty = true;
            this.renderEditorTags();
        });
        document.getElementById('custom-tag').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.addCustomTag();
            }
        });

        document.getElementById('photo-input').addEventListener('change', (e) => this.handlePhoto(e));

        // Cases de la liste de courses (clé = texte libre, donc pas de onclick en ligne)
        document.getElementById('shopping-content').addEventListener('change', (e) => {
            if (e.target.matches('input[data-key]')) this.toggleShoppingItem(e.target.dataset.key);
        });

        this.requestPersistentStorage();
        this.renderMenu();

        if (this.loadError) {
            setTimeout(() => alert('⚠️ Les recettes enregistrées n\'ont pas pu être lues. Une copie de secours a été gardée. Tu peux réimporter ta dernière sauvegarde depuis « Informations ».'), 300);
        }
    }

    // ===== NAVIGATION =====
    showMenu() {
        this.showPage('menu-page');
        this.renderMenu();
    }

    showRecipeList() {
        this.showPage('list-page');
        this.renderRecipeList();
    }

    showEditor(recipeId = null) {
        this.editingId = recipeId;
        this.showPage('editor-page');

        if (recipeId) {
            document.getElementById('editor-title').textContent = 'Modifier la recette';
            this.loadRecipeInEditor(recipeId);
        } else {
            document.getElementById('editor-title').textContent = 'Nouvelle recette';
            this.resetEditor();
        }
        this.editorDirty = false;
    }

    showRecipe(id, keepScale = false) {
        if (!keepScale || this.currentRecipeId !== id) this.ratio = 1;
        this.currentRecipeId = id;
        this.showPage('view-page');
        this.renderRecipe();
    }

    showInfo() {
        this.showPage('info-page');
        this.updateRecipeCount();
        this.renderBackupInfo();
    }

    showShopping(from = 'menu') {
        this.shoppingReturn = from;
        this.showPage('shopping-page');
        this.renderShoppingList();
    }

    backFromShopping() {
        if (this.shoppingReturn === 'view' && this.getRecipe(this.currentRecipeId)) {
            this.showRecipe(this.currentRecipeId, true);
        } else {
            this.showMenu();
        }
    }

    showPage(pageId) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById(pageId).classList.add('active');
        window.scrollTo(0, 0);
    }

    // ===== MENU =====
    renderMenu() {
        const count = this.shopping.recipes.filter(e => this.getRecipe(e.id)).length;
        const badge = document.getElementById('shopping-count');
        badge.textContent = count || '';
        badge.style.display = count ? '' : 'none';

        const banner = document.getElementById('backup-banner');
        const last = localStorage.getItem(STORAGE.lastExport);
        const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null;
        if (this.recipes.length > 0 && (days === null || days >= BACKUP_REMINDER_DAYS)) {
            banner.innerHTML = `
                <span>💾 ${days === null ? 'Tu n\'as encore jamais sauvegardé tes recettes.' : `Dernière sauvegarde il y a ${days} jours.`}</span>
                <button class="link-btn" onclick="app.exportData()">Sauvegarder maintenant</button>
            `;
            banner.style.display = '';
        } else {
            banner.style.display = 'none';
        }
    }

    // ===== LISTE DES RECETTES =====
    renderRecipeList() {
        const list = document.getElementById('recipe-list');
        const term = this.normalize(document.getElementById('search').value);
        let recipes = [...this.recipes];

        // Une étiquette filtrée qui n'existe plus est oubliée
        if (this.listPrefs.tag && !this.getAllTags().includes(this.listPrefs.tag)) this.listPrefs.tag = null;

        if (this.listPrefs.favOnly) recipes = recipes.filter(r => r.favorite);
        if (this.listPrefs.tag) recipes = recipes.filter(r => r.tags.includes(this.listPrefs.tag));
        if (term) recipes = recipes.filter(r => this.searchableText(r).includes(term));

        const byName = (a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
        const sorters = {
            az: byName,
            za: (a, b) => byName(b, a),
            recent: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
            old: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')
        };
        recipes.sort(sorters[this.listPrefs.sort] || byName);

        this.renderFilters();

        if (recipes.length === 0) {
            list.innerHTML = `<p class="empty-message">${this.recipes.length === 0 ? 'Aucune recette. Ajoutez-en une !' : 'Aucune recette ne correspond.'}</p>`;
            return;
        }

        list.innerHTML = recipes.map(recipe => {
            const meta = [
                recipe.persons ? `👥 ${recipe.persons} pers.` : '',
                recipe.quantity ? `📦 ${recipe.quantity} portions` : '',
                recipe.time ? `⏱️ ${this.escapeHtml(recipe.time)}` : ''
            ].filter(Boolean).join(' · ');
            return `
            <div class="recipe-item" onclick="app.showRecipe(${recipe.id})">
                ${recipe.hasPhoto ? `<img class="recipe-thumb" data-photo-id="${recipe.id}" alt="">` : ''}
                <div class="recipe-item-body">
                    <strong>${this.escapeHtml(recipe.name)}</strong>
                    ${meta ? `<div class="recipe-meta">${meta}</div>` : ''}
                    ${recipe.tags.length ? `<div class="tag-list">${recipe.tags.map(t => `<span class="tag">${this.escapeHtml(t)}</span>`).join('')}</div>` : ''}
                </div>
                <button class="fav-btn ${recipe.favorite ? 'active' : ''}" onclick="event.stopPropagation(); app.toggleFavorite(${recipe.id})"
                    aria-label="${recipe.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${recipe.favorite ? '★' : '☆'}</button>
            </div>`;
        }).join('');

        this.loadThumbnails(list);
    }

    renderFilters() {
        const el = document.getElementById('list-filters');
        if (this.recipes.length === 0) {
            el.innerHTML = '';
            return;
        }
        const tags = this.getAllTags();
        el.innerHTML = `
            <button class="chip ${this.listPrefs.favOnly ? 'active' : ''}" data-filter="fav">★ Favoris</button>
            ${tags.map(t => `<button class="chip ${this.listPrefs.tag === t ? 'active' : ''}" data-tag="${this.escapeHtml(t)}">${this.escapeHtml(t)}</button>`).join('')}
        `;
    }

    loadThumbnails(container) {
        container.querySelectorAll('img[data-photo-id]').forEach(async img => {
            const data = await this.getPhoto(Number(img.dataset.photoId));
            if (data) img.src = data;
            else img.remove();
        });
    }

    searchableText(recipe) {
        return this.normalize([
            recipe.name,
            ...recipe.tags,
            ...recipe.ingredients.map(i => i.name),
            recipe.notes
        ].join(' '));
    }

    toggleFavorite(id) {
        const recipe = this.getRecipe(id);
        if (!recipe) return;
        recipe.favorite = !recipe.favorite;
        recipe.updatedAt = new Date().toISOString();
        this.saveData();

        if (document.getElementById('view-page').classList.contains('active')) this.updateFavoriteButton();
        else this.renderRecipeList();
    }

    updateFavoriteButton() {
        const recipe = this.getRecipe(this.currentRecipeId);
        const btn = document.getElementById('view-fav');
        if (!recipe || !btn) return;
        btn.textContent = recipe.favorite ? '★' : '☆';
        btn.classList.toggle('active', recipe.favorite);
        btn.setAttribute('aria-label', recipe.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris');
    }

    // ===== AFFICHAGE D'UNE RECETTE =====
    renderRecipe() {
        const recipe = this.getRecipe(this.currentRecipeId);
        if (!recipe) {
            this.showRecipeList();
            return;
        }

        document.getElementById('view-title').textContent = recipe.name;
        this.updateFavoriteButton();

        const content = document.getElementById('view-content');
        content.innerHTML = `
            <div class="recipe-view">
                ${recipe.hasPhoto ? `<img id="view-photo" class="recipe-photo" alt="Photo : ${this.escapeHtml(recipe.name)}">` : ''}

                ${recipe.tags.length ? `<div class="tag-list">${recipe.tags.map(t => `<span class="tag">${this.escapeHtml(t)}</span>`).join('')}</div>` : ''}

                ${recipe.time ? `<p class="recipe-time"><strong>⏱️ Temps de cuisson :</strong> ${this.escapeHtml(recipe.time)}</p>` : ''}

                ${recipe.persons || recipe.quantity ? `<div class="recipe-controls" id="recipe-controls">${this.renderControls(recipe)}</div>` : ''}

                <div class="recipe-section">
                    <div class="section-header">
                        <h3>🥘 Ingrédients</h3>
                        <span id="ing-progress" class="progress"></span>
                    </div>
                    <div id="ingredients-display"></div>
                </div>

                ${recipe.steps.length > 0 ? `
                    <div class="recipe-section">
                        <div class="section-header">
                            <h3>📝 Préparation</h3>
                            <span id="step-progress" class="progress"></span>
                        </div>
                        <div id="steps-display" class="steps-display"></div>
                    </div>
                ` : ''}

                ${recipe.notes ? `
                    <div class="recipe-section">
                        <h3>💡 Notes &amp; astuces</h3>
                        <div class="recipe-notes">${this.escapeHtml(recipe.notes)}</div>
                    </div>
                ` : ''}

                <div id="cooking-reset" class="cooking-reset"></div>

                <div class="recipe-actions">
                    <button class="btn btn-primary" id="add-shopping-btn" onclick="app.addToShopping()"></button>
                    <button class="btn btn-info" onclick="app.printPage()">🖨️ Imprimer</button>
                    <button class="btn btn-warning" onclick="app.showEditor(${recipe.id})">✏️ Modifier</button>
                    <button class="btn btn-danger" onclick="app.deleteRecipe(${recipe.id})">🗑️ Supprimer</button>
                </div>
            </div>
        `;

        this.renderIngredientsDisplay();
        this.renderStepsDisplay();
        this.updateCookingProgress();
        this.updateShoppingButton();

        if (recipe.hasPhoto) {
            this.getPhoto(recipe.id).then(data => {
                const img = document.getElementById('view-photo');
                if (!img) return;
                if (data) img.src = data;
                else img.remove();
            });
        }
    }

    renderControls(recipe) {
        const group = (type, label) => {
            const base = recipe[type];
            if (!base) return '';
            return `
                <div class="control-group">
                    <label>${label}</label>
                    <div class="counter">
                        <button type="button" onclick="app.adjustPortion('${type}', -1)" aria-label="Moins">−</button>
                        <span id="current-${type}">${this.formatNumber(base * this.ratio)}</span>
                        <button type="button" onclick="app.adjustPortion('${type}', 1)" aria-label="Plus">+</button>
                    </div>
                </div>`;
        };
        return group('persons', 'Nombre de personnes') + group('quantity', 'Quantité (portions)');
    }

    // Personnes et portions sont liées : changer l'un met l'autre à jour
    adjustPortion(type, delta) {
        const recipe = this.getRecipe(this.currentRecipeId);
        if (!recipe || !recipe[type]) return;

        const base = recipe[type];
        const current = Math.round(base * this.ratio);
        const next = Math.max(1, current + delta);
        this.ratio = next / base;

        document.getElementById('recipe-controls').innerHTML = this.renderControls(recipe);
        this.renderIngredientsDisplay();
        this.updateShoppingButton();
    }

    renderIngredientsDisplay() {
        const recipe = this.getRecipe(this.currentRecipeId);
        const el = document.getElementById('ingredients-display');
        if (!recipe || !el) return;

        const state = this.getCookingState(recipe.id);
        el.innerHTML = recipe.ingredients.map((ing, i) => {
            const checked = state.ingredients.includes(i);
            return `
            <label class="ingredient-item check-row ${checked ? 'checked' : ''}">
                <input type="checkbox" ${checked ? 'checked' : ''} onchange="app.toggleIngredient(${i})">
                <span class="ingredient-name">${this.escapeHtml(ing.name)}</span>
                <strong class="ingredient-qty">${this.formatQuantity(ing.quantity == null ? null : ing.quantity * this.ratio, ing.unit)}</strong>
            </label>`;
        }).join('');
    }

    // Les étapes faites descendent en bas : l'étape en cours est toujours la première
    renderStepsDisplay() {
        const recipe = this.getRecipe(this.currentRecipeId);
        const el = document.getElementById('steps-display');
        if (!recipe || !el) return;

        const state = this.getCookingState(recipe.id);
        const steps = recipe.steps.map((step, index) => ({ ...step, index, done: state.steps.includes(index) }));
        const ordered = [...steps.filter(s => !s.done), ...steps.filter(s => s.done)];
        const current = ordered.find(s => !s.done);

        el.innerHTML = ordered.map(step => {
            const isCurrent = current && step.index === current.index;
            return `
            <label class="step-item check-row ${step.done ? 'checked' : ''} ${isCurrent ? 'current' : ''}" data-flip="${step.index}" style="--orig: ${step.index}">
                <input type="checkbox" ${step.done ? 'checked' : ''} onchange="app.toggleStep(${step.index})">
                <div class="step-body">
                    <div class="step-number">
                        Étape ${step.index + 1}
                        ${isCurrent ? '<span class="current-badge">En cours</span>' : ''}
                        ${step.done ? '<span class="done-badge">Faite</span>' : ''}
                    </div>
                    <div class="step-text">${this.escapeHtml(step.description)}</div>
                    ${step.time ? `<div class="step-time">⏱️ ${this.escapeHtml(step.time)}</div>` : ''}
                </div>
            </label>`;
        }).join('');
    }

    toggleIngredient(index) {
        const id = this.currentRecipeId;
        const state = this.getCookingState(id);
        state.ingredients = this.toggleInList(state.ingredients, index);
        this.setCookingState(id, state);
        this.renderIngredientsDisplay();
        this.updateCookingProgress();
    }

    toggleStep(index) {
        const id = this.currentRecipeId;
        const container = document.getElementById('steps-display');
        this.animateReorder(container, () => {
            const state = this.getCookingState(id);
            state.steps = this.toggleInList(state.steps, index);
            this.setCookingState(id, state);
            this.renderStepsDisplay();
        });
        this.updateCookingProgress();
    }

    resetCooking() {
        const container = document.getElementById('steps-display');
        this.animateReorder(container, () => {
            delete this.cooking[this.currentRecipeId];
            this.saveJSON(STORAGE.cooking, this.cooking);
            this.renderStepsDisplay();
        });
        this.renderIngredientsDisplay();
        this.updateCookingProgress();
    }

    updateCookingProgress() {
        const recipe = this.getRecipe(this.currentRecipeId);
        if (!recipe) return;
        const state = this.getCookingState(recipe.id);

        const ingEl = document.getElementById('ing-progress');
        if (ingEl) ingEl.textContent = state.ingredients.length ? `${state.ingredients.length}/${recipe.ingredients.length} prêts` : '';

        const stepEl = document.getElementById('step-progress');
        if (stepEl) {
            const done = state.steps.length;
            const total = recipe.steps.length;
            stepEl.textContent = done === total && total > 0 ? '✅ Terminé !' : (done ? `${done}/${total} faites` : '');
        }

        const resetEl = document.getElementById('cooking-reset');
        if (resetEl) {
            resetEl.innerHTML = state.ingredients.length || state.steps.length
                ? '<button class="link-btn" onclick="app.resetCooking()">🔄 Tout décocher</button>'
                : '';
        }
    }

    getCookingState(id) {
        const saved = this.cooking[id];
        if (!saved || Date.now() - (saved.updatedAt || 0) > COOKING_STATE_TTL) {
            return { ingredients: [], steps: [] };
        }
        return { ingredients: [...(saved.ingredients || [])], steps: [...(saved.steps || [])] };
    }

    setCookingState(id, state) {
        const now = Date.now();
        this.cooking[id] = { ...state, updatedAt: now };
        // Ménage des vieux états
        Object.keys(this.cooking).forEach(key => {
            if (now - (this.cooking[key].updatedAt || 0) > COOKING_STATE_TTL) delete this.cooking[key];
        });
        this.saveJSON(STORAGE.cooking, this.cooking);
    }

    deleteRecipe(id) {
        if (!confirm('Supprimer cette recette ?')) return;

        this.recipes = this.recipes.filter(r => r.id !== id);
        delete this.cooking[id];
        this.saveJSON(STORAGE.cooking, this.cooking);
        this.shopping.recipes = this.shopping.recipes.filter(e => e.id !== id);
        this.saveJSON(STORAGE.shopping, this.shopping);
        this.photoCache.delete(id);
        PhotoStore.delete(id).catch(() => {});
        this.saveData();
        this.showRecipeList();
    }

    printPage() {
        window.print();
    }

    // ===== ÉDITEUR =====
    resetEditor() {
        document.getElementById('recipe-form').reset();
        document.getElementById('ingredients-list').innerHTML = '';
        document.getElementById('steps-list').innerHTML = '';
        this.addIngredient();
        this.addStep();
        this.editorTags = new Set();
        this.editorPhoto = { data: null, changed: false };
        this.renderEditorTags();
        this.renderEditorPhoto();
    }

    loadRecipeInEditor(id) {
        const recipe = this.getRecipe(id);
        if (!recipe) return;

        document.getElementById('recipe-form').reset();
        document.getElementById('recipe-name').value = recipe.name;
        document.getElementById('recipe-persons').value = recipe.persons || '';
        document.getElementById('recipe-quantity').value = recipe.quantity || '';
        document.getElementById('recipe-time').value = recipe.time || '';
        document.getElementById('recipe-notes').value = recipe.notes || '';

        document.getElementById('ingredients-list').innerHTML = '';
        recipe.ingredients.forEach(ing => this.addIngredient(ing));
        if (recipe.ingredients.length === 0) this.addIngredient();

        document.getElementById('steps-list').innerHTML = '';
        recipe.steps.forEach(step => this.addStep(step));
        if (recipe.steps.length === 0) this.addStep();

        this.editorTags = new Set(recipe.tags);
        this.renderEditorTags();

        this.editorPhoto = { data: null, changed: false };
        this.renderEditorPhoto();
        if (recipe.hasPhoto) {
            this.getPhoto(id).then(data => {
                if (this.editingId !== id || this.editorPhoto.changed) return;
                this.editorPhoto.data = data || null;
                this.renderEditorPhoto();
            });
        }
    }

    addIngredient(data = null) {
        const container = document.getElementById('ingredients-list');
        const row = document.createElement('div');
        row.className = 'ingredient-row';
        const unit = data ? data.unit : '';
        const options = UNIT_GROUPS.map(group => `
            <optgroup label="${group.label}">
                ${group.units.map(([value, label]) => `<option value="${this.escapeHtml(value)}" ${unit === value ? 'selected' : ''}>${this.escapeHtml(label)}</option>`).join('')}
            </optgroup>`).join('');
        // Unité inconnue (ancien import) : on la garde pour ne pas la perdre
        const known = UNIT_GROUPS.some(g => g.units.some(([v]) => v === unit));
        const extra = unit && !known ? `<option value="${this.escapeHtml(unit)}" selected>${this.escapeHtml(unit)}</option>` : '';

        row.innerHTML = `
            <input type="text" placeholder="Nom" value="${data ? this.escapeHtml(data.name) : ''}">
            <input type="number" step="any" min="0" placeholder="Qté" value="${data && data.quantity != null ? data.quantity : ''}">
            <select>
                <option value="">-- Unité --</option>
                ${extra}
                ${options}
            </select>
            <button type="button" class="btn-remove" onclick="this.parentElement.remove()" aria-label="Retirer">✕</button>
        `;
        container.appendChild(row);
    }

    addStep(data = null) {
        const container = document.getElementById('steps-list');
        const row = document.createElement('div');
        row.className = 'step-row';
        row.innerHTML = `
            <textarea placeholder="Description de l'étape">${data ? this.escapeHtml(data.description) : ''}</textarea>
            <input type="text" placeholder="Temps (opt.)" value="${data && data.time ? this.escapeHtml(data.time) : ''}">
            <button type="button" class="btn-remove" onclick="this.parentElement.remove()" aria-label="Retirer">✕</button>
        `;
        container.appendChild(row);
    }

    renderEditorTags() {
        const el = document.getElementById('editor-tags');
        const custom = this.getAllTags().filter(t => !DEFAULT_TAGS.includes(t));
        const selectedOthers = [...this.editorTags].filter(t => !DEFAULT_TAGS.includes(t) && !custom.includes(t));
        const all = [...DEFAULT_TAGS, ...custom, ...selectedOthers];
        el.innerHTML = all.map(t => `
            <button type="button" class="chip ${this.editorTags.has(t) ? 'active' : ''}" data-tag="${this.escapeHtml(t)}">${this.escapeHtml(t)}</button>
        `).join('');
    }

    addCustomTag() {
        const input = document.getElementById('custom-tag');
        const value = input.value.trim().replace(/\s+/g, ' ');
        if (!value) return;
        // Réutilise une étiquette existante si elle s'écrit pareil (majuscules / accents)
        const existing = [...DEFAULT_TAGS, ...this.getAllTags(), ...this.editorTags]
            .find(t => this.normalize(t) === this.normalize(value));
        this.editorTags.add(existing || value);
        input.value = '';
        this.editorDirty = true;
        this.renderEditorTags();
    }

    renderEditorPhoto() {
        const el = document.getElementById('photo-editor');
        if (this.editorPhoto.data) {
            el.innerHTML = `
                <div class="photo-preview"><img alt="Aperçu de la photo"></div>
                <div class="photo-actions">
                    <button type="button" class="btn btn-sm" onclick="app.pickPhoto()">🔄 Changer</button>
                    <button type="button" class="btn btn-sm btn-danger" onclick="app.removePhoto()">🗑️ Retirer</button>
                </div>`;
            el.querySelector('img').src = this.editorPhoto.data;
        } else {
            el.innerHTML = '<button type="button" class="btn btn-sm" onclick="app.pickPhoto()">📷 Ajouter une photo</button>';
        }
    }

    pickPhoto() {
        document.getElementById('photo-input').click();
    }

    async handlePhoto(event) {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        try {
            this.editorPhoto = { data: await this.resizeImage(file), changed: true };
            this.editorDirty = true;
            this.renderEditorPhoto();
        } catch (error) {
            console.error(error);
            alert('❌ Impossible de lire cette image.');
        }
    }

    removePhoto() {
        this.editorPhoto = { data: null, changed: true };
        this.editorDirty = true;
        this.renderEditorPhoto();
    }

    // Réduit la photo (1000 px max, JPEG) pour qu'elle reste légère
    resizeImage(file, maxSize = 1000, quality = 0.75) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Image illisible'));
            };
            img.src = url;
        });
    }

    async saveRecipe() {
        const name = document.getElementById('recipe-name').value.trim();
        const persons = parseInt(document.getElementById('recipe-persons').value) || null;
        const quantity = parseInt(document.getElementById('recipe-quantity').value) || null;
        const time = document.getElementById('recipe-time').value.trim();
        const notes = document.getElementById('recipe-notes').value.trim();

        if (!name) {
            alert('Le nom de la recette est obligatoire');
            return;
        }

        if (!persons && !quantity) {
            alert('Veuillez indiquer au moins un nombre de personnes ou une quantité');
            return;
        }

        // Ingrédients (les lignes laissées vides sont ignorées)
        const ingredients = [];
        for (const row of document.querySelectorAll('#ingredients-list .ingredient-row')) {
            const inputs = row.querySelectorAll('input');
            const ingName = inputs[0].value.trim();
            const rawQty = inputs[1].value.trim();
            const unit = row.querySelector('select').value;

            if (!ingName && !rawQty) continue;
            if (!ingName) {
                alert('Un ingrédient a une quantité mais pas de nom');
                return;
            }
            const qty = rawQty === '' ? null : parseFloat(rawQty);
            if (qty !== null && (!Number.isFinite(qty) || qty <= 0)) {
                alert(`La quantité de « ${ingName} » n'est pas valide`);
                return;
            }
            if (qty !== null && !unit) {
                alert(`Choisis une unité pour « ${ingName} »`);
                return;
            }
            ingredients.push({ name: ingName, quantity: qty, unit: qty === null ? '' : unit });
        }

        if (ingredients.length === 0) {
            alert('Ajoutez au moins un ingrédient');
            return;
        }

        // Étapes (les étapes vides sont ignorées)
        const steps = [];
        for (const row of document.querySelectorAll('#steps-list .step-row')) {
            const description = row.querySelector('textarea').value.trim();
            const stepTime = row.querySelector('input').value.trim();
            if (description) steps.push({ description, time: stepTime });
        }

        const now = new Date().toISOString();
        const existing = this.editingId ? this.getRecipe(this.editingId) : null;
        const id = existing ? existing.id : this.generateId();

        let hasPhoto = existing ? !!existing.hasPhoto : false;
        if (this.editorPhoto.changed) {
            this.photoCache.delete(id);
            try {
                if (this.editorPhoto.data) {
                    await PhotoStore.set(id, this.editorPhoto.data);
                    hasPhoto = true;
                } else {
                    await PhotoStore.delete(id);
                    hasPhoto = false;
                }
            } catch (error) {
                console.error(error);
                hasPhoto = false;
                alert('⚠️ La photo n\'a pas pu être enregistrée. La recette est enregistrée sans photo.');
            }
        }

        const recipe = {
            id,
            name,
            persons,
            quantity,
            time,
            tags: [...this.editorTags],
            favorite: existing ? existing.favorite : false,
            notes,
            hasPhoto,
            ingredients,
            steps,
            createdAt: existing ? existing.createdAt : now,
            updatedAt: now
        };

        if (existing) {
            // Si les ingrédients ou étapes ont changé, les cases cochées ne correspondent plus
            const signature = r => JSON.stringify([r.ingredients.map(i => i.name), r.steps.map(s => s.description)]);
            if (signature(existing) !== signature(recipe)) {
                delete this.cooking[id];
                this.saveJSON(STORAGE.cooking, this.cooking);
            }
            this.recipes[this.recipes.findIndex(r => r.id === id)] = recipe;
        } else {
            this.recipes.push(recipe);
        }

        if (!this.saveData()) return;
        this.editorDirty = false;
        this.showRecipe(id, !!existing);
    }

    cancelEdit() {
        if (this.editorDirty && !confirm('Annuler les modifications ?')) return;
        this.editorDirty = false;
        if (this.editingId && this.getRecipe(this.editingId)) this.showRecipe(this.editingId, true);
        else this.showRecipeList();
    }

    // ===== LISTE DE COURSES (plusieurs recettes) =====
    addToShopping() {
        const recipe = this.getRecipe(this.currentRecipeId);
        if (!recipe) return;

        if (this.shopping.recipes.length === 0) this.shopping.checked = [];
        const entry = this.shopping.recipes.find(e => e.id === recipe.id);
        if (entry) entry.ratio = this.ratio;
        else this.shopping.recipes.push({ id: recipe.id, ratio: this.ratio });

        this.saveJSON(STORAGE.shopping, this.shopping);
        this.updateShoppingButton();
        this.showToast(entry ? 'Quantités mises à jour dans la liste de courses' : 'Ajoutée à la liste de courses 🛒', 'Voir la liste', () => this.showShopping('view'));
    }

    updateShoppingButton() {
        const btn = document.getElementById('add-shopping-btn');
        if (!btn) return;
        const entry = this.shopping.recipes.find(e => e.id === this.currentRecipeId);
        if (!entry) btn.textContent = '🛒 Ajouter à la liste de courses';
        else if (Math.abs(entry.ratio - this.ratio) > 1e-9) btn.textContent = '🛒 Mettre à jour la liste de courses';
        else btn.textContent = '✓ Dans la liste de courses';
    }

    renderShoppingList() {
        const content = document.getElementById('shopping-content');
        const entries = this.shopping.recipes
            .map(entry => ({ entry, recipe: this.getRecipe(entry.id) }))
            .filter(x => x.recipe);

        if (entries.length === 0) {
            content.innerHTML = `
                <p class="empty-message">
                    Ta liste de courses est vide.<br>
                    Ouvre une recette et appuie sur « 🛒 Ajouter à la liste de courses ».
                </p>`;
            return;
        }

        const items = this.buildShoppingItems(entries);
        const checked = new Set(this.shopping.checked);
        const ordered = [...items.filter(i => !checked.has(i.key)), ...items.filter(i => checked.has(i.key))];
        const remaining = items.filter(i => !checked.has(i.key)).length;

        content.innerHTML = `
            <div class="shopping-section">
                <h3>📖 Recettes (${entries.length})</h3>
                ${entries.map(({ entry, recipe }) => {
                    const type = recipe.persons ? 'persons' : 'quantity';
                    const label = recipe.persons ? 'pers.' : 'portions';
                    const value = recipe[type] ? this.formatNumber(recipe[type] * entry.ratio) : '';
                    return `
                    <div class="shopping-recipe">
                        <span class="shopping-recipe-name" onclick="app.showRecipe(${recipe.id})">${this.escapeHtml(recipe.name)}</span>
                        ${recipe[type] ? `
                        <div class="counter counter-sm">
                            <button type="button" onclick="app.adjustShoppingPortion(${recipe.id}, -1)" aria-label="Moins">−</button>
                            <span>${value} ${label}</span>
                            <button type="button" onclick="app.adjustShoppingPortion(${recipe.id}, 1)" aria-label="Plus">+</button>
                        </div>` : ''}
                        <button type="button" class="btn-remove" onclick="app.removeFromShopping(${recipe.id})" aria-label="Retirer de la liste">✕</button>
                    </div>`;
                }).join('')}
            </div>

            <div class="shopping-section">
                <div class="section-header">
                    <h3>🧺 À acheter</h3>
                    <span class="progress">${remaining === 0 ? '✅ Tout est pris !' : `${remaining} restant${remaining > 1 ? 's' : ''}`}</span>
                </div>
                <div id="shopping-items" class="shopping-items">
                    ${ordered.map(item => `
                        <label class="shopping-item check-row ${checked.has(item.key) ? 'checked' : ''}" data-flip="${this.escapeHtml(item.key)}">
                            <input type="checkbox" data-key="${this.escapeHtml(item.key)}" ${checked.has(item.key) ? 'checked' : ''}>
                            <span class="shopping-item-text">
                                <strong>${this.escapeHtml(item.name)}</strong> – ${item.display}
                                ${entries.length > 1 ? `<small>${item.recipes.map(n => this.escapeHtml(n)).join(', ')}</small>` : ''}
                            </span>
                        </label>
                    `).join('')}
                </div>
            </div>

            <div class="shopping-actions">
                <button class="btn btn-info" onclick="app.printPage()">🖨️ Imprimer</button>
                ${checked.size ? '<button class="btn btn-warning" onclick="app.uncheckAllShopping()">🔄 Tout décocher</button>' : ''}
                <button class="btn btn-danger" onclick="app.clearShopping()">🗑️ Vider la liste</button>
            </div>
        `;
    }

    // Regroupe les ingrédients identiques et additionne les quantités
    buildShoppingItems(entries) {
        const groups = new Map();
        for (const { entry, recipe } of entries) {
            for (const ing of recipe.ingredients) {
                const conversion = UNIT_CONVERSIONS[ing.unit];
                const unitKey = ing.quantity == null ? 'qs' : (conversion ? conversion.family : ing.unit);
                const key = `${this.normalizeIngredientName(ing.name)}|${unitKey}`;
                let group = groups.get(key);
                if (!group) {
                    group = { key, name: ing.name, unitKey, parts: [], recipes: new Set() };
                    groups.set(key, group);
                }
                group.recipes.add(recipe.name);
                if (ing.quantity != null) group.parts.push({ qty: ing.quantity * entry.ratio, unit: ing.unit });
            }
        }

        return [...groups.values()].map(group => {
            let display;
            if (group.unitKey === 'qs') {
                display = this.formatQuantity(null);
            } else {
                const units = new Set(group.parts.map(p => p.unit));
                if (units.size === 1) {
                    const total = group.parts.reduce((sum, p) => sum + p.qty, 0);
                    display = this.formatQuantity(total, group.parts[0].unit);
                } else {
                    const base = UNIT_CONVERSIONS[group.parts[0].unit].base;
                    const total = group.parts.reduce((sum, p) => sum + p.qty * UNIT_CONVERSIONS[p.unit].factor, 0);
                    display = this.formatQuantity(total, base);
                }
            }
            return { key: group.key, name: group.name, display, recipes: [...group.recipes] };
        }).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    }

    toggleShoppingItem(key) {
        const container = document.getElementById('shopping-items');
        this.animateReorder(container, () => {
            this.shopping.checked = this.toggleInList(this.shopping.checked, key);
            this.saveJSON(STORAGE.shopping, this.shopping);
            this.renderShoppingList();
        }, '#shopping-items');
    }

    adjustShoppingPortion(id, delta) {
        const recipe = this.getRecipe(id);
        const entry = this.shopping.recipes.find(e => e.id === id);
        if (!recipe || !entry) return;
        const base = recipe.persons || recipe.quantity;
        if (!base) return;
        const next = Math.max(1, Math.round(base * entry.ratio) + delta);
        entry.ratio = next / base;
        this.saveJSON(STORAGE.shopping, this.shopping);
        this.renderShoppingList();
    }

    removeFromShopping(id) {
        this.shopping.recipes = this.shopping.recipes.filter(e => e.id !== id);
        if (this.shopping.recipes.length === 0) this.shopping.checked = [];
        this.saveJSON(STORAGE.shopping, this.shopping);
        this.renderShoppingList();
    }

    uncheckAllShopping() {
        this.shopping.checked = [];
        this.saveJSON(STORAGE.shopping, this.shopping);
        this.renderShoppingList();
    }

    clearShopping() {
        if (!confirm('Vider toute la liste de courses ?')) return;
        this.shopping = { recipes: [], checked: [] };
        this.saveJSON(STORAGE.shopping, this.shopping);
        this.renderShoppingList();
    }

    // ===== FORMATAGE =====
    formatQuantity(qty, unit = '') {
        if (qty == null || !Number.isFinite(qty)) return 'à volonté';
        unit = unit || '';

        if (NON_DIVISIBLE_UNITS.includes(unit.toLowerCase())) {
            // Arrondi au quart / tiers le plus proche, jamais « 0 »
            const candidates = [0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1];
            let whole = Math.floor(qty);
            let fraction = candidates.reduce((best, c) => Math.abs(c - (qty - whole)) < Math.abs(best - (qty - whole)) ? c : best);
            if (whole === 0 && fraction === 0) fraction = 0.25;
            if (fraction === 1) {
                whole += 1;
                fraction = 0;
            }
            const rounded = whole + fraction;
            const symbols = new Map([[0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾']]);
            const fractionText = fraction ? symbols.get(fraction) : '';
            const number = whole && fractionText ? `${whole} ${fractionText}` : (whole ? `${whole}` : fractionText);
            const approx = Math.abs(rounded - qty) > 0.02 ? '≈ ' : '';
            return `${approx}${number} ${this.pluralize(unit, rounded)}`;
        }

        // Conversions automatiques
        let q = qty;
        let u = unit;
        if (u === 'mg' && q >= 1000) { q /= 1000; u = 'g'; }
        if (u === 'g' && q >= 1000) { q /= 1000; u = 'kg'; }
        if (u === 'kg' && q < 1) { q *= 1000; u = 'g'; }
        if (u === 'ml' && q >= 1000) { q /= 1000; u = 'L'; }
        if (u === 'cl' && q >= 100) { q /= 100; u = 'L'; }
        if (u === 'L' && q < 1) { q *= 1000; u = 'ml'; }

        return `${this.formatNumber(q)} ${this.pluralize(u, q)}`.trim();
    }

    // 333,33 → « 333 » ; 12,54 → « 12,5 » ; 1,333 → « 1,33 »
    formatNumber(n) {
        const decimals = n >= 100 ? 0 : (n >= 10 ? 1 : 2);
        const factor = Math.pow(10, decimals);
        const rounded = Math.round(n * factor) / factor;
        return String(rounded).replace('.', ',');
    }

    pluralize(unit, qty) {
        return qty >= 2 && PLURALS[unit] ? PLURALS[unit] : unit;
    }

    // ===== THÈME =====
    changeTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem(STORAGE.theme, theme);
    }

    loadTheme() {
        const saved = localStorage.getItem(STORAGE.theme) || 'light';
        document.documentElement.setAttribute('data-theme', saved);
        document.getElementById('theme-select').value = saved;
    }

    // ===== IMPORT / EXPORT =====
    async exportData() {
        const recipes = await Promise.all(this.recipes.map(async recipe => {
            if (!recipe.hasPhoto) return { ...recipe };
            const photo = await this.getPhoto(recipe.id);
            return photo ? { ...recipe, photo } : { ...recipe, hasPhoto: false };
        }));

        const data = {
            app: 'Q\'Histo',
            version: APP_VERSION,
            exportDate: new Date().toISOString(),
            recipes
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
        a.href = url;
        a.download = `QHisto_Save_${date}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);

        localStorage.setItem(STORAGE.lastExport, new Date().toISOString());
        this.renderMenu();
        this.renderBackupInfo();
    }

    importData(mode) {
        this.importMode = mode;
        if (mode === 'replace' && !confirm('⚠️ ATTENTION : cet import va ÉCRASER toutes vos recettes actuelles. Continuer ?')) {
            return;
        }
        document.getElementById('import-file').click();
    }

    async handleImport(event) {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;

        let data;
        try {
            data = JSON.parse(await file.text());
        } catch (error) {
            console.error(error);
            alert('❌ Ce fichier n\'est pas une sauvegarde Q\'Histo valide.');
            return;
        }
        if (!data || !Array.isArray(data.recipes)) {
            alert('❌ Ce fichier n\'est pas une sauvegarde Q\'Histo valide.');
            return;
        }

        const isPhoto = p => typeof p === 'string' && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(p);
        const takenIds = new Set(this.importMode === 'merge' ? this.recipes.map(r => r.id) : []);
        const incoming = [];
        for (const raw of data.recipes) {
            const recipe = this.normalizeRecipe(raw);
            if (!recipe) continue;
            incoming.push({ recipe, photo: isPhoto(raw.photo) ? raw.photo : null });
        }

        if (incoming.length === 0) {
            alert('❌ Aucune recette valide dans ce fichier.');
            return;
        }

        let added = 0, updated = 0, skipped = 0;
        let result;
        if (this.importMode === 'merge') {
            result = [...this.recipes];
            for (const item of incoming) {
                const index = result.findIndex(r => r.id === item.recipe.id);
                if (index === -1) {
                    result.push(item.recipe);
                    added++;
                } else if ((item.recipe.updatedAt || '') > (result[index].updatedAt || '')) {
                    result[index] = item.recipe;
                    updated++;
                } else {
                    item.skip = true;
                    skipped++;
                }
            }
        } else {
            // Évite les doublons d'identifiant dans le fichier
            for (const item of incoming) {
                if (takenIds.has(item.recipe.id)) item.recipe.id = this.generateId(takenIds);
                takenIds.add(item.recipe.id);
            }
            result = incoming.map(i => i.recipe);
            added = result.length;
            try { await PhotoStore.clear(); } catch (e) { console.error(e); }
            this.cooking = {};
            this.saveJSON(STORAGE.cooking, this.cooking);
        }

        // Photos
        this.photoCache.clear();
        for (const item of incoming) {
            if (item.skip) continue;
            try {
                if (item.photo) {
                    await PhotoStore.set(item.recipe.id, item.photo);
                    item.recipe.hasPhoto = true;
                } else {
                    item.recipe.hasPhoto = false;
                    await PhotoStore.delete(item.recipe.id);
                }
            } catch (error) {
                console.error(error);
                item.recipe.hasPhoto = false;
            }
        }

        this.recipes = result;
        if (!this.saveData()) return;
        this.updateRecipeCount();
        this.renderMenu();

        if (this.importMode === 'merge') {
            alert(`✅ Import terminé : ${added} ajoutée(s), ${updated} mise(s) à jour, ${skipped} déjà à jour.`);
        } else {
            alert(`✅ Import réussi : ${added} recette(s).`);
        }
    }

    renderBackupInfo() {
        const el = document.getElementById('last-export');
        if (el) {
            const last = localStorage.getItem(STORAGE.lastExport);
            el.textContent = last ? new Date(last).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : 'jamais';
        }
        const storageEl = document.getElementById('storage-status');
        if (storageEl) {
            storageEl.textContent = this.persisted === true
                ? '🔒 protégé (le navigateur ne l\'effacera pas de lui-même)'
                : 'non garanti : pense à exporter régulièrement';
        }
    }

    // ===== STOCKAGE =====
    async requestPersistentStorage() {
        try {
            if (navigator.storage && navigator.storage.persist) {
                this.persisted = await navigator.storage.persisted() || await navigator.storage.persist();
            }
        } catch (e) {
            this.persisted = false;
        }
        this.renderBackupInfo();
    }

    saveData() {
        try {
            localStorage.setItem(STORAGE.recipes, JSON.stringify(this.recipes));
            return true;
        } catch (error) {
            console.error(error);
            alert('⚠️ Impossible d\'enregistrer : le stockage du navigateur est plein ou indisponible. Exporte tes recettes pour ne rien perdre.');
            return false;
        }
    }

    loadData() {
        const saved = localStorage.getItem(STORAGE.recipes);
        if (!saved) {
            this.recipes = [];
            return;
        }
        try {
            const parsed = JSON.parse(saved);
            const taken = new Set();
            this.recipes = (Array.isArray(parsed) ? parsed : [])
                .map(r => this.normalizeRecipe(r))
                .filter(Boolean)
                .map(r => {
                    if (taken.has(r.id)) r.id = this.generateId(taken);
                    taken.add(r.id);
                    return r;
                });
        } catch (error) {
            console.error(error);
            try { localStorage.setItem('qhisto-recipes-corrupt-backup', saved); } catch (e) { /* plein */ }
            this.recipes = [];
            this.loadError = true;
        }
    }

    // Accepte les anciennes recettes (v1) et les fichiers importés, et les met au format actuel
    normalizeRecipe(raw) {
        if (!raw || typeof raw !== 'object' || !raw.name || !Array.isArray(raw.ingredients)) return null;

        const text = v => (v == null ? '' : String(v)).trim();
        const positiveInt = v => { const n = parseInt(v); return Number.isFinite(n) && n > 0 ? n : null; };
        const positiveNumber = v => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
        const now = new Date().toISOString();
        const id = Number(raw.id);

        return {
            id: Number.isFinite(id) && id > 0 ? id : this.generateId(),
            name: text(raw.name),
            persons: positiveInt(raw.persons),
            quantity: positiveInt(raw.quantity),
            time: text(raw.time),
            tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.map(text).filter(Boolean))] : [],
            favorite: !!raw.favorite,
            notes: text(raw.notes),
            hasPhoto: !!raw.hasPhoto,
            ingredients: raw.ingredients
                .filter(i => i && text(i.name))
                .map(i => {
                    const qty = positiveNumber(i.quantity);
                    return { name: text(i.name), quantity: qty, unit: qty === null ? '' : text(i.unit) };
                }),
            steps: (Array.isArray(raw.steps) ? raw.steps : [])
                .filter(s => s && text(s.description))
                .map(s => ({ description: text(s.description), time: text(s.time) })),
            createdAt: text(raw.createdAt) || now,
            updatedAt: text(raw.updatedAt) || text(raw.createdAt) || now
        };
    }

    loadJSON(key, fallback) {
        try {
            const value = JSON.parse(localStorage.getItem(key));
            return value && typeof value === 'object' ? value : fallback;
        } catch (e) {
            return fallback;
        }
    }

    saveJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.error(e);
        }
    }

    updateRecipeCount() {
        const countEl = document.getElementById('recipe-count');
        if (countEl) countEl.textContent = this.recipes.length;
    }

    // ===== UTILITAIRES =====
    getRecipe(id) {
        return this.recipes.find(r => r.id === id);
    }

    getAllTags() {
        const tags = new Set();
        this.recipes.forEach(r => r.tags.forEach(t => tags.add(t)));
        return [...tags].sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    }

    async getPhoto(id) {
        if (this.photoCache.has(id)) return this.photoCache.get(id);
        try {
            const data = await PhotoStore.get(id);
            if (data) this.photoCache.set(id, data);
            return data || null;
        } catch (e) {
            return null;
        }
    }

    generateId(taken = null) {
        let id = Date.now();
        while (this.recipes.some(r => r.id === id) || (taken && taken.has(id))) id++;
        return id;
    }

    toggleInList(list, value) {
        return list.includes(value) ? list.filter(v => v !== value) : [...list, value];
    }

    // Texte sans majuscules ni accents, pour la recherche
    normalize(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/œ/g, 'oe')
            .replace(/æ/g, 'ae')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .trim();
    }

    // « Œufs » et « oeuf » deviennent le même ingrédient
    normalizeIngredientName(name) {
        return this.normalize(name)
            .replace(/[^a-z0-9]+/g, ' ')
            .split(' ')
            .filter(Boolean)
            .map(word => word.length > 3 ? word.replace(/[sx]$/, '') : word)
            .join(' ');
    }

    // Fait glisser les éléments vers leur nouvelle place
    animateReorder(container, mutate, selector = null) {
        if (!container) {
            mutate();
            return;
        }
        const positions = new Map();
        container.querySelectorAll('[data-flip]').forEach(el => positions.set(el.dataset.flip, el.getBoundingClientRect().top));

        mutate();

        const target = selector ? document.querySelector(selector) : container;
        if (!target || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        target.querySelectorAll('[data-flip]').forEach(el => {
            const before = positions.get(el.dataset.flip);
            if (before === undefined || !el.animate) return;
            const delta = before - el.getBoundingClientRect().top;
            if (Math.abs(delta) > 1) {
                el.animate(
                    [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
                    { duration: 400, easing: 'cubic-bezier(.2, .8, .2, 1)' }
                );
            }
        });
    }

    showToast(message, actionLabel = null, action = null) {
        const toast = document.getElementById('toast');
        toast.innerHTML = `<span>${this.escapeHtml(message)}</span>${actionLabel ? `<button class="link-btn">${this.escapeHtml(actionLabel)}</button>` : ''}`;
        if (action) toast.querySelector('button').addEventListener('click', () => {
            toast.classList.remove('show');
            action();
        });
        toast.classList.add('show');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
    }

    escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}

// Initialisation
const app = new QHistoApp();
