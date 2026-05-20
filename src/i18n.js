/**
 * i18n module for Voyage TER.
 *
 * ╭────────────────────────────────────────────────────────────────────────╮
 * │ Copyright (C) 2026-present  Ulysse Buonomo                             │
 * │                                                                        │
 * │ This program is free software: you can redistribute it and/or modify   │
 * │ it under the terms of the GNU General Public License as published by   │
 * │ the Free Software Foundation, either version 3 of the License, or      │
 * │  (at your option) any later version.                                   │
 * │                                                                        │
 * │ This program is distributed in the hope that it will be useful,        │
 * │ but WITHOUT ANY WARRANTY; without even the implied warranty of         │
 * │ MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the          │
 * │ GNU General Public License for more details.                           │
 * │                                                                        │
 * │ You should have received a copy of the GNU General Public License      │
 * │ along with this program.  If not, see <https://www.gnu.org/licenses/>. │
 * ╰────────────────────────────────────────────────────────────────────────╯
 *
 * Usage:
 *   import { init, t, setLocale, getLocale } from './src/i18n.js';
 *   init();          // auto-detects locale and applies translations to the DOM
 *   t('some.key');   // returns translated string in the current locale
 *
 * DOM conventions:
 *   data-i18n="key"             → element.textContent
 *   data-i18n-placeholder="key" → element.placeholder
 *   data-i18n-title="key"       → element.title
 *   data-i18n-aria-label="key"  → element.setAttribute('aria-label', …)
 */

export const SUPPORTED_LOCALES = /** @type {const} */ (['fr', 'en'])
export const DEFAULT_LOCALE = 'fr'

const STORAGE_KEY = 'voyage-ter:lang'

// ── Translations ─────────────────────────────────────────────────────────────

/**
 * @type {Record<string, Record<string, string | ((...args: any[]) => string)>>}
 */
export const translations = {
	fr: {
		// Page meta
		'page.title': 'Voyage TER — Recherche',

		// Header
		lead: 'Les trajets vélo\u202f+\u202ftrain les plus courts\u202f—\u202fdémo',

		// Form labels & placeholders
		'form.aria': 'Rechercher des connexions',
		'form.label.departure': 'Départ',
		'form.departure.placeholder': 'Gare ou adresse (ex. Lyon Part-Dieu)',
		'form.departure.suggestions': 'Suggestions de départ',
		'form.label.arrival': 'Arrivée',
		'form.arrival.placeholder': 'Gare ou adresse (ex. Grenoble)',
		'form.arrival.suggestions': 'Suggestions d\u2019arrivée',
		'form.label.datetime': 'Date et heure de départ',

		// Buttons
		'btn.reverse': '\u21c4 Inverser',
		'btn.reverse.title': 'Échanger départ et arrivée',
		'btn.search': 'Rechercher',

		// Status messages
		'status.searching': 'Recherche en cours\u202f\u2026',
		'status.loading': 'Chargement\u202f\u2026',
		/** @param {number} n */
		'status.found': (n) => {
			switch (n) {
				case 0:
					return 'Nada, il va falloir pédaler...'
				case 1:
					return 'Une option trouvée.'
				default:
					return `${n}\u202foptions trouvées.`
			}
		},
		'status.error': 'Erreur\u202f: ',
		'status.fill': 'Veuillez renseigner le départ et l\u2019arrivée.',

		// Results
		'results.none': 'Aucun résultat.',
		'results.dep': 'Dép',
		'results.arr': 'Arr',

		// Theme toggle (dynamic aria-label set in JS)
		'theme.switch.title': 'Basculer clair / sombre',
		'theme.to-dark': 'Passer en mode sombre',
		'theme.to-light': 'Passer en mode clair',

		// Language switcher (shows the CURRENT language)
		'lang.switch': 'FR',
		'lang.switch.title': 'Switch to English',
	},

	en: {
		// Page meta
		'page.title': 'Voyage TER — Search',

		// Header
		lead: 'Shortest bike-friendly train paths — demo',

		// Form labels & placeholders
		'form.aria': 'Search connections',
		'form.label.departure': 'Departure',
		'form.departure.placeholder': 'Station or address (e.g. Lyon Part-Dieu)',
		'form.departure.suggestions': 'Departure suggestions',
		'form.label.arrival': 'Arrival',
		'form.arrival.placeholder': 'Station or address (e.g. Grenoble)',
		'form.arrival.suggestions': 'Arrival suggestions',
		'form.label.datetime': 'Departure date & time',

		// Buttons
		'btn.reverse': '\u21c4 Reverse',
		'btn.reverse.title': 'Swap departure and arrival',
		'btn.search': 'Search',

		// Status messages
		'status.searching': 'Searching\u2026',
		'status.loading': 'Loading\u2026',
		/** @param {number} n */
		'status.found': (n) => `Found ${n} option(s).`,
		'status.error': 'Error: ',
		'status.fill': 'Please fill both departure and arrival.',

		// Results
		'results.none': 'No results.',
		'results.dep': 'Dep',
		'results.arr': 'Arr',

		// Theme toggle
		'theme.switch.title': 'Toggle light / dark theme',
		'theme.to-dark': 'Switch to dark mode',
		'theme.to-light': 'Switch to light mode',

		// Language switcher (shows the CURRENT language)
		'lang.switch': 'EN',
		'lang.switch.title': 'Passer en français',
	},
}

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {string} */
let currentLocale = DEFAULT_LOCALE

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect the best supported locale from localStorage, then browser preference.
 * Falls back to DEFAULT_LOCALE when no supported locale is found.
 * @returns {string}
 */
