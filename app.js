/**
 * Q'HISTO - Application de gestion de recettes
 * Version minimaliste
 */

class QHistoApp {
    constructor() {
        this.recipes = [];
        this.currentRecipeId = null;
        this.currentView = null;
        this.shoppingList = [];
        this.loadData();
        this.init();
    }

    // ===== INITIALISATION =====
    init() {
        this.loadTheme();
        this.updateRecipeCount();
        
        // Formulaire
        document.getElementById('recipe-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveRecipe();
        });

        // Recherche
        document.getElementById('search').addEventListener('input', (e) => {
            this.searchRecipes(e.target.value);
        });

        // Ajouter un ingrédient et une étape par défaut
        this.addIngredient();
        this.addStep();
    }

    // ===== NAVIGATION =====
    showMenu() {
        this.showPage('menu-page');
    }

    showRecipeList() {
        this.showPage('list-page');
        this.renderRecipeList();
    }

    showEditor(recipeId = null) {
        this.currentRecipeId = recipeId;
        this.showPage('editor-page');
        
        if (recipeId) {
            document.getElementById('editor-title').textContent = 'Modifier la recette';
            this.loadRecipeInEditor(recipeId);
        } else {
            document.getElementById('editor-title').textContent = 'Nouvelle recette';
            this.resetEditor();
        }
    }

    showRecipe(id) {
        this.currentRecipeId = id;
        this.currentView = 'view';
        this.showPage('view-page');
        this.renderRecipe(id);
    }

    showInfo() {
        this.showPage('info-page');
        this.updateRecipeCount();
    }

    showShopping() {
        this.currentView = 'shopping';
        this.showPage('shopping-page');
        this.renderShoppingList();
    }

    backFromShopping() {
        if (this.currentView === 'shopping') {
            this.showRecipe(this.currentRecipeId);
        }
    }

    showPage(pageId) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.getElementById(pageId).classList.add('active');
    }

    // ===== GESTION RECETTES =====
    renderRecipeList(filtered = null) {
        const list = document.getElementById('recipe-list');
        const recipes = filtered || this.recipes;

        if (recipes.length === 0) {
            list.innerHTML = '<p style="text-align:center; color: var(--text-secondary);">Aucune recette. Ajoutez-en une !</p>';
            return;
        }

        list.innerHTML = recipes.map(recipe => `
            <div class="recipe-item" onclick="app.showRecipe(${recipe.id})">
                <strong>${this.escapeHtml(recipe.name)}</strong>
                ${recipe.persons ? `<span style="color: var(--text-secondary); margin-left: 10px;">👥 ${recipe.persons} pers.</span>` : ''}
                ${recipe.quantity ? `<span style="color: var(--text-secondary); margin-left: 10px;">📦 ${recipe.quantity} portions</span>` : ''}
            </div>
        `).join('');
    }

    searchRecipes(term) {
        if (!term.trim()) {
            this.renderRecipeList();
            return;
        }

        const filtered = this.recipes.filter(r => 
            r.name.toLowerCase().includes(term.toLowerCase())
        );
        this.renderRecipeList(filtered);
    }

    renderRecipe(id) {
        const recipe = this.recipes.find(r => r.id === id);
        if (!recipe) return;

        document.getElementById('view-title').textContent = recipe.name;

        const content = document.getElementById('view-content');
        content.innerHTML = `
            <div class="recipe-view">
                ${recipe.time ? `<p><strong>⏱️ Temps de cuisson :</strong> ${this.escapeHtml(recipe.time)}</p>` : ''}

                <div class="recipe-controls">
                    ${recipe.persons ? `
                        <div class="control-group">
                            <label>Nombre de personnes</label>
                            <div class="counter">
                                <button onclick="app.adjustPortion('persons', -1)">−</button>
                                <span id="current-persons">${recipe.persons}</span>
                                <button onclick="app.adjustPortion('persons', 1)">+</button>
                            </div>
                        </div>
                    ` : ''}
                    ${recipe.quantity ? `
                        <div class="control-group">
                            <label>Quantité (portions)</label>
                            <div class="counter">
                                <button onclick="app.adjustPortion('quantity', -1)">−</button>
                                <span id="current-quantity">${recipe.quantity}</span>
                                <button onclick="app.adjustPortion('quantity', 1)">+</button>
                            </div>
                        </div>
                    ` : ''}
                </div>

                <div class="recipe-section">
                    <h3>🥘 Ingrédients</h3>
                    <div id="ingredients-display">
                        ${this.renderIngredients(recipe)}
                    </div>
                </div>

                ${recipe.steps.length > 0 ? `
                    <div class="recipe-section">
                        <h3>📝 Préparation</h3>
                        ${recipe.steps.map((step, i) => `
                            <div class="step-item">
                                <div class="step-number">Étape ${i + 1}</div>
                                <div>${this.escapeHtml(step.description)}</div>
                                ${step.time ? `<div style="color: var(--text-secondary); margin-top: 5px;">⏱️ ${this.escapeHtml(step.time)}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                ` : ''}

                <div class="recipe-actions">
                    <button class="btn btn-primary" onclick="app.showShopping()">
                        📝 Générer liste de courses
                    </button>
                    <button class="btn btn-warning" onclick="app.showEditor(${recipe.id})">
                        ✏️ Modifier
                    </button>
                    <button class="btn btn-danger" onclick="app.deleteRecipe(${recipe.id})">
                        🗑️ Supprimer
                    </button>
                </div>
            </div>
        `;

        // Stocker les valeurs de base pour les calculs
        this.baseRecipe = JSON.parse(JSON.stringify(recipe));
    }

    renderIngredients(recipe) {
        return recipe.ingredients.map(ing => `
            <div class="ingredient-item">
                <span>${this.escapeHtml(ing.name)}</span>
                <strong>${this.formatQuantity(ing.quantity, ing.unit)}</strong>
            </div>
        `).join('');
    }

    adjustPortion(type, delta) {
        const recipe = this.recipes.find(r => r.id === this.currentRecipeId);
        if (!recipe) return;

        const currentEl = document.getElementById(`current-${type}`);
        let current = parseInt(currentEl.textContent);
        let newValue = Math.max(1, current + delta);
        
        currentEl.textContent = newValue;

        // Recalculer les ingrédients
        const original = type === 'persons' ? this.baseRecipe.persons : this.baseRecipe.quantity;
        const ratio = newValue / original;

        const adjusted = JSON.parse(JSON.stringify(this.baseRecipe));
        adjusted.ingredients = adjusted.ingredients.map(ing => ({
            ...ing,
            quantity: ing.quantity * ratio
        }));

        document.getElementById('ingredients-display').innerHTML = this.renderIngredients(adjusted);
    }

    deleteRecipe(id) {
        if (!confirm('Supprimer cette recette ?')) return;

        this.recipes = this.recipes.filter(r => r.id !== id);
        this.saveData();
        this.showRecipeList();
    }

    // ===== ÉDITEUR =====
    resetEditor() {
        document.getElementById('recipe-form').reset();
        document.getElementById('ingredients-list').innerHTML = '';
        document.getElementById('steps-list').innerHTML = '';
        this.addIngredient();
        this.addStep();
    }

    loadRecipeInEditor(id) {
        const recipe = this.recipes.find(r => r.id === id);
        if (!recipe) return;

        document.getElementById('recipe-name').value = recipe.name;
        document.getElementById('recipe-persons').value = recipe.persons || '';
        document.getElementById('recipe-quantity').value = recipe.quantity || '';
        document.getElementById('recipe-time').value = recipe.time || '';

        // Ingrédients
        document.getElementById('ingredients-list').innerHTML = '';
        recipe.ingredients.forEach(ing => {
            this.addIngredient(ing);
        });

        // Étapes
        document.getElementById('steps-list').innerHTML = '';
        recipe.steps.forEach(step => {
            this.addStep(step);
        });
    }

    addIngredient(data = null) {
        const container = document.getElementById('ingredients-list');
        const row = document.createElement('div');
        row.className = 'ingredient-row';
        row.innerHTML = `
            <input type="text" placeholder="Nom" value="${data ? this.escapeHtml(data.name) : ''}" required>
            <input type="number" step="any" placeholder="Qté" value="${data ? data.quantity : ''}" required>
            <select required>
                <option value="">-- Unité --</option>
                <optgroup label="Masse">
                    <option value="mg" ${data && data.unit === 'mg' ? 'selected' : ''}>mg (milligramme)</option>
                    <option value="g" ${data && data.unit === 'g' ? 'selected' : ''}>g (gramme)</option>
                    <option value="kg" ${data && data.unit === 'kg' ? 'selected' : ''}>kg (kilogramme)</option>
                </optgroup>
                <optgroup label="Volume">
                    <option value="ml" ${data && data.unit === 'ml' ? 'selected' : ''}>ml (millilitre)</option>
                    <option value="cl" ${data && data.unit === 'cl' ? 'selected' : ''}>cl (centilitre)</option>
                    <option value="L" ${data && data.unit === 'L' ? 'selected' : ''}>L (litre)</option>
                </optgroup>
                <optgroup label="Mesures cuisine">
                    <option value="c. à café" ${data && data.unit === 'c. à café' ? 'selected' : ''}>c. à café (cuillère à café)</option>
                    <option value="c. à soupe" ${data && data.unit === 'c. à soupe' ? 'selected' : ''}>c. à soupe (cuillère à soupe)</option>
                    <option value="tasse" ${data && data.unit === 'tasse' ? 'selected' : ''}>tasse</option>
                    <option value="cup" ${data && data.unit === 'cup' ? 'selected' : ''}>cup</option>
                </optgroup>
                <optgroup label="Unités non divisibles">
                    <option value="pincée" ${data && data.unit === 'pincée' ? 'selected' : ''}>pincée</option>
                    <option value="gousse" ${data && data.unit === 'gousse' ? 'selected' : ''}>gousse</option>
                    <option value="œuf" ${data && data.unit === 'œuf' ? 'selected' : ''}>œuf</option>
                    <option value="pièce" ${data && data.unit === 'pièce' ? 'selected' : ''}>pièce</option>
                    <option value="tranche" ${data && data.unit === 'tranche' ? 'selected' : ''}>tranche</option>
                    <option value="feuille" ${data && data.unit === 'feuille' ? 'selected' : ''}>feuille</option>
                    <option value="branche" ${data && data.unit === 'branche' ? 'selected' : ''}>branche</option>
                </optgroup>
            </select>
            <button type="button" class="btn-remove" onclick="this.parentElement.remove()">✕</button>
        `;
        container.appendChild(row);
    }

    addStep(data = null) {
        const container = document.getElementById('steps-list');
        const row = document.createElement('div');
        row.className = 'step-row';
        row.innerHTML = `
            <textarea placeholder="Description de l'étape" required>${data ? this.escapeHtml(data.description) : ''}</textarea>
            <input type="text" placeholder="Temps (opt.)" value="${data && data.time ? this.escapeHtml(data.time) : ''}">
            <button type="button" class="btn-remove" onclick="this.parentElement.remove()">✕</button>
        `;
        container.appendChild(row);
    }

    saveRecipe() {
    const name = document.getElementById('recipe-name').value.trim();
    const persons = parseInt(document.getElementById('recipe-persons').value) || null;
    const quantity = parseInt(document.getElementById('recipe-quantity').value) || null;
    const time = document.getElementById('recipe-time').value.trim();

    if (!name) {
        alert('Le nom de la recette est obligatoire');
        return;
    }

    if (!persons && !quantity) {
        alert('Veuillez indiquer au moins un nombre de personnes ou une quantité');
        return;
    }

    // Récupérer les ingrédients
    const ingredientRows = document.querySelectorAll('#ingredients-list .ingredient-row');
    const ingredients = Array.from(ingredientRows).map(row => {
        const inputs = row.querySelectorAll('input');
        const select = row.querySelector('select');
        return {
            name: inputs[0].value.trim(),
            quantity: parseFloat(inputs[1].value),
            unit: select.value
        };
    });

    if (ingredients.length === 0) {
        alert('Ajoutez au moins un ingrédient');
        return;
    }

    // Vérifier que tous les ingrédients ont une unité
    if (ingredients.some(ing => !ing.unit)) {
        alert('Veuillez sélectionner une unité pour tous les ingrédients');
        return;
    }

    // Récupérer les étapes
    const stepRows = document.querySelectorAll('#steps-list .step-row');
    const steps = Array.from(stepRows).map(row => {
        const textarea = row.querySelector('textarea');
        const timeInput = row.querySelectorAll('input')[0];
        return {
            description: textarea.value.trim(),
            time: timeInput.value.trim()
        };
    });

    // Calculer les portions unitaires
    const unitIngredients = ingredients.map(ing => ({
        ...ing,
        quantity: persons ? ing.quantity / persons : quantity ? ing.quantity / quantity : ing.quantity
    }));

    const recipe = {
        id: this.currentRecipeId || Date.now(),
        name,
        persons,
        quantity,
        time,
        ingredients,
        unitIngredients,
        steps,
        createdAt: this.currentRecipeId ? 
            this.recipes.find(r => r.id === this.currentRecipeId).createdAt : 
            new Date().toISOString()
    };

    if (this.currentRecipeId) {
        const index = this.recipes.findIndex(r => r.id === this.currentRecipeId);
        this.recipes[index] = recipe;
    } else {
        this.recipes.push(recipe);
    }

    this.saveData();
    this.showRecipeList();
}

    cancelEdit() {
        if (confirm('Annuler les modifications ?')) {
            this.showRecipeList();
        }
    }

    // ===== LISTE DE COURSES =====
    renderShoppingList() {
        const recipe = this.recipes.find(r => r.id === this.currentRecipeId);
        if (!recipe) return;

        const personsEl = document.getElementById('current-persons');
        const quantityEl = document.getElementById('current-quantity');
        
        let ratio = 1;
        if (personsEl) {
            ratio = parseInt(personsEl.textContent) / recipe.persons;
        } else if (quantityEl) {
            ratio = parseInt(quantityEl.textContent) / recipe.quantity;
        }

        const adjusted = recipe.ingredients.map(ing => ({
            ...ing,
            quantity: ing.quantity * ratio
        }));

        const list = document.getElementById('shopping-list');
        list.innerHTML = adjusted.map((ing, i) => `
            <div class="shopping-item" id="shop-${i}">
                <input type="checkbox" onchange="app.toggleShoppingItem(${i})">
                <span>
                    <strong>${this.escapeHtml(ing.name)}</strong>
                    - ${this.formatQuantity(ing.quantity, ing.unit)}
                </span>
            </div>
        `).join('');

        this.shoppingList = adjusted;
    }

    toggleShoppingItem(index) {
        const item = document.getElementById(`shop-${index}`);
        item.classList.toggle('checked');
    }

    clearShopping() {
        this.shoppingList = [];
        this.backFromShopping();
    }

    // ===== FORMATAGE =====
    formatQuantity(qty, unit) {
        const nonDivisible = ['pincée', 'gousse', 'œuf', 'oeuf', 'pièce', 'tranche', 'feuille', 'branche'];
        const isNonDivisible = nonDivisible.some(u => unit.toLowerCase().includes(u));

        if (isNonDivisible) {
            // Fractions pour unités non divisibles
            if (qty < 1) {
                if (Math.abs(qty - 0.25) < 0.01) return `¼ ${unit}`;
                if (Math.abs(qty - 0.33) < 0.05) return `⅓ ${unit}`;
                if (Math.abs(qty - 0.5) < 0.01) return `½ ${unit}`;
                if (Math.abs(qty - 0.67) < 0.05) return `⅔ ${unit}`;
                if (Math.abs(qty - 0.75) < 0.01) return `¾ ${unit}`;
            }
            return `${Math.round(qty)} ${unit}`;
        }

        // Conversions automatiques
        if (unit === 'g' && qty >= 1000) {
            return `${(qty / 1000).toFixed(2).replace(/\.?0+$/, '')} kg`;
        }
        if (unit === 'kg' && qty < 1) {
            return `${(qty * 1000).toFixed(0)} g`;
        }
        if (unit === 'ml' && qty >= 1000) {
            return `${(qty / 1000).toFixed(2).replace(/\.?0+$/, '')} L`;
        }
        if (unit === 'L' && qty < 1) {
            return `${(qty * 1000).toFixed(0)} ml`;
        }
        if (unit === 'cl' && qty >= 100) {
            return `${(qty / 100).toFixed(2).replace(/\.?0+$/, '')} L`;
        }
        if (unit === 'mg' && qty >= 1000) {
            return `${(qty / 1000).toFixed(2).replace(/\.?0+$/, '')} g`;
        }

        // Affichage standard
        if (qty % 1 === 0) {
            return `${qty} ${unit}`;
        }
        
        return `${qty.toFixed(2).replace(/\.?0+$/, '')} ${unit}`;
    }

    // ===== THÈME =====
    changeTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('qhisto-theme', theme);
    }

    loadTheme() {
        const saved = localStorage.getItem('qhisto-theme') || 'light';
        document.documentElement.setAttribute('data-theme', saved);
        document.getElementById('theme-select').value = saved;
    }

    // ===== IMPORT/EXPORT =====
    exportData() {
        const data = {
            version: '1.0.0',
            exportDate: new Date().toISOString(),
            recipes: this.recipes
        };

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        
        const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
        a.href = url;
        a.download = `QHisto_Save_${date}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    importData() {
        if (!confirm('⚠️ ATTENTION : L\'import va ÉCRASER toutes vos recettes actuelles. Continuer ?')) {
            return;
        }
        document.getElementById('import-file').click();
    }

    handleImport(event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (data.recipes && Array.isArray(data.recipes)) {
                    this.recipes = data.recipes;
                    this.saveData();
                    this.updateRecipeCount();
                    alert('✅ Import réussi !');
                } else {
                    alert('❌ Fichier invalide');
                }
            } catch (error) {
                alert('❌ Erreur lors de l\'import');
                console.error(error);
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    // ===== STOCKAGE =====
    saveData() {
        localStorage.setItem('qhisto-recipes', JSON.stringify(this.recipes));
    }

    loadData() {
        const saved = localStorage.getItem('qhisto-recipes');
        this.recipes = saved ? JSON.parse(saved) : [];
    }

    updateRecipeCount() {
        const countEl = document.getElementById('recipe-count');
        if (countEl) {
            countEl.textContent = this.recipes.length;
        }
    }

    // ===== UTILITAIRES =====
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialisation
const app = new QHistoApp();
