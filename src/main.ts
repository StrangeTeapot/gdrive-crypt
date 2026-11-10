import { Modal, Notice, Platform, Plugin, Setting, TFile, getLanguage, normalizePath, requestUrl, setIcon, setTooltip } from 'obsidian';
import type { App } from 'obsidian';
import { Crypt } from './crypt.ts';
import { CryptDriveFs, DriveClient, GoogleAuth, RootMissingError, parseRefreshToken, pollDeviceLogin, startDeviceLogin } from './drive.ts';
import type { CachedRemoteFile, Request } from './drive.ts';
import { T, setLanguage } from './i18n.ts';
import { CryptDriveSyncSettingTab, DEFAULTS } from './settings.ts';
import type { Settings } from './settings.ts';
import { apply, plan } from './sync.ts';
import type { Action, Plan } from './sync.ts';
import type { BaseEntry, LocalEntry, LocalFs, RemoteEntry } from './types.ts';
import { SetupWizard } from './wizard.ts';
import { BackupManager } from './backup.ts';
import { PathSanitizer } from './sanitizer.ts';

const TOKEN_ID = 'token';
export const PASSWORD_ID = 'password';
export const SALT_ID = 'salt';
export const CLIENT_SECRET_ID = 'client-secret';

declare const GOOGLE_CLIENT: { id: string; secret: string };

const MIN_DELETE_COUNT = 10;
const req = requestUrl as unknown as Request;

export default class CryptDriveSync extends Plugin {
	settings: Settings = { ...DEFAULTS };
	lastResult = '';
	private base = new Map<string, BaseEntry>();
	private baseDirs = new Set<string>();
	private pageToken?: string;
	private remoteFilesCache = new Map<string, CachedRemoteFile>();
	private running = false;
	private lastSyncAt = 0;
	private logLines: string[] = [];
	private status?: { el: HTMLElement; icon: HTMLElement; text: HTMLElement };
	private crypt?: { key: string; crypt: Crypt };
	private editTimer = 0;
	private editedDuringSync = false;
	private createRoot = false;

	backupManager = new BackupManager(this);

	getRemoteSubsystemPath(subsystem: 'vaults' | '_backups' | '_deleted'): string {
		const root = PathSanitizer.sanitizeRootPath(this.settings.rootPath);
		const vaultName = PathSanitizer.sanitizeVaultName(this.settings.folder, this.app.vault.getName());
		return `${root}/${subsystem}/${vaultName}`;
	}

	getRemoteVaultPath(): string {
		return this.getRemoteSubsystemPath('vaults');
	}

	async onload() {
		setLanguage(getLanguage());
		this.lastResult = T.never;
		this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
		if (!this.settings.folder) this.settings.folder = this.app.vault.getName();
		this.base = await this.loadBase();

		this.addSettingTab(new CryptDriveSyncSettingTab(this));
		this.addRibbonIcon('refresh-cw', T.ribbon, () => void this.sync());

		if (!Platform.isMobile) {
			const el = this.addStatusBarItem();
			el.addClass('mod-clickable', 'cds-status');
			const icon = el.createSpan({ cls: 'cds-status-icon' });
			setIcon(icon, 'lock');
			this.status = { el, icon, text: el.createSpan() };
			this.setStatus(T.statusIdle, T.statusTip(this.lastResult));
			this.registerDomEvent(el, 'click', () => void this.sync());
		}

		this.addCommand({ id: 'sync-now', name: T.cmdSync, callback: () => void this.sync() });
		this.addCommand({ id: 'show-plan', name: T.cmdPlan, callback: () => void this.sync({ dryRun: true }) });
		this.addCommand({ id: 'show-log', name: T.cmdLog, callback: () => this.openLog() });
		this.addCommand({ id: 'reset-state', name: T.cmdReset, callback: () => void this.resetState(true) });
		this.addCommand({ id: 'setup', name: T.cmdWizard, callback: () => this.openWizard() });
		this.addCommand({ id: 'forget-device', name: T.forgetName, callback: () => void this.forgetDevice() });

		this.app.workspace.onLayoutReady(() => {
			if (!this.ready()) {
				if (!this.settings.wizardDone) this.openWizard();
			} else if (this.settings.syncOnStart) {
				void this.sync({ quiet: true });
			}
		});

		const onEdit = () => {
			const sec = Number(this.settings.afterEditSec);
			if (!sec || sec <= 0) return;
			if (this.running) {
				this.editedDuringSync = true;
				return;
			}
			window.clearTimeout(this.editTimer);
			this.editTimer = window.setTimeout(() => void this.sync({ quiet: true }), sec * 1000);
		};

		for (const ev of ['create', 'modify', 'delete', 'rename'] as const) {
			this.registerEvent(this.app.vault.on(ev as 'create', onEdit));
		}

		this.registerInterval(
			window.setInterval(() => {
				const min = Number(this.settings.intervalMin);
				if (min > 0 && Date.now() - this.lastSyncAt >= min * 60_000) void this.sync({ quiet: true });
			}, 60_000),
		);

		this.registerDomEvent(document, 'visibilitychange', () => {
			const min = Number(this.settings.intervalMin);
			if (min > 0 && document.visibilityState === 'visible' && Date.now() - this.lastSyncAt >= min * 60_000) {
				void this.sync({ quiet: true });
			}
		});

		this.addCommand({ id: 'create-backup', name: T.cmdBackup, callback: () => void this.backupManager.createBackup() });
	}