export function detectLocale() {
	try {
		const stored = localStorage.getItem(STORAGE_KEY)
		if (SUPPORTED_LOCALES.includes(/** @type {any} */ (stored))) return stored
	} catch (_) {
		/* private/storage disabled */
	}

	const lang = (navigator.language || '').toLowerCase().split('-')[0]
	return SUPPORTED_LOCALES.includes(/** @type {any} */ (lang))
		? lang
		: DEFAULT_LOCALE
}

/** @returns {string} Active locale code ('fr' | 'en') */
export function getLocale() {
	return currentLocale
}

/**
 * Return the translated string for `key` in the current locale.
 * If the value is a function, it is called with any extra `args`.
 * Falls back to the default locale, then to the key itself.
 *
 * @param {string} key
 * @param {...any} args
 * @returns {string}
 */
export function t(key, ...args) {
	const val =
		translations[currentLocale]?.[key] ??
		translations[DEFAULT_LOCALE]?.[key] ??
		key
	return typeof val === 'function' ? val(...args) : String(val)
}

/**
 * Walk the DOM and apply translations to all annotated elements.
 * Also updates `document.title` and `<html lang>`.
 */
export function applyTranslations() {
	document.querySelectorAll('[data-i18n]').forEach((el) => {
		el.textContent = t(/** @type {HTMLElement} */ (el).dataset.i18n)
	})
	document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
		/** @type {HTMLInputElement} */ el.placeholder = t(
			/** @type {HTMLElement} */ (el).dataset.i18nPlaceholder,
		)
	})
	document.querySelectorAll('[data-i18n-title]').forEach((el) => {
		/** @type {HTMLElement} */ el.title = t(
			/** @type {HTMLElement} */ (el).dataset.i18nTitle,
		)
	})
	document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
		el.setAttribute(
			'aria-label',
			t(/** @type {HTMLElement} */ (el).dataset.i18nAriaLabel),
		)
	})

	document.documentElement.lang = currentLocale
}

/**
 * Switch to `locale`, persist the choice, update the DOM, and dispatch
 * a `localechange` event on `document` so other parts of the app can react.
 *
 * @param {string} locale
 */
export function setLocale(locale) {
	if (!SUPPORTED_LOCALES.includes(/** @type {any} */ (locale))) return
	currentLocale = locale
	try {
		localStorage.setItem(STORAGE_KEY, locale)
	} catch (_) {}
	applyTranslations()
	document.dispatchEvent(
		new CustomEvent('localechange', { detail: { locale } }),
	)
}

/**
 * Initialise i18n: detect the best locale and apply translations.
 * Call once at app startup.
 */
export function init() {
	currentLocale = detectLocale()
	applyTranslations()
}
