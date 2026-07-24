/*
 *	Dropbox sync for Nullboard
 *	---------------------------------------------------------------
 *	Plugs into Nullboard's existing BackupStorage plugin interface
 *	(see index.html: class BackupStorage, NB.backupTypes).
 *
 *	Design:
 *	- localStorage (Storage_Local) remains the single source of
 *	  truth on this device. This file never replaces it.
 *	- DropboxBackup implements the same push-on-save interface as
 *	  the existing SimpleBackup agent, so every saveBoard()/
 *	  saveConfig() call already fires a Dropbox write for free,
 *	  via the base Storage class's existing backupBoard()/
 *	  backupConfig() hooks. No edits to app/render logic needed.
 *	- pullAndReconcile() is new: it runs once at boot, in the
 *	  background, *after* the local board is already on screen.
 *	  It only ever pulls in a *newer* revision than what's local -
 *	  it never deletes or overwrites with something older, so a
 *	  network hiccup or a stale Dropbox folder can't cause loss.
 *
 *	Setup (see README-dropbox.md):
 *	1. Create a Dropbox app at https://www.dropbox.com/developers/apps
 *	   - Access type: "App folder" (scopes the app to its own
 *	     folder inside the user's Dropbox - not full Dropbox access)
 *	   - Add your GitHub Pages URL as a redirect URI, e.g.
 *	     https://yourname.github.io/nullboard-dropbox/
 *	2. Put that app's key in window.NB_DROPBOX_APP_KEY (set in
 *	   index.html, see the <script> block near the bottom).
 *	   This is a public client id, not a secret - PKCE means no
 *	   client secret is needed for a static site.
 */

(function(){

'use strict';

/* ---------- config ------------------------------------------------ */

const DBX_AUTH_URL  = 'https://www.dropbox.com/oauth2/authorize';
const DBX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const DBX_CONTENT   = 'https://content.dropboxapi.com/2';
const DBX_API       = 'https://api.dropboxapi.com/2';

function appKey()
{
	return window.NB_DROPBOX_APP_KEY || '';
}

/* ---------- PKCE helpers ------------------------------------------ */

function b64url(buf)
{
	var bytes = new Uint8Array(buf);
	var bin = '';
	for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(str)
{
	var data = new TextEncoder().encode(str);
	return await crypto.subtle.digest('SHA-256', data);
}

function randomString(len)
{
	var arr = new Uint8Array(len);
	crypto.getRandomValues(arr);
	return b64url(arr.buffer).slice(0, len);
}

async function pkcePair()
{
	var verifier  = randomString(64);
	var challenge = b64url(await sha256(verifier));
	return { verifier: verifier, challenge: challenge };
}

/* ---------- token storage ------------------------------------------
 *	Kept outside of Nullboard's own 'nullboard.*' localStorage
 *	namespace so it's obviously separate from board data.
 */

const TOK_KEY = 'nb-dropbox.tokens';

function loadTokens()
{
	try { return JSON.parse(localStorage.getItem(TOK_KEY)) || null; }
	catch (x) { return null; }
}

function saveTokens(t)  { localStorage.setItem(TOK_KEY, JSON.stringify(t)); }
function clearTokens()  { localStorage.removeItem(TOK_KEY); }

/* ---------- OAuth (PKCE, authorization code, offline access) ------ */

async function startAuth()
{
	if (! appKey())
	{
		alert('No Dropbox app key configured. Set window.NB_DROPBOX_APP_KEY in index.html first.');
		return;
	}

	var pair = await pkcePair();
	sessionStorage.setItem('nb-dbx-verifier', pair.verifier);

	var redirect = location.origin + location.pathname;

	var url = DBX_AUTH_URL +
		'?client_id=' + encodeURIComponent(appKey()) +
		'&response_type=code' +
		'&code_challenge=' + encodeURIComponent(pair.challenge) +
		'&code_challenge_method=S256' +
		'&token_access_type=offline' +
		'&redirect_uri=' + encodeURIComponent(redirect);

	location.href = url;
}

// Call this once, early, on every page load - it's a no-op unless
// we're returning from the Dropbox consent screen with ?code=...
async function finishAuthIfReturning()
{
	var params = new URLSearchParams(location.search);
	var code = params.get('code');
	if (! code) return false;

	var verifier = sessionStorage.getItem('nb-dbx-verifier');
	sessionStorage.removeItem('nb-dbx-verifier');

	var redirect = location.origin + location.pathname;

	var body = new URLSearchParams({
		code: code,
		grant_type: 'authorization_code',
		client_id: appKey(),
		code_verifier: verifier,
		redirect_uri: redirect
	});

	var res = await fetch(DBX_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body
	});

	if (! res.ok)
	{
		console.log('Dropbox token exchange failed', await res.text());
		return false;
	}

	var json = await res.json();
	saveTokens({
		access_token:  json.access_token,
		refresh_token: json.refresh_token,
		expires_at:    Date.now() + (json.expires_in * 1000)
	});

	// strip ?code=&state= from the address bar so a reload doesn't retry
	history.replaceState({}, '', redirect);
	return true;
}

async function getAccessToken()
{
	var t = loadTokens();
	if (! t) return null;

	if (Date.now() < t.expires_at - 60000)
		return t.access_token;

	var body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: t.refresh_token,
		client_id: appKey()
	});

	var res = await fetch(DBX_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: body
	});

	if (! res.ok) { clearTokens(); return null; }

	var json = await res.json();
	var nt = {
		access_token:  json.access_token,
		refresh_token: t.refresh_token, // Dropbox refresh tokens don't rotate
		expires_at:    Date.now() + (json.expires_in * 1000)
	};
	saveTokens(nt);
	return nt.access_token;
}