	refreshTimers(): void {
		window.clearTimeout(this.editTimer);
		this.editTimer = 0;
	}

	onunload() {
		window.clearTimeout(this.editTimer);
	}

async sync(opts: { quiet?: boolean; dryRun?: boolean } = {}): Promise<void> {
		if (this.running) {
			if (!opts.quiet) new Notice(`${T.noticePrefix}: Sync is already in progress...`);
			return;
		}
		this.running = true;
		this.editedDuringSync = false;
		this.setStatus(T.statusRunning, T.statusTip(this.lastResult), true);
		const base = this.base;
		let again = false;
		try {
			const remote = await this.remote(!opts.quiet);
			if (!remote) return;
			const local = new VaultFs(this);
			const [l, r] = await Promise.all([local.list(), remote.list()]);

			this.pageToken = remote.getPageToken();
			this.remoteFilesCache = remote.getFilesCache();

			const warnings = [...r.warnings, ...this.filter(l, r.files)];
			const opts1 = { minDeleteCount: MIN_DELETE_COUNT, maxDeletePct: Number(this.settings.maxDeletePct) };
			let p = plan(l, r.files, base, opts1);
			p.warnings.unshift(...warnings);
			p.warnings.forEach((w) => this.log(`\u26a0 ${w}`));

			if (opts.dryRun) {
				this.finish(T.planTitle, false);
				await new PlanModal(this.app, p, false).ask();
				return;
			}
			if (p.blocked || (this.settings.confirmPlan && p.actions.length)) {
				const remoteGone = r.files.size === 0 && base.size > 0;
				if (!(await new PlanModal(this.app, p, !remoteGone).ask())) {
					this.finish(p.blocked ? T.stopped(p.blocked) : T.cancelled, true);
					return;
				}
				p = { ...plan(l, r.files, base, { minDeleteCount: Infinity, maxDeletePct: 100 }), warnings: p.warnings };
			}
            if (!p.actions.length) {
				await this.saveBase();
				const hasWarn = p.warnings.length > 0;
				const msg = hasWarn ? `${T.noChanges} (${p.warnings.length} warning(s) — see log)` : T.noChanges;
				this.finish(msg, !opts.quiet || hasWarn, false, hasWarn);
				return;
			}

			const currentLocalDirs = await local.listDirs();

			const res = await apply(p, local, remote, base, {
				deviceName: this.settings.deviceName || this.defaultDeviceName(),
				now: () => new Date(),
				saveBase: async () => {
					if (base !== this.base) throw new Error(T.staleSettings);
					this.remoteFilesCache = remote.getFilesCache();
					await this.saveBase(currentLocalDirs);
				},
				onProgress: (done, total) => this.setStatus(`${T.statusRunning} ${done}/${total}`, T.statusTip(this.lastResult), true),
				log: (m) => this.log(m),
			});

			await remote.cleanEmptyRemoteFolders();
			this.remoteFilesCache = remote.getFilesCache();
			await this.saveBase(currentLocalDirs);

            const n = (t: Action['type']) => p.actions.filter((a) => a.type === t).length;
			const parts = T.summary(n('upload'), n('download'));
			if (n('trashRemote') + n('trashLocal')) parts.push(T.sumTrashed(n('trashRemote') + n('trashLocal')));
			if (res.conflicts.length) parts.push(T.sumConflicts(res.conflicts.length));
			if (res.errors.length) parts.push(T.sumErrors(res.errors.length));
			if (p.warnings.length) parts.push(`${p.warnings.length} warning(s) (see log)`);
			const hasWarn = p.warnings.length > 0 || res.errors.length > 0;
			this.finish(parts.join(', '), true, res.errors.length > 0, hasWarn);
		} catch (e) {
			if (e instanceof RootMissingError && !opts.dryRun && (await this.askCreateRoot())) again = true;
			else this.finish(T.error(humanError(e)), true, true);
		} finally {
			this.running = false;
			if (again) void this.sync(opts);
			const editSec = Number(this.settings.afterEditSec);
			if (this.editedDuringSync && editSec > 0) {
				window.clearTimeout(this.editTimer);
				this.editTimer = window.setTimeout(() => void this.sync({ quiet: true }), editSec * 1000);
			}
		}
	}

