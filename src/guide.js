import './guide.css';

// Les chapitres sont la même source Markdown que la documentation du dépôt.
// Un glob plutôt que des imports nommés permet d'ajouter/réordonner un chapitre
// sans modifier le code de l'interface.
const rawGuideDocuments = import.meta.glob( '../doc/guide/*.md', {
	eager: true,
	query: '?raw',
	import: 'default',
} );

const FALLBACK_DOCUMENT = `---
title: Guide de la simulation
order: 1
summary: Le guide détaillé est en cours de chargement.
---

# Guide de la simulation

Les chapitres de référence seront disponibles ici dès que les fichiers de
\`doc/guide\` auront été générés.

En attendant, sélectionnez une fourmi dans la scène pour consulter son état,
son intention et la raison de son éventuelle immobilité.
`;

const TEST_MODES = new Set( [ 'warden', 'colony' ] );

function escapeHtml( value ) {

	return String( value )
		.replaceAll( '&', '&amp;' )
		.replaceAll( '<', '&lt;' )
		.replaceAll( '>', '&gt;' )
		.replaceAll( '"', '&quot;' )
		.replaceAll( '\'', '&#39;' );

}

function plainText( markdown ) {

	return markdown
		.replace( /^---[\s\S]*?---\s*/m, '' )
		.replace( /```[\s\S]*?```/g, ' ' )
		.replace( /!\[([^\]]*)\]\([^)]*\)/g, '$1' )
		.replace( /\[([^\]]+)\]\([^)]*\)/g, '$1' )
		.replace( /[#>*_`|~-]/g, ' ' )
		.replace( /\s+/g, ' ' )
		.trim();

}

function slugify( value ) {

	return value
		.normalize( 'NFD' )
		.replace( /[\u0300-\u036f]/g, '' )
		.toLowerCase()
		.replace( /[^a-z0-9]+/g, '-' )
		.replace( /(^-|-$)/g, '' ) || 'chapitre';

}

function normalizeSearch( value ) {

	return plainText( String( value ) )
		.normalize( 'NFD' )
		.replace( /[\u0300-\u036f]/g, '' )
		.toLocaleLowerCase( 'fr' );

}

function parseFrontMatter( source ) {

	const match = source.match( /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/ );
	if ( ! match ) return { attributes: {}, body: source };

	const attributes = {};
	for ( const line of match[ 1 ].split( /\r?\n/ ) ) {

		const separator = line.indexOf( ':' );
		if ( separator < 1 ) continue;
		const key = line.slice( 0, separator ).trim();
		let value = line.slice( separator + 1 ).trim();
		if ( ( value.startsWith( '"' ) && value.endsWith( '"' ) )
			|| ( value.startsWith( '\'' ) && value.endsWith( '\'' ) ) ) {

			value = value.slice( 1, - 1 );

		}
		attributes[ key ] = value;

	}

	return { attributes, body: source.slice( match[ 0 ].length ) };

}

function chapterFromDocument( path, source ) {

	const { attributes, body } = parseFrontMatter( String( source ) );
	const fileName = path.split( '/' ).pop().replace( /\.md$/i, '' );
	const heading = body.match( /^#\s+(.+)$/m )?.[ 1 ]?.trim();
	const fileTitle = fileName
		.replace( /^\d+[-_. ]*/, '' )
		.replace( /[-_]+/g, ' ' )
		.replace( /^\p{L}/u, ( letter ) => letter.toUpperCase() );
	const title = attributes.title || heading || fileTitle;
	const numericPrefix = Number( fileName.match( /^\d+/ )?.[ 0 ] );
	const explicitOrder = Number( attributes.order );
	const order = Number.isFinite( explicitOrder )
		? explicitOrder
		: Number.isFinite( numericPrefix ) ? numericPrefix : 999;
	const summary = attributes.summary
		|| plainText( body ).slice( 0, 150 )
		|| 'Documentation de la simulation';

	return {
		id: attributes.id || slugify( fileName ),
		title,
		summary,
		order,
		body,
		searchText: normalizeSearch( `${ title } ${ summary } ${ body }` ),
	};

}

function buildChapters() {

	const documents = Object.entries( rawGuideDocuments );
	if ( documents.length === 0 ) documents.push( [ '00-guide.md', FALLBACK_DOCUMENT ] );

	return documents
		.map( ( [ path, source ] ) => chapterFromDocument( path, source ) )
		.sort( ( a, b ) => a.order - b.order || a.title.localeCompare( b.title, 'fr' ) );

}

function safeHref( href ) {

	const value = href.trim();
	if ( /^(https?:\/\/|#|\/(?!\/)|\.{1,2}\/)/i.test( value ) ) return value;
	return '#';

}

function renderInline( source ) {

	const codeSpans = [];
	let value = String( source ).replace( /`([^`]+)`/g, ( _, code ) => {

		const index = codeSpans.push( `<code>${ escapeHtml( code ) }</code>` ) - 1;
		return `\u0000CODE${ index }\u0000`;

	} );

	value = escapeHtml( value );
	value = value.replace( /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
		( _, label, href ) => {

			const safe = safeHref( href.replaceAll( '&amp;', '&' ) );
			const external = /^https?:\/\//i.test( safe );
			return `<a href="${ escapeHtml( safe ) }"${ external ? ' target="_blank" rel="noreferrer"' : '' }>${ label }</a>`;

		} );
	value = value
		.replace( /\*\*([^*]+)\*\*/g, '<strong>$1</strong>' )
		.replace( /__([^_]+)__/g, '<strong>$1</strong>' )
		.replace( /(^|[^\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>' )
		.replace( /(^|[^\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>' )
		.replace( /\u0000CODE(\d+)\u0000/g, ( _, index ) => codeSpans[ Number( index ) ] );

	return value;

}

function tableCells( line ) {

	return line.trim().replace( /^\||\|$/g, '' ).split( '|' ).map( ( cell ) => cell.trim() );

}

export function renderGuideMarkdown( markdown ) {

	const lines = markdown.replace( /\r\n/g, '\n' ).split( '\n' );
	const html = [];
	const paragraph = [];
	let list = null;
	let inCode = false;
	let codeLanguage = '';
	let code = [];

	const flushParagraph = () => {

		if ( paragraph.length === 0 ) return;
		html.push( `<p>${ renderInline( paragraph.join( ' ' ) ) }</p>` );
		paragraph.length = 0;

	};

	const closeList = () => {

		if ( ! list ) return;
		html.push( `</${ list }>` );
		list = null;

	};

	for ( let i = 0; i < lines.length; i ++ ) {

		const line = lines[ i ];
		const fence = line.match( /^\s*```([\w-]*)\s*$/ );
		if ( fence ) {

			flushParagraph();
			closeList();
			if ( inCode ) {

				html.push( `<pre><code${ codeLanguage ? ` class="language-${ escapeHtml( codeLanguage ) }"` : '' }>${ escapeHtml( code.join( '\n' ) ) }</code></pre>` );
				code = [];
				codeLanguage = '';
				inCode = false;

			} else {

				inCode = true;
				codeLanguage = fence[ 1 ];

			}
			continue;

		}

		if ( inCode ) {

			code.push( line );
			continue;

		}

		if ( line.trim() === '' ) {

			flushParagraph();
			closeList();
			continue;

		}

		const heading = line.match( /^(#{1,4})\s+(.+)$/ );
		if ( heading ) {

			flushParagraph();
			closeList();
			const level = heading[ 1 ].length;
			const text = heading[ 2 ].replace( /\s+#+$/, '' ).trim();
			html.push( `<h${ level } id="${ slugify( text ) }">${ renderInline( text ) }</h${ level }>` );
			continue;

		}

		if ( /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test( line ) ) {

			flushParagraph();
			closeList();
			html.push( '<hr>' );
			continue;

		}

		if ( line.includes( '|' ) && i + 1 < lines.length
			&& /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test( lines[ i + 1 ] ) ) {

			flushParagraph();
			closeList();
			const headers = tableCells( line );
			i += 2;
			const rows = [];
			while ( i < lines.length && lines[ i ].includes( '|' ) && lines[ i ].trim() !== '' ) {

				rows.push( tableCells( lines[ i ] ) );
				i ++;

			}
			i --;
			html.push( `<div class="ant-guide-table-wrap"><table><thead><tr>${ headers.map( ( cell ) => `<th>${ renderInline( cell ) }</th>` ).join( '' ) }</tr></thead><tbody>${ rows.map( ( row ) => `<tr>${ headers.map( ( _, column ) => `<td>${ renderInline( row[ column ] || '' ) }</td>` ).join( '' ) }</tr>` ).join( '' ) }</tbody></table></div>` );
			continue;

		}

		const unordered = line.match( /^\s*[-+*]\s+(.+)$/ );
		const ordered = line.match( /^\s*\d+[.)]\s+(.+)$/ );
		if ( unordered || ordered ) {

			flushParagraph();
			const wanted = unordered ? 'ul' : 'ol';
			if ( list !== wanted ) {

				closeList();
				list = wanted;
				html.push( `<${ list }>` );

			}
			const item = ( unordered || ordered )[ 1 ];
			html.push( `<li>${ renderInline( item ) }</li>` );
			continue;

		}

		const quote = line.match( /^\s*>\s?(.*)$/ );
		if ( quote ) {

			flushParagraph();
			closeList();
			html.push( `<blockquote>${ renderInline( quote[ 1 ] ) }</blockquote>` );
			continue;

		}

		paragraph.push( line.trim() );

	}

	if ( inCode ) html.push( `<pre><code>${ escapeHtml( code.join( '\n' ) ) }</code></pre>` );
	flushParagraph();
	closeList();
	return html.join( '\n' );

}

export function isGuideEnabled( search = globalThis.location?.search || '' ) {

	const query = new URLSearchParams( search );
	return ! query.has( 'bench' ) && ! TEST_MODES.has( query.get( 'test' ) );

}

function antContextFrom( antfollow ) {

	if ( ! antfollow ) return null;

	let info = antfollow.info || null;
	if ( typeof antfollow.diagnostics === 'function' ) {

		info = antfollow.diagnostics() || info;

	}

	const selected = Number.isInteger( antfollow.selected ) && antfollow.selected >= 0
		? antfollow.selected
		: Number.isInteger( info?.id ) && info.id >= 0 ? info.id : - 1;
	if ( selected < 0 ) return null;

	return { ...( info || {} ), id: selected };

}

function contextDescription( ant ) {

	if ( ! ant ) return '';
	const intent = ant.intentLabel || ant.intent || ant.telemetry?.intentLabel;
	const goal = ant.goalLabel || ant.goal || ant.telemetry?.goalLabel;
	const motion = ant.motionLabel || ant.motion || ant.telemetry?.motionLabel;
	const location = ant.under === true ? 'Sous terre' : ant.under === false ? 'À la surface' : null;
	return [ intent, goal && `Objectif : ${ goal }`, motion, location ].filter( Boolean ).join( ' · ' )
		|| 'Son diagnostic détaillé apparaît dans l’inspecteur de la simulation.';

}

export function createSimulationGuide( { antfollow, mount = document.body } = {} ) {

	if ( ! isGuideEnabled() ) {

		return {
			enabled: false,
			open() {},
			close() {},
			toggle() {},
			destroy() {},
			get isOpen() { return false; },
		};

	}

	const chapters = buildChapters();
	let activeId = chapters[ 0 ].id;
	let isOpen = false;
	let restoreFocus = null;
	let lastAntId = - 2;

	const toggleButton = document.createElement( 'button' );
	toggleButton.type = 'button';
	toggleButton.id = 'ant-guide-toggle';
	toggleButton.className = 'ant-guide-toggle';
	toggleButton.setAttribute( 'aria-haspopup', 'dialog' );
	toggleButton.setAttribute( 'aria-controls', 'ant-guide-dialog' );
	toggleButton.setAttribute( 'aria-expanded', 'false' );
	toggleButton.innerHTML = '<span aria-hidden="true">?</span><span class="ant-guide-toggle-label">Guide</span>';
	toggleButton.title = 'Comprendre la simulation (F1)';

	const layer = document.createElement( 'div' );
	layer.className = 'ant-guide-layer';
	layer.hidden = true;
	layer.innerHTML = `
		<div class="ant-guide-backdrop" data-guide-close></div>
		<section id="ant-guide-dialog" class="ant-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="ant-guide-title" tabindex="-1">
			<header class="ant-guide-header">
				<div>
					<div class="ant-guide-eyebrow">Manuel vivant de la simulation</div>
					<h1 id="ant-guide-title">Comprendre la colonie</h1>
				</div>
				<div class="ant-guide-header-actions">
					<button type="button" class="ant-guide-context-action" hidden></button>
					<button type="button" class="ant-guide-close" data-guide-close aria-label="Fermer le guide">×</button>
				</div>
			</header>
			<div class="ant-guide-layout">
				<aside class="ant-guide-sidebar">
					<label class="ant-guide-search-label" for="ant-guide-search">Rechercher dans le guide</label>
					<div class="ant-guide-search-box">
						<span aria-hidden="true">⌕</span>
						<input id="ant-guide-search" type="search" autocomplete="off" placeholder="Ex. ponte, repos, tunnel…">
					</div>
					<div class="ant-guide-result-count" role="status" aria-live="polite"></div>
					<nav class="ant-guide-nav" aria-label="Chapitres du guide"></nav>
				</aside>
				<main class="ant-guide-main" tabindex="0">
					<aside class="ant-guide-ant-context" hidden aria-live="polite"></aside>
					<article class="ant-guide-article"></article>
				</main>
			</div>
		</section>
	`;

	mount.append( toggleButton, layer );

	const dialog = layer.querySelector( '.ant-guide-dialog' );
	const search = layer.querySelector( '#ant-guide-search' );
	const nav = layer.querySelector( '.ant-guide-nav' );
	const resultCount = layer.querySelector( '.ant-guide-result-count' );
	const article = layer.querySelector( '.ant-guide-article' );
	const main = layer.querySelector( '.ant-guide-main' );
	const antCard = layer.querySelector( '.ant-guide-ant-context' );
	const contextAction = layer.querySelector( '.ant-guide-context-action' );

	function currentAnt() {

		return antContextFrom( antfollow );

	}

	function renderAntContext() {

		const ant = currentAnt();
		const antId = ant?.id ?? - 1;
		if ( antId !== lastAntId ) {

			lastAntId = antId;
			toggleButton.classList.toggle( 'has-selection', Boolean( ant ) );
			toggleButton.querySelector( '.ant-guide-toggle-label' ).textContent =
				ant ? `Guide · fourmi #${ ant.id }` : 'Guide';
			contextAction.hidden = ! ant;
			if ( ant ) contextAction.textContent = `Comprendre la fourmi #${ ant.id }`;

		}

		if ( ! ant ) {

			antCard.hidden = true;
			antCard.innerHTML = '';
			return;

		}

		antCard.hidden = false;
		antCard.innerHTML = `<div class="ant-guide-ant-badge">Fourmi sélectionnée #${ ant.id }</div>
			<strong>${ escapeHtml( ant.intentLabel || ant.intent || 'Lecture de son comportement en cours' ) }</strong>
			<p>${ escapeHtml( contextDescription( ant ) ) }</p>`;

	}

	function filteredChapters() {

		const query = normalizeSearch( search.value );
		if ( ! query ) return chapters;
		const terms = query.split( /\s+/ ).filter( Boolean );
		return chapters.filter( ( chapter ) => terms.every( ( term ) => chapter.searchText.includes( term ) ) );

	}

	function renderNavigation() {

		const visible = filteredChapters();
		if ( visible.length > 0 && ! visible.some( ( chapter ) => chapter.id === activeId ) ) {

			activeId = visible[ 0 ].id;

		}

		nav.innerHTML = '';
		for ( const chapter of visible ) {

			const button = document.createElement( 'button' );
			button.type = 'button';
			button.className = 'ant-guide-chapter';
			button.dataset.chapter = chapter.id;
			button.setAttribute( 'aria-current', chapter.id === activeId ? 'page' : 'false' );
			button.innerHTML = `<span>${ escapeHtml( chapter.title ) }</span><small>${ escapeHtml( chapter.summary ) }</small>`;
			button.addEventListener( 'click', () => {

				activeId = chapter.id;
				renderNavigation();
				main.scrollTop = 0;
				main.focus( { preventScroll: true } );

			} );
			nav.appendChild( button );

		}

		const searching = search.value.trim() !== '';
		resultCount.textContent = searching
			? `${ visible.length } chapitre${ visible.length > 1 ? 's' : '' } trouvé${ visible.length > 1 ? 's' : '' }`
			: `${ chapters.length } chapitre${ chapters.length > 1 ? 's' : '' }`;

		const active = chapters.find( ( chapter ) => chapter.id === activeId );
		if ( visible.length === 0 || ! active ) {

			article.innerHTML = '<div class="ant-guide-empty"><strong>Aucun chapitre ne correspond.</strong><p>Essayez un mot plus général, comme « fourmi », « nid » ou « nourriture ».</p></div>';
			return;

		}

		article.innerHTML = renderGuideMarkdown( active.body );

	}

	function selectContextChapter() {

		search.value = '';
		const keywords = [ 'comportement', 'fourmi', 'cycle', 'etat', 'intention', 'deplacement' ];
		let best = chapters[ 0 ];
		let bestScore = - 1;
		for ( const chapter of chapters ) {

			const normalized = slugify( `${ chapter.title } ${ chapter.summary }` );
			const score = keywords.reduce( ( total, keyword ) => total + ( normalized.includes( keyword ) ? 1 : 0 ), 0 );
			if ( score > bestScore ) {

				best = chapter;
				bestScore = score;

			}

		}
		activeId = best.id;
		renderNavigation();
		main.scrollTop = 0;

	}

	function focusableElements() {

		return [ ...dialog.querySelectorAll(
			'a[href], button:not([disabled]):not([hidden]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
		) ].filter( ( element ) => element.getClientRects().length > 0 );

	}

	function open( { contextual = false } = {} ) {

		if ( isOpen ) {

			if ( contextual ) selectContextChapter();
			return;

		}
		isOpen = true;
		restoreFocus = document.activeElement;
		layer.hidden = false;
		toggleButton.setAttribute( 'aria-expanded', 'true' );
		document.documentElement.classList.add( 'ant-guide-open' );
		renderAntContext();
		renderNavigation();
		if ( contextual ) selectContextChapter();
		requestAnimationFrame( () => dialog.focus( { preventScroll: true } ) );

	}

	function close() {

		if ( ! isOpen ) return;
		isOpen = false;
		layer.hidden = true;
		toggleButton.setAttribute( 'aria-expanded', 'false' );
		document.documentElement.classList.remove( 'ant-guide-open' );
		if ( restoreFocus instanceof HTMLElement ) restoreFocus.focus( { preventScroll: true } );
		restoreFocus = null;

	}

	function toggle() {

		if ( isOpen ) close();
		else open();

	}

	function onKeydown( event ) {

		if ( event.key === 'F1' ) {

			event.preventDefault();
			if ( ! isOpen ) open();
			return;

		}

		if ( ! isOpen ) return;
		if ( event.key === 'Escape' ) {

			event.preventDefault();
			event.stopImmediatePropagation();
			close();
			return;

		}

		if ( ( event.ctrlKey || event.metaKey ) && event.key.toLowerCase() === 'k' ) {

			event.preventDefault();
			search.focus();
			return;

		}

		if ( event.key !== 'Tab' ) return;
		const focusable = focusableElements();
		if ( focusable.length === 0 ) {

			event.preventDefault();
			dialog.focus();
			return;

		}
		const first = focusable[ 0 ];
		const last = focusable[ focusable.length - 1 ];
		if ( event.shiftKey && document.activeElement === first ) {

			event.preventDefault();
			last.focus();

		} else if ( ! event.shiftKey && document.activeElement === last ) {

			event.preventDefault();
			first.focus();

		}

	}

	toggleButton.addEventListener( 'click', toggle );
	layer.querySelectorAll( '[data-guide-close]' ).forEach( ( button ) => button.addEventListener( 'click', close ) );
	contextAction.addEventListener( 'click', () => open( { contextual: true } ) );
	search.addEventListener( 'input', renderNavigation );
	window.addEventListener( 'keydown', onKeydown );

	const antRefresh = window.setInterval( () => {

		const id = currentAnt()?.id ?? - 1;
		if ( id !== lastAntId || isOpen ) renderAntContext();

	}, 750 );
	renderAntContext();

	return {
		enabled: true,
		open,
		close,
		toggle,
		get chapters() { return chapters.map( ( chapter ) => ( { ...chapter } ) ); },
		get isOpen() { return isOpen; },
		destroy() {

			close();
			window.clearInterval( antRefresh );
			window.removeEventListener( 'keydown', onKeydown );
			toggleButton.remove();
			layer.remove();

		},
	};

}