/* ---------- low-level Dropbox calls -------------------------------- */

async function dbxUpload(path, jsonObj)
{
	var token = await getAccessToken();
	if (! token) throw 'not-authed';

	var res = await fetch(DBX_CONTENT + '/files/upload', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + token,
			'Content-Type': 'application/octet-stream',
			'Dropbox-API-Arg': JSON.stringify({ path: path, mode: 'overwrite', mute: true })
		},
		body: JSON.stringify(jsonObj)
	});

	if (! res.ok) throw await res.text();
	return await res.json(); // includes .rev
}

async function dbxDownload(path)
{
	var token = await getAccessToken();
	if (! token) throw 'not-authed';

	var res = await fetch(DBX_CONTENT + '/files/download', {
		method: 'POST',
		headers: {
			'Authorization': 'Bearer ' + token,
			'Dropbox-API-Arg': JSON.stringify({ path: path })
		}
	});

	if (res.status == 409) return null; // path/not_found
	if (! res.ok) throw await res.text();

	return await res.json();
}

async function dbxDelete(path)
{
	var token = await getAccessToken();
	if (! token) return;

	await fetch(DBX_API + '/files/delete_v2', {
		method: 'POST',
		headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
		body: JSON.stringify({ path: path })
	});
}

async function dbxListFolder()
{
	var token = await getAccessToken();
	if (! token) throw 'not-authed';

	var res = await fetch(DBX_API + '/files/list_folder', {
		method: 'POST',
		headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
		body: JSON.stringify({ path: '' })
	});

	if (! res.ok) throw await res.text();
	var json = await res.json();
	return json.entries || [];
}

/* ---------- BackupStorage-compatible push agent --------------------
 *	Same shape as the built-in SimpleBackup. Register it with
 *	NB.backupTypes and it starts receiving every saveBoard() /
 *	saveConfig() call automatically - see the wiring in
 *	index.html near the bottom of the file.
 */

class DropboxBackup extends BackupStorage
{
	constructor(id, conf, onStatusChange)
	{
		super(id, conf, onStatusChange);
		this.type = 'dropbox';
	}

	checkStatus(cb)
	{
		getAccessToken().then(function(tok){ cb && cb(!!tok); });
	}

	saveConfig(conf, cb)
	{
		dbxUpload('/config.json', conf)
			.then(function(){ cb && cb(true); })
			.catch(function(err){ console.log('Dropbox saveConfig failed', err); cb && cb(false); });
	}

	saveBoard(id, data, meta, cb)
	{
		var jobs = [];

		if (data) jobs.push(dbxUpload('/board-' + id + '.json', data));
		if (meta) jobs.push(dbxUpload('/board-' + id + '.meta.json', meta));

		Promise.all(jobs)
			.then(function(){ cb && cb(true); })
			.catch(function(err){ console.log('Dropbox saveBoard failed', err); cb && cb(false); });
	}