	private filter(l: Map<string, LocalEntry>, r: Map<string, RemoteEntry>): string[] {
		const ex = this.settings.useRawRegex ? parseRawRegex(this.settings.exclude) : globs(this.settings.exclude);
		const localBackupFolder = PathSanitizer.sanitizeLocalBackupFolder(this.settings.localBackupFolder);
		const max = Number(this.settings.maxFileMb) * 1024 * 1024;
		const warnings: string[] = [];

		for (const path of new Set([...l.keys(), ...r.keys()])) {
			const isLocalBackup = path === localBackupFolder || path.startsWith(`${localBackupFolder}/`);
			const isDotFolder = !this.settings.syncDotFolders && path.split('/').some((seg) => seg.startsWith('.'));
			const big = (l.get(path)?.size ?? 0) > max || (r.get(path)?.size ?? 0) > max;

			if (isLocalBackup || isDotFolder || ex.some((g: RegExp) => g.test(path)) || big) {
				l.delete(path);
				r.delete(path);
				if (big) warnings.push(T.tooBig(Number(this.settings.maxFileMb), path));
			}
		}
		return warnings;
	}

private finish(msg: string, notify: boolean, failed = false, hasWarnings = false) {
    this.lastSyncAt = Date.now();
    this.lastResult = `${new Date().toLocaleString()}: ${msg}`;
    this.log(msg);

		this.setStatus(
			failed || hasWarnings ? T.statusError : T.statusOk(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
			T.statusTip(this.lastResult),
		);

		if (failed || hasWarnings) {
			// Center-screen blocking window modal (iOS, Android, Windows, Mac, Linux)
			new AlertModal(this.app, T.noticePrefix, msg).open();
		} else if (notify) {
			// Toast notification for clean syncs
			new Notice(`${T.noticePrefix}: ${msg}`);
		}
	}

	private setStatus(text: string, tip: string, running = false) {
		if (!this.status) return;
		this.status.text.setText(text);
		this.status.el.toggleClass('is-running', running);
		setTooltip(this.status.el, tip, { placement: 'top' });
	}

	log(msg: string) {
		this.logLines.push(`${new Date().toLocaleTimeString()} ${msg}`);
		if (this.logLines.length > 500) this.logLines.shift();
	}

	private sid(key: string): string {
		return `crypt-drive-sync-${this.deviceId()}-${key}`;
	}

	secret(key: string): string {
		const v = this.app.secretStorage.getSecret(this.sid(key));
		if (v !== null) return v;
		const old = this.app.secretStorage.getSecret(`crypt-drive-sync-${key}`) ?? '';
		if (old) this.storeSecret(key, old);
		return old;
	}

	private storeSecret(key: string, value: string) {
		this.app.secretStorage.setSecret(this.sid(key), value);
	}

	async setSecret(key: string, value: string): Promise<void> {
		this.storeSecret(key, value);
		if (key === PASSWORD_ID || key === SALT_ID) await this.resetState();
	}

	async getCrypt(): Promise<Crypt | undefined> {
		const password = this.secret(PASSWORD_ID);
		if (!password) return undefined;
		const salt = this.secret(SALT_ID);
		const key = JSON.stringify([password, salt, this.settings.dirNameEncrypt]);
		if (this.crypt?.key !== key) {
			this.crypt = { key, crypt: await Crypt.create({ password, salt, dirNameEncrypt: this.settings.dirNameEncrypt }) };
		}
		return this.crypt.crypt;
	}

	ready(): boolean {
		return this.hasClient() && this.isLoggedIn() && !!this.secret(PASSWORD_ID);
	}

	hasBuiltinClient(): boolean {
		return !!GOOGLE_CLIENT.id;
	}

	hasClient(): boolean {
		const c = this.client();
		return !!c.id && !!c.secret;
	}

	async setClient(id: string, secret: string): Promise<void> {
		if (id !== this.settings.clientId) {
			this.settings.clientId = id;
			await this.saveData(this.settings);
			this.logout();
		}
		if (secret) this.storeSecret(CLIENT_SECRET_ID, secret);
	}

	async remote(report = true, subsystem: 'vaults' | '_backups' | '_deleted' = 'vaults'): Promise<CryptDriveFs | undefined> {
		const s = this.settings;
		const missing = !this.hasClient()
			? T.needClient
			: !this.isLoggedIn()
				? T.needLogin
				: !this.secret(PASSWORD_ID)
					? T.needPassword
					: '';
		if (missing) {
			if (report) this.finish(T.notConfigured(missing), true);
			return undefined;
		}
		const c = this.client();
		const auth = new GoogleAuth(req, c.id, c.secret, this.secret(TOKEN_ID));
		const crypt = (await this.getCrypt())!;
		const vaultName = PathSanitizer.sanitizeVaultName(s.folder, this.app.vault.getName());
		const remoteSubFolder = `${subsystem}/${vaultName}`;
		return new CryptDriveFs(
			new DriveClient(req, auth),
			crypt,
			{
				rootPath: s.rootPath,
				folder: remoteSubFolder,
				trashDir: s.trashDir,
				createRoot: this.createRoot,
				dirNameEncrypt: s.dirNameEncrypt,
			},
			(encSize: number) => Crypt.decryptedSize(encSize),
			this.pageToken,
			this.remoteFilesCache,
		);
	}

	private client(): { id: string; secret: string } {
		const id = this.settings.clientId.trim();
		return id ? { id, secret: this.secret(CLIENT_SECRET_ID) } : GOOGLE_CLIENT;
	}

	isLoggedIn(): boolean {
		return !!this.secret(TOKEN_ID);
	}

	logout() {
		this.storeSecret(TOKEN_ID, '');
	}

	async login(): Promise<void> {
		const c = this.client();
		if (!this.hasClient()) {
			new Notice(T.noBuiltinClient);
			return;
		}
		const token = await new LoginModal(this.app, c.id, c.secret).ask();
		if (token) {
			this.storeSecret(TOKEN_ID, token);
			new Notice(T.googleConnected);
		}
	}

	private async askCreateRoot(): Promise<boolean> {
		const ok = await new ConfirmModal(this.app, T.rootTitle, T.rootText(this.settings.rootPath), T.create).ask();
		if (ok) this.createRoot = true;
		return ok;
	}

	async probe(): Promise<{ ok: boolean; text: string }> {
		try {
			const remote = await this.remote(false);
			if (!remote) return { ok: false, text: T.probeNeedSetup };
			const { files, warnings } = await remote.list();
			warnings.forEach((w) => this.log(`\u26a0 ${w}`));
			return { ok: true, text: files.size ? T.probeOkFiles(files.size) : T.probeOkEmpty };
		} catch (e) {
			if (e instanceof RootMissingError) return { ok: true, text: T.probeNoRoot(this.settings.rootPath) };
			return { ok: false, text: `\u2717 ${humanError(e)}` };
		}
	}

	async check(): Promise<void> {
		new Notice((await this.probe()).text);
	}

	openWizard(onDone: () => void = () => {}) {
		new SetupWizard(this, onDone).open();
	}

	async forgetDevice(onDone: () => void = () => {}): Promise<void> {
		if (!(await new ConfirmModal(this.app, T.forgetName, T.forgetConfirm, T.forgetButton).ask())) return;
		for (const key of [TOKEN_ID, PASSWORD_ID, SALT_ID, CLIENT_SECRET_ID]) {
			this.storeSecret(key, '');
			this.app.secretStorage.setSecret(`crypt-drive-sync-${key}`, '');
		}
		this.settings = { ...DEFAULTS, folder: this.app.vault.getName() };
		await this.saveData(this.settings);
		await this.resetState();
		this.crypt = undefined;
		this.createRoot = false;
		this.lastResult = T.never;
		onDone();
		this.openWizard(onDone);
	}

	async markWizardDone(): Promise<void> {
		if (this.settings.wizardDone) return;
		this.settings.wizardDone = true;
		await this.saveData(this.settings);
	}

	async setLocation(rootPath: string, folder: string): Promise<void> {
		if (rootPath === this.settings.rootPath && folder === this.settings.folder) return;
		Object.assign(this.settings, { rootPath, folder });
		await this.saveData(this.settings);
		await this.resetState();
	}

	openLog() {
		new TextModal(this.app, T.logTitle, this.logLines.join('\n') || T.logEmpty).open();
	}

	async resetState(notify = false): Promise<void> {
		this.base = new Map();
		this.pageToken = undefined;
		this.remoteFilesCache = new Map();
		await this.saveBase();
		if (notify) new Notice(T.stateReset);
	}

	defaultDeviceName(): string {
		if (Platform.isIosApp) return Platform.isTablet ? 'iPad' : 'iPhone';
		if (Platform.isAndroidApp) return 'Android';
		return Platform.isMacOS ? 'Mac' : Platform.isWin ? 'Windows' : 'Linux';
	}

	private get statePath() {
		return normalizePath(`${this.manifest.dir}/state.json`);
	}

	private deviceId(): string {
		let id = this.app.loadLocalStorage('crypt-drive-sync-device') as string | null;
		if (!id) {
			id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
			this.app.saveLocalStorage('crypt-drive-sync-device', id);
		}
		return id;
	}

	private async loadBase(): Promise<Map<string, BaseEntry>> {
		try {
			const raw = await this.app.vault.adapter.read(this.statePath);
			const st = JSON.parse(raw) as {
				device?: string;
				base?: Record<string, BaseEntry>;
				dirs?: string[];
				pageToken?: string;
				remoteFiles?: Record<string, CachedRemoteFile>;
			};
			if (st.device === this.deviceId()) {
				if (st.dirs) this.baseDirs = new Set(st.dirs);
				if (st.pageToken) this.pageToken = st.pageToken;
				if (st.remoteFiles) this.remoteFilesCache = new Map(Object.entries(st.remoteFiles));
				if (st.base) return new Map(Object.entries(st.base));
			}
		} catch {
			// state file missing or unreadable
		}
		this.baseDirs = new Set();
		this.pageToken = undefined;
		this.remoteFilesCache = new Map();
		return new Map();
	}

	async saveBase(currentDirs?: Set<string>): Promise<void> {
		if (currentDirs) this.baseDirs = currentDirs;
		await this.app.vault.adapter.write(
			this.statePath,
			JSON.stringify(
				{
					device: this.deviceId(),
					base: Object.fromEntries(this.base),
					dirs: Array.from(this.baseDirs),
					pageToken: this.pageToken ?? null,
					remoteFiles: Object.fromEntries(this.remoteFilesCache),
				},
				null,
				2,
			),
		);
	}
}

class VaultFs implements LocalFs {
	private plugin: CryptDriveSync;
	private app: App;
	private real = new Map<string, string>();

	constructor(plugin: CryptDriveSync) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	private path(p: string): string {
		return this.real.get(p) ?? p;
	}

	async listDirs(): Promise<Set<string>> {
		const dirs = new Set<string>();
		const localBackupFolder = PathSanitizer.sanitizeLocalBackupFolder(this.plugin.settings.localBackupFolder);
		const scan = async (dir: string) => {
			const list = await this.app.vault.adapter.list(dir);
			for (const folder of list.folders) {
				const nfc = folder.normalize('NFC');
				const isLocalBackup = nfc === localBackupFolder || nfc.startsWith(`${localBackupFolder}/`);
				const isDotFolder = !this.plugin.settings.syncDotFolders && nfc.split('/').some((seg) => seg.startsWith('.'));
				if (!isLocalBackup && !isDotFolder) {
					dirs.add(nfc);
					await scan(folder);
				}
			}
		};
		await scan('');
		return dirs;
	}

	async list(): Promise<Map<string, LocalEntry>> {
		const out = new Map<string, LocalEntry>();
		this.real.clear();
		if (this.plugin.settings.syncDotFolders) {
			await this.scanAdapter('', out);
		} else {
			for (const f of this.app.vault.getAllLoadedFiles()) if (f.path !== '/') this.real.set(f.path.normalize('NFC'), f.path);
			for (const f of this.app.vault.getFiles()) {
				const e = await this.stat(f.path.normalize('NFC'));
				if (e) out.set(f.path.normalize('NFC'), e);
			}
		}
		return out;
	}