	nukeBoard(id, cb)
	{
		Promise.all([
			dbxDelete('/board-' + id + '.json'),
			dbxDelete('/board-' + id + '.meta.json')
		]).then(function(){ cb && cb(true); });
	}
}

/* ---------- pull + reconcile on boot --------------------------------
 *	Runs once, after the local-first render is already showing.
 *	For each board found remotely with a higher revision number
 *	than what's stored locally, downloads it and hands it to
 *	Storage.saveBoard() so it goes through the normal revision/
 *	undo-history bookkeeping. Never touches boards that only exist
 *	locally, and never removes anything - additive only.
 *
 *	NOTE: this is last-write-wins at the board level, not a true
 *	merge. If you edit the same board on two devices while offline
 *	on both, the higher revision number wins and the other device's
 *	changes since their common ancestor are lost (though still
 *	recoverable from that device's own undo history, if caught in
 *	time). For a single person on one device at a time - normal
 *	"switch which laptop I'm using" usage - this is not an issue.
 */

async function pullAndReconcile(storage, onBoardUpdated)
{
	var token = await getAccessToken();
	if (! token) return; // not connected - nothing to do

	var entries;
	try { entries = await dbxListFolder(); }
	catch (err) { console.log('Dropbox list_folder failed', err); return; }

	var metaFiles = entries.filter(function(e){
		return /^board-\d+\.meta\.json$/.test(e.name);
	});

	for (var f of metaFiles)
	{
		var board_id = parseInt(f.name.match(/^board-(\d+)\.meta\.json$/)[1]);

		var remoteMeta;
		try { remoteMeta = await dbxDownload('/board-' + board_id + '.meta.json'); }
		catch (err) { continue; }
		if (! remoteMeta) continue;

		var localMeta = storage.getBoardIndex().get(board_id);

		if (localMeta && localMeta.current >= remoteMeta.current)
			continue; // local is already current or newer

		var remoteBoard;
		try { remoteBoard = await dbxDownload('/board-' + board_id + '.json'); }
		catch (err) { continue; }
		if (! remoteBoard) continue;

		console.log('Dropbox: pulling newer revision of board ' + board_id +
			' (local ' + (localMeta ? localMeta.current : '-') + ' -> remote ' + remoteMeta.current + ')');

		// re-stamp revision so Storage.saveBoard() treats this as
		// "the next local revision", preserving undo history
		if (localMeta) remoteBoard.revision = localMeta.history[0];
		else            delete remoteBoard.revision;

		storage.saveBoard(remoteBoard);

		onBoardUpdated && onBoardUpdated(board_id);
	}
}

/* ---------- public surface ------------------------------------------ */

window.NBDropbox = {
	DropboxBackup:        DropboxBackup,
	startAuth:             startAuth,
	finishAuthIfReturning: finishAuthIfReturning,
	pullAndReconcile:      pullAndReconcile,
	isConnected:           function(){ return !!loadTokens(); },
	disconnect:            clearTokens
};

/* ---------- boot wiring ---------------------------------------------
 *	This file is loaded (via <script src>) after index.html's
 *	main inline script has already fully run - so NB, NB.storage,
 *	BackupStorage, openBoard(), updateBoardIndex() and the jQuery
 *	click handlers all already exist globally by the time this runs.
 *	Everything below is async/background and never blocks or delays
 *	the board that's already rendered on screen.
 */

NB.backupTypes.set('dropbox', DropboxBackup);

(async function boot(){

	// returning from the Dropbox consent screen?
	await finishAuthIfReturning();

	if (! window.NBDropbox.isConnected())
		return;

	$('.config .dbx-status').text('on');

	// activate the push agent for this session (kept out of
	// conf.backups.agents on purpose - see fixupConfig() in
	// index.html, which resets anything it doesn't recognize)
	var already = NB.storage.backups.agents.some(function(a){ return a.type == 'dropbox'; });
	if (! already)
		NB.storage.backups.agents.push(new DropboxBackup('dropbox-1', {}, onBackupStatusChange));

	// pull anything newer than what's local, then refresh the
	// view if the currently open board was one of the ones updated
	await pullAndReconcile(NB.storage, function(board_id){
		if (NB.board && NB.board.id == board_id)
			openBoard(board_id);
		updateBoardIndex();
	});

})();

})();