	private async scanAdapter(dir: string, out: Map<string, LocalEntry>): Promise<void> {
		const list = await this.app.vault.adapter.list(dir);
		for (const file of list.files) {
			const nfc = file.normalize('NFC');
			this.real.set(nfc, file);
			const st = await this.stat(nfc);
			if (st) out.set(nfc, st);
		}
		for (const folder of list.folders) {
			await this.scanAdapter(folder, out);
		}
	}

	async stat(path: string): Promise<LocalEntry | undefined> {
		const st = await this.app.vault.adapter.stat(this.path(path));
		return st?.type === 'file' ? { mtime: st.mtime, size: st.size } : undefined;
	}

	private file(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.path(path));
		return f instanceof TFile ? f : null;
	}

	async read(path: string): Promise<Uint8Array> {
		const realPath = this.path(path);
		const f = this.file(path);
		if (f) {
			return new Uint8Array(await this.app.vault.readBinary(f));
		}
		if (await this.app.vault.adapter.exists(realPath)) {
			return new Uint8Array(await this.app.vault.adapter.readBinary(realPath));
		}
		throw new Error(`not on this device: ${path}`);
	}

	async write(path: string, data: Uint8Array, mtime: number): Promise<LocalEntry> {
		const buf = data.slice().buffer;
		const f = this.file(path);
		if (f) {
			await this.app.vault.modifyBinary(f, buf, { mtime });
		} else {
			const realPath = this.path(path);
			const segs = realPath.split('/');
			let dir = '';
			for (let i = 1; i < segs.length; i++) {
				const key = segs.slice(0, i).join('/');
				const real = this.real.get(key) ?? (dir ? `${dir}/${segs[i - 1]!}` : segs[i - 1]!);
				if (!(await this.app.vault.adapter.exists(real))) {
					await this.app.vault.adapter.mkdir(real);
				}
				this.real.set(key, real);
				dir = real;
			}
			await this.app.vault.adapter.writeBinary(realPath, buf, { mtime });
			this.real.set(path, realPath);
		}
		const st = await this.stat(path);
		if (!st) throw new Error(`write failed: ${path}`);
		return st;
	}

	async trash(path: string): Promise<void> {
		const f = this.file(path);
		if (f) await this.app.fileManager.trashFile(f);
	}
}

export function humanError(e: unknown): string {
	const m = e instanceof Error ? e.message : String(e);
	const rules: [RegExp, string][] = [
		[/can't decrypt names/, T.errWrongPassword],
		[/login expired or revoked/, T.errLoginExpired],
		[/access denied/, T.errAccessDenied],
		[/code expired/, T.errCodeExpired],
		[/Google Drive 403/, T.errForbidden],
		[/Google Drive 5\d\d|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_NETWORK|offline|timed out/i, T.errOffline],
	];
	return rules.find(([re]) => re.test(m))?.[1] ?? m;
}

export function globs(text: string): RegExp[] {
	return text
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((g) => {
			const re = g
				.split('')
				.map((c) => (/[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c))
				.join('')
				.replace(/\*\*/g, '.*')
				.replace(/\*/g, '[^/]*')
				.replace(/\?/g, '[^/]');
			return new RegExp(`^${re}(/|$)`);
		});
}

export function parseRawRegex(text: string): RegExp[] {
	return text
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((pattern) => {
			try {
				return new RegExp(pattern);
			} catch {
				return null;
			}
		})
		.filter((r): r is RegExp => r !== null);
}

class AlertModal extends Modal {
	private message: string;

	constructor(app: App, title: string, message: string) {
		super(app);
		this.setTitle(title);
		this.message = message;
	}

	onOpen() {
		const el = this.contentEl;
		el.createEl('p', { text: this.message, cls: 'cds-pre-line' });
		new Setting(el).addButton((b) =>
			b
				.setButtonText(T.close)
				.setCta()
				.onClick(() => this.close()),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class TextModal extends Modal {
	constructor(app: App, title: string, text: string) {
		super(app);
		this.setTitle(title);
		this.contentEl.createEl('pre', { text, cls: 'cds-pre' });
	}
}

class ConfirmModal extends Modal {
	private ok = false;
	private resolve?: (ok: boolean) => void;

	constructor(app: App, title: string, text: string, button: string) {
		super(app);
		this.setTitle(title);
		this.contentEl.createEl('p', { text });
		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText(button)
					.setCta()
					.onClick(() => {
						this.ok = true;
						this.close();
					}),
			)
			.addButton((b) => b.setButtonText(T.cancel).onClick(() => this.close()));
	}

	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onClose() {
		this.resolve?.(this.ok);
	}
}

class PlanModal extends Modal {
	private result = false;
	private resolve?: (ok: boolean) => void;

	constructor(app: App, p: Plan, canApply: boolean) {
		super(app);
		this.setTitle(T.planTitle);
		const el = this.contentEl;
		if (p.blocked) el.createEl('p', { text: T.stopped(p.blocked), cls: 'mod-warning' });
		for (const w of p.warnings) el.createEl('p', { text: `\u26a0 ${w}` });
		if (!p.actions.length) el.createEl('p', { text: T.planNothing });
		for (const type of Object.keys(T.actions) as Action['type'][]) {
			const paths = p.actions.filter((a) => a.type === type).map((a) => a.path);
			if (!paths.length) continue;
			const d = el.createEl('details');
			d.createEl('summary', { text: `${T.actions[type]}: ${paths.length}` });
			d.createEl('pre', {
				text: paths.slice(0, 500).join('\n') + (paths.length > 500 ? `\n${T.more(paths.length - 500)}` : ''),
				cls: 'cds-pre',
			});
		}
		const s = new Setting(el);
		if (canApply && p.actions.length)
			s.addButton((b) =>
				b
					.setButtonText(T.planApply)
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.result = true;
						this.close();
					}),
			);
		s.addButton((b) => b.setButtonText(canApply ? T.cancel : T.close).onClick(() => this.close()));
	}

	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onClose() {
		this.resolve?.(this.result);
	}
}

class LoginModal extends Modal {
	private abort = new AbortController();
	private token = '';
	private resolve?: (token: string) => void;
	private clientId: string;
	private clientSecret: string;

	constructor(app: App, clientId: string, clientSecret: string) {
		super(app);
		this.clientId = clientId;
		this.clientSecret = clientSecret;
		this.setTitle(T.loginTitle);
	}

	ask(): Promise<string> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	async onOpen() {
		const el = this.contentEl;
		const status = el.createEl('p', { text: T.loginGettingCode });
		const code = el.createDiv({ cls: 'cds-code' });
		const buttons = new Setting(el);
		let pasted = '';
		new Setting(el)
			.setName(T.loginPaste)
			.setDesc(T.loginPasteDesc)
			.addText((t) =>
				t.onChange((v) => {
					pasted = v;
				}),
			)
			.addButton((b) =>
				b.setButtonText(T.save).onClick(() => {
					this.token = parseRefreshToken(pasted);
					if (this.token) this.close();
				}),
			);

		try {
			const login = await startDeviceLogin(req, this.clientId);
			status.setText(T.loginYourCode);
			code.setText(login.userCode);
			buttons.addButton((b) =>
				b
					.setButtonText(T.loginButton)
					.setCta()
					.onClick(() => {
						navigator.clipboard.writeText(login.userCode).catch(() => status.setText(T.loginCopyFailed));
						window.open(login.verificationUrl);
						status.setText(T.loginCopied);
					}),
			);
			this.token = await pollDeviceLogin(req, this.clientId, this.clientSecret, login, this.abort.signal);
			this.close();
		} catch (e) {
			if (!this.abort.signal.aborted) status.setText(T.error(humanError(e)));
		}
	}

	onClose() {
		this.abort.abort();
		this.contentEl.empty();
		this.resolve?.(this.token);
	}
}
